import type {
  ProcessAdapter,
  ProcessHandle,
  SpawnConfig,
  SteerOutcome,
  SteerRequest,
} from '@liggi/agent-ui-harness/server';
import { randomUUID } from 'node:crypto';
import { LatticeError } from '../types/index.js';
import { DECISION_ASKED_EVENT, type DecisionAskedData } from '../types/decisions.js';
import { createLogger } from '../services/infrastructure/logger.js';
import { parseJson } from '../utils/json.js';
import { DEFAULT_CODEX_MODEL_ID } from '../constants/codex-models.js';
import { parseAttachmentBlocks } from './attachment-blocks.js';
import { createStdoutQueue } from './stdout-queue.js';
import {
  getCodexAppServerClient,
  isCodexRpcRefusal,
} from '../services/process/codex-app-server-client.js';
import type {
  CodexRequestCoordinator,
  CodexServerRequestContext,
} from '../services/process/codex-request-coordinator.js';
import type {
  CodexErrorNotificationParams,
  CodexRequestId,
  CodexServerNotification,
  CodexServerRequest,
  CodexThreadGoal,
  CodexThreadItem,
  CodexThreadTokenUsage,
  CodexTurn,
  CodexUserInput,
} from '../services/process/codex-app-server-types.js';

export interface CodexHarnessLifecycleEvent {
  sessionId: string;
  type: 'goal:updated' | 'goal:cleared' | 'context:compaction' | 'codex:rateLimits' | 'codex:threadStatus' | 'codex:mcpStatus' | typeof DECISION_ASKED_EVENT;
  data: unknown;
}

/**
 * A setting that a Codex thread or turn was actually started with. Fired only
 * after the app-server accepted it — a parked input carries a choice that has
 * not happened yet, and recording it would make the stored setting a promise
 * rather than a fact.
 */
export interface CodexAppliedSettings {
  sessionId: string;
  model: string;
  reasoningEffort: string;
}

export interface CodexAppServerLike {
  on(event: 'notification', listener: (notification: CodexServerNotification) => void): this;
  on(event: 'request', listener: (request: CodexServerRequest, claim: () => void) => void): this;
  on(event: 'exit', listener: (info: { code: number | null; signal: string | null }) => void): this;
  off(event: 'notification', listener: (notification: CodexServerNotification) => void): this;
  off(event: 'request', listener: (request: CodexServerRequest, claim: () => void) => void): this;
  off(event: 'exit', listener: (info: { code: number | null; signal: string | null }) => void): this;
  respondToServerRequest(id: CodexRequestId, result: unknown): void;
  respondToServerRequestError(id: CodexRequestId, code: number, message: string, data?: unknown): void;
  refreshChatGptAuth(): Promise<unknown>;
  startThread(options: { cwd: string; model: string; reasoningEffort: string }): Promise<{
    thread: { id: string };
    model: string;
    cwd: string;
    reasoningEffort: string | null;
  }>;
  resumeThread(threadId: string, options: { cwd: string; model: string; reasoningEffort: string }): Promise<{
    thread: { id: string };
    model: string;
    cwd: string;
    reasoningEffort: string | null;
  }>;
  startTurn(options: {
    threadId: string;
    input: CodexUserInput[];
    model?: string;
    reasoningEffort: string;
  }): Promise<{ turn: CodexTurn }>;
  steerTurn(options: {
    threadId: string;
    expectedTurnId: string;
    input: CodexUserInput[];
    clientUserMessageId?: string;
  }): Promise<{ turnId: string }>;
  startThreadCompaction(threadId: string): Promise<Record<string, never>>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  setGoal(params: {
    threadId: string;
    objective?: string | null;
    status?: string | null;
    tokenBudget?: number | null;
  }): Promise<{ goal: CodexThreadGoal }>;
}

type CodexClientFactory = (key: string, cwd: string) => CodexAppServerLike;

const logger = createLogger('CodexProcessAdapter');
const DEFAULT_CODEX_MODEL = DEFAULT_CODEX_MODEL_ID;
const DEFAULT_REASONING_EFFORT = 'xhigh';
export const CODEX_NOT_SIGNED_IN_MESSAGE =
  'Codex is not signed in. Sign in from Settings → Providers → Codex, then send again.';

/**
 * `account/read` answers with no account when auth.json is missing or empty.
 * The thread would still start; the first turn would then spend ~15s
 * reconnecting before a 401 lands in the transcript. Refuse up front instead.
 */
function isSignedOut(accountRead: unknown): boolean {
  if (!accountRead || typeof accountRead !== 'object') return false;
  const record = accountRead as { account?: unknown; requiresOpenaiAuth?: unknown };
  return record.requiresOpenaiAuth === true && (record.account === null || record.account === undefined);
}

function argValue(args: readonly string[] | undefined, prefix: string): string | undefined {
  const match = args?.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function stringExtra(config: SpawnConfig, key: string): string | undefined {
  const value = config.extra?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringRecordValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberExtra(config: SpawnConfig, key: string): number | undefined {
  const value = config.extra?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toCodexInput(text: string, rawAttachments?: unknown): CodexUserInput[] {
  const parsed = parseAttachmentBlocks(rawAttachments);
  if (!parsed.ok) throw new Error(parsed.error);

  const input: CodexUserInput[] = [];
  for (const block of parsed.blocks) {
    if (block.type === 'text') {
      input.push({ type: 'text', text: block.text, text_elements: [] });
      continue;
    }
    if (block.type === 'image' && block.source.type === 'base64') {
      input.push({
        type: 'image',
        url: `data:${block.source.media_type};base64,${block.source.data}`,
        detail: null,
      });
      continue;
    }
    if (block.type === 'document') {
      throw new Error('Codex in Lattice supports image and text attachments, but not PDF attachments');
    }
  }

  if (text.trim().length > 0) {
    input.push({ type: 'text', text, text_elements: [] });
  }
  return input;
}

function serializeRawEvent(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

function notificationThreadId(notification: CodexServerNotification): string | undefined {
  const params = notification.params;
  if (!params || typeof params !== 'object') return undefined;
  const threadId = (params as { threadId?: unknown }).threadId;
  return typeof threadId === 'string' ? threadId : undefined;
}

function requestThreadId(request: CodexServerRequest): string | undefined {
  const params = request.params;
  if (!params || typeof params !== 'object') return undefined;
  const record = params as { threadId?: unknown; conversationId?: unknown };
  if (typeof record.threadId === 'string') return record.threadId;
  return typeof record.conversationId === 'string' ? record.conversationId : undefined;
}

function isGlobalNotification(method: string): boolean {
  return method === 'account/rateLimits/updated'
    || method === 'mcpServer/startupStatus/updated'
    || method === 'error';
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * A question Codex asked with `request_user_input_async`, as a decision card.
 * The tool returns at once and Codex keeps its turn open, waiting for the
 * reply to arrive as input steered into that turn, which is how the card's
 * answer is delivered. The question arrives as an `agentMessage` with
 * `delivery: "async"` and `questions: [{ title, options }]`, and nothing else
 * marks the thread as waiting on the user. A thread holds one open decision,
 * so a bundle of several questions stays a plain message, answered by typing.
 */
function asyncQuestionDecision(record: Record<string, unknown>): DecisionAskedData | null {
  if (record.delivery !== 'async' || !Array.isArray(record.questions) || record.questions.length !== 1) return null;
  const asked = record.questions[0] as { title?: unknown; options?: unknown };
  if (typeof asked?.title !== 'string' || !asked.title.trim()) return null;
  const labels = Array.isArray(asked.options) ? asked.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '') : [];
  return {
    id: randomUUID(),
    question: asked.title.trim(),
    options: [...new Set(labels.map((label) => label.trim()))].map((label) => ({ label, consequence: '' })),
  };
}

/**
 * Codex identifies an MCP tool by separate `server` and `tool` fields; Claude emits
 * `mcp__server__tool`. Renderers key off Claude's scheme, so emit that for both — a
 * `MCP:server.tool` name matches no renderer and lands in the generic fallback.
 * Historical events keep the old names, so consumers still need to accept both.
 */
function mcpToolName(record: Record<string, unknown>): string {
  const server = (stringField(record, 'server') ?? 'server').replace(/_{2,}/g, '_');
  const tool = stringField(record, 'tool') ?? 'tool';
  return `mcp__${server}__${tool}`;
}

/** Codex sends the MCP tool input as a JSON string; tool_use.input wants the object. */
function parseMcpArguments(record: Record<string, unknown>): Record<string, unknown> {
  const raw = record.arguments;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = parseJson(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { arguments: parsed };
  } catch {
    return { arguments: raw };
  }
}

/**
 * Pulls the tool's own output out of the protocol envelope. Servers that return a
 * stub `content[]` ("Action completed.") put the real payload in `structuredContent`,
 * so prefer whichever actually carries data.
 */
function mcpResultContent(record: Record<string, unknown>): string | null {
  const result = record.result;
  if (!result || typeof result !== 'object') return null;
  const { content, structuredContent } = result as { content?: unknown; structuredContent?: unknown };

  const text = Array.isArray(content)
    ? content
        .filter((b): b is { type?: string; text?: string } => !!b && typeof b === 'object')
        .map(b => (typeof b.text === 'string' ? b.text : ''))
        .filter(Boolean)
        .join('\n')
    : '';

  const isStub = !text.trim() || /^(action completed\.?|ok\.?|success\.?|done\.?)$/i.test(text.trim());
  if (structuredContent !== undefined && structuredContent !== null && isStub) {
    return typeof structuredContent === 'string' ? structuredContent : JSON.stringify(structuredContent);
  }
  return text || null;
}

/**
 * Turns an `error` notification into the line the transcript shows. Says so
 * plainly when the payload carried no reason, rather than implying the bare
 * placeholder was the provider's own words.
 */
function describeCodexError(params: CodexErrorNotificationParams | undefined): string {
  const raw = params?.error;
  const detail = typeof raw === 'string'
    ? raw
    : raw?.message ?? raw?.additionalDetails ?? null;
  const text = detail?.trim()
    || 'Codex app-server reported an error with no detail (see server log)';
  return params?.willRetry ? `${text} — retrying` : text;
}

export class CodexProcessAdapter implements ProcessAdapter {
  readonly managedStreamingIds = new Set<string>();
  private activeThreadIds = new Set<string>();

  constructor(
    private readonly onLifecycleEvent: (event: CodexHarnessLifecycleEvent) => void,
    private readonly clientFactory: CodexClientFactory = getCodexAppServerClient,
    private readonly requestCoordinator?: CodexRequestCoordinator,
    private readonly onSettingsApplied?: (settings: CodexAppliedSettings) => void,
  ) {}

  hasActiveThread(threadId: string): boolean {
    return this.activeThreadIds.has(threadId);
  }

  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    const cwd = config.cwd ?? process.cwd();
    const workspaceKey = stringExtra(config, 'workspace') ?? cwd;
    const model = argValue(config.args, '--model=') ?? stringExtra(config, 'model') ?? DEFAULT_CODEX_MODEL;
    const reasoningEffort = stringExtra(config, 'reasoningEffort') ?? DEFAULT_REASONING_EFFORT;
    const sessionId = stringExtra(config, 'sessionId');
    if (!sessionId) {
      throw new Error('Codex adapter requires extra.sessionId');
    }
    const resumeThreadId = config.resume && !config.resume.startsWith('pending-')
      ? config.resume
      : undefined;

    const client = this.clientFactory(workspaceKey, cwd);
    const handle = new CodexProcessHandle({
      client,
      cwd,
      sessionId,
      model,
      reasoningEffort,
      initialPrompt: config.prompt,
      initialAttachments: config.extra?.attachments,
      resumeThreadId,
      initialGoal: stringExtra(config, 'goalObjective'),
      initialGoalTokenBudget: numberExtra(config, 'goalTokenBudget'),
      initialCommand: stringExtra(config, 'internalCommand'),
      onLifecycleEvent: this.onLifecycleEvent,
      onServerRequest: this.requestCoordinator
        ? (context) => this.requestCoordinator!.handle(context)
        : undefined,
      onProcessClosed: this.requestCoordinator
        ? (streamingId) => this.requestCoordinator!.cancelForStreamingId(streamingId)
        : undefined,
      onSettingsApplied: this.onSettingsApplied,
      onThreadActive: (threadId, active) => {
        if (active) this.activeThreadIds.add(threadId);
        else this.activeThreadIds.delete(threadId);
      },
    });

    await handle.start();
    this.managedStreamingIds.add(handle.processId!);
    logger.info('Codex process handle started', {
      processId: handle.processId,
      threadId: handle.threadId,
      cwd,
      model,
      reasoningEffort,
      resumed: Boolean(resumeThreadId),
    });
    return handle;
  }
}

interface CodexProcessHandleOptions {
  client: CodexAppServerLike;
  cwd: string;
  sessionId: string;
  model: string;
  reasoningEffort: string;
  initialPrompt: string;
  initialAttachments?: unknown;
  resumeThreadId?: string;
  initialGoal?: string;
  initialGoalTokenBudget?: number;
  initialCommand?: string;
  onLifecycleEvent: (event: CodexHarnessLifecycleEvent) => void;
  onServerRequest?: (context: CodexServerRequestContext) => void;
  onProcessClosed?: (streamingId: string) => void;
  onThreadActive: (threadId: string, active: boolean) => void;
  onSettingsApplied?: (settings: CodexAppliedSettings) => void;
}

interface PendingCodexInput {
  input: CodexUserInput[];
  model?: string;
  reasoningEffort?: string;
}

class CodexProcessHandle implements ProcessHandle {
  readonly stdout = createStdoutQueue();
  readonly pid = undefined;

  private aliveValue = true;
  private exitedResolve!: (value: { code: number; signal?: string }) => void;
  readonly exited = new Promise<{ code: number; signal?: string }>((resolve) => {
    this.exitedResolve = resolve;
  });

  threadId = '';
  processId?: string;
  private activeTurnId: string | null = null;
  private pendingInputs: PendingCodexInput[] = [];
  private currentModel: string;
  private currentReasoningEffort: string;
  private lastTokenUsageByTurn = new Map<string, CodexThreadTokenUsage>();
  private deltaItems = new Set<string>();
  /** MCP items whose arguments were already published on the tool_use. */
  private mcpArgsSeen = new Set<string>();
  private manualCompactionRequested = false;
  private activeCompaction: {
    itemId: string;
    trigger: 'manual' | 'auto';
    startedAtMs: number;
  } | null = null;
  private notificationHandler = (notification: CodexServerNotification): void => {
    this.handleNotification(notification);
  };
  private exitHandler = (info: { code: number | null; signal: string | null }): void => {
    if (!this.aliveValue) return;
    logger.warn('Codex app-server exited under a live thread', {
      threadId: this.threadId,
      turnId: this.activeTurnId,
      code: info.code,
      signal: info.signal,
    });
    if (this.activeTurnId) {
      this.enqueueAssistantText(
        `Codex app-server exited mid-turn (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'})`,
        `codex-error-${Date.now()}`,
      );
      this.enqueueTurnEnd(undefined, 'failed', 'Codex exited mid-turn');
      this.activeTurnId = null;
    }
    this.close();
  };
  private requestHandler = (request: CodexServerRequest, claim: () => void): void => {
    if (requestThreadId(request) !== this.threadId) return;
    claim();
    if (!this.options.onServerRequest) {
      this.options.client.respondToServerRequestError(
        request.id,
        -32601,
        `Lattice does not implement Codex server request ${request.method}`,
      );
      return;
    }
    try {
      this.options.onServerRequest({
        responder: this.options.client,
        request,
        sessionId: this.options.sessionId,
        streamingId: this.processId!,
        threadId: this.threadId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to handle Codex server request', {
        threadId: this.threadId,
        method: request.method,
        error: message,
      });
      this.options.client.respondToServerRequestError(
        request.id,
        -32603,
        `Lattice failed to handle Codex server request ${request.method}: ${message}`,
      );
    }
  };

  constructor(private readonly options: CodexProcessHandleOptions) {
    this.currentModel = options.model;
    this.currentReasoningEffort = options.reasoningEffort;
  }

  get alive(): boolean {
    return this.aliveValue;
  }

  async start(): Promise<void> {
    const accountRead = await this.options.client.refreshChatGptAuth();
    if (isSignedOut(accountRead)) {
      // A LatticeError so the create route answers with this text, not "Internal server error".
      throw new LatticeError('PROVIDER_NOT_SIGNED_IN', CODEX_NOT_SIGNED_IN_MESSAGE, 400);
    }

    const thread = this.options.resumeThreadId
      ? await this.options.client.resumeThread(this.options.resumeThreadId, {
          cwd: this.options.cwd,
          model: this.options.model,
          reasoningEffort: this.options.reasoningEffort,
        })
      : await this.options.client.startThread({
          cwd: this.options.cwd,
          model: this.options.model,
          reasoningEffort: this.options.reasoningEffort,
        });

    this.threadId = thread.thread.id;
    this.currentModel = thread.model;
    this.currentReasoningEffort = thread.reasoningEffort ?? this.options.reasoningEffort;
    this.processId = `codex-${this.threadId}`;
    this.options.onThreadActive(this.threadId, true);
    this.options.client.on('notification', this.notificationHandler);
    this.options.client.on('request', this.requestHandler);
    this.options.client.on('exit', this.exitHandler);

    this.enqueueSystemInit(thread.model, thread.cwd, thread.reasoningEffort);
    this.reportSettingsApplied();

    if (this.options.initialGoal) {
      await this.options.client.setGoal({
        threadId: this.threadId,
        objective: this.options.initialGoal,
        status: 'active',
        tokenBudget: this.options.initialGoalTokenBudget ?? null,
      });
    }

    if (this.options.initialCommand === 'compact') {
      await this.compact();
    } else {
      const initialInput = toCodexInput(
        this.options.initialPrompt,
        this.options.initialAttachments,
      );
      if (initialInput.length > 0) {
        await this.startTurn({ input: initialInput });
      }
    }
  }

  async compact(): Promise<void> {
    if (!this.aliveValue) throw new Error('Codex thread is not active');
    if (this.activeTurnId || this.manualCompactionRequested || this.activeCompaction) {
      throw new Error('Cannot compact during an active Codex turn');
    }

    this.manualCompactionRequested = true;
    try {
      await this.options.client.startThreadCompaction(this.threadId);
    } catch (error) {
      this.manualCompactionRequested = false;
      void this.flushNextInput();
      throw error;
    }
  }

  write(input: string, extra?: Record<string, unknown>): void {
    const text = input.endsWith('\n') ? input.slice(0, -1) : input;
    if (!this.aliveValue) return;

    // Conversion is synchronous so malformed or unsupported attachments throw
    // through SessionManager.send() and become a visible HTTP error.
    const codexInput = toCodexInput(text, extra?.attachments);
    if (codexInput.length === 0) return;

    this.startTurn({
      input: codexInput,
      model: stringRecordValue(extra, 'model'),
      reasoningEffort: stringRecordValue(extra, 'reasoningEffort'),
    }).catch((err) => {
      logger.warn('Codex write failed', {
        threadId: this.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Deliver into the running turn via `turn/steer`.
   *
   * Acceptance here is stronger than Claude's: the app-server takes the input
   * only when `expectedTurnId` is the turn actually running, and answers with
   * the turn it joined. So a response that names our turn is already proof of
   * mid-turn incorporation, and the `incorporated` stage fires immediately
   * rather than waiting for a later frame.
   *
   * Everything that is not an app-server error response is `uncertain`. The
   * input may have reached the turn and been acknowledged into a socket that
   * then died; the caller keeps it reserved rather than sending it twice.
   */
  async steer(request: SteerRequest): Promise<SteerOutcome> {
    if (!this.aliveValue) return { status: 'rejected', reason: 'Codex thread is not active' };
    const turnId = this.activeTurnId;
    if (!turnId) return { status: 'rejected', reason: 'Codex has no active turn to steer' };
    if (this.manualCompactionRequested || this.activeCompaction) {
      return { status: 'rejected', reason: 'Codex is compacting' };
    }

    const text = request.input.endsWith('\n') ? request.input.slice(0, -1) : request.input;
    let codexInput: CodexUserInput[];
    try {
      codexInput = toCodexInput(text, request.extra?.attachments);
    } catch (err) {
      return { status: 'rejected', reason: err instanceof Error ? err.message : String(err) };
    }
    if (codexInput.length === 0) return { status: 'rejected', reason: 'Nothing to steer with' };

    // Past this line the request is on its way to the app-server, so a
    // caller that dies can no longer assume the input never arrived.
    request.onStage?.({ kind: 'handed-over' });

    try {
      const response = await this.options.client.steerTurn({
        threadId: this.threadId,
        expectedTurnId: turnId,
        input: codexInput,
        clientUserMessageId: request.deliveryId,
      });
      if (response.turnId !== turnId) {
        // The contract says this cannot happen; if it ever does, the input
        // went somewhere we did not aim it, and saying "accepted" would put
        // the wrong turn's name on the receipt.
        return {
          status: 'uncertain',
          reason: `turn/steer answered with turn ${response.turnId}, not the ${turnId} it was sent for`,
        };
      }
      const detail = { turnId, clientUserMessageId: request.deliveryId };
      request.onStage?.({ kind: 'accepted', late: false, detail });
      request.onStage?.({
        kind: 'incorporated',
        where: 'mid-turn',
        evidence: `turn/steer accepted on the running turn ${turnId}`,
      });
      return { status: 'accepted', detail };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return isCodexRpcRefusal(err)
        ? { status: 'rejected', reason }
        : { status: 'uncertain', reason };
    }
  }

  signal(sig: NodeJS.Signals): void {
    if (!this.aliveValue) return;

    if (sig === 'SIGINT') {
      if (!this.activeTurnId) return;
      this.options.client.interruptTurn(this.threadId, this.activeTurnId).catch((err) => {
        logger.warn('Codex turn interrupt failed', {
          threadId: this.threadId,
          turnId: this.activeTurnId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }

    this.close(sig);
  }

  private async startTurn(pending: PendingCodexInput): Promise<void> {
    if (this.activeTurnId || this.manualCompactionRequested || this.activeCompaction) {
      this.pendingInputs.push(pending);
      return;
    }

    const model = pending.model ?? this.currentModel;
    const reasoningEffort = pending.reasoningEffort ?? this.currentReasoningEffort;
    try {
      const response = await this.options.client.startTurn({
        threadId: this.threadId,
        input: pending.input,
        model,
        reasoningEffort,
      });
      // Codex turn overrides are sticky for subsequent turns. Mirror the
      // app-server state so later sends without overrides keep the choice.
      this.currentModel = model;
      this.currentReasoningEffort = reasoningEffort;
      this.activeTurnId = response.turn.id;
      this.reportSettingsApplied();
    } catch (err) {
      const failure = `Codex turn failed to start: ${err instanceof Error ? err.message : String(err)}`;
      this.enqueueAssistantText(failure, `codex-error-${Date.now()}`);
      this.enqueueTurnEnd(undefined, 'failed', failure);
      throw err;
    }
  }

  private handleNotification(notification: CodexServerNotification): void {
    const threadId = notificationThreadId(notification);
    if (threadId && threadId !== this.threadId) return;
    if (!threadId && !isGlobalNotification(notification.method)) return;

    switch (notification.method) {
      case 'turn/started': {
        const params = notification.params as { turn: CodexTurn };
        this.activeTurnId = params.turn.id;
        break;
      }
      case 'item/started': {
        const params = notification.params as { item: CodexThreadItem; startedAtMs: number };
        this.handleItemStarted(params.item, params.startedAtMs);
        break;
      }
      case 'item/agentMessage/delta': {
        const params = notification.params as { itemId: string; delta: string };
        this.deltaItems.add(params.itemId);
        this.enqueueAssistantText(
          params.delta,
          `codex-${params.itemId}`,
        );
        break;
      }
      case 'item/completed': {
        const params = notification.params as { item: CodexThreadItem; completedAtMs: number };
        this.handleItemCompleted(params.item, params.completedAtMs);
        break;
      }
      case 'thread/goal/updated': {
        const params = notification.params as { goal: CodexThreadGoal };
        this.options.onLifecycleEvent({
          sessionId: this.sessionId,
          type: 'goal:updated',
          data: { goal: params.goal },
        });
        break;
      }
      case 'thread/goal/cleared': {
        const params = notification.params as { threadId: string };
        this.options.onLifecycleEvent({
          sessionId: this.sessionId,
          type: 'goal:cleared',
          data: { threadId: params.threadId },
        });
        break;
      }
      case 'thread/tokenUsage/updated': {
        const params = notification.params as { turnId: string; tokenUsage: CodexThreadTokenUsage };
        this.lastTokenUsageByTurn.set(params.turnId, params.tokenUsage);
        logger.debug('Codex token usage', {
          threadId: this.threadId,
          turnId: params.turnId,
          activeTurnId: this.activeTurnId,
          last: params.tokenUsage?.last ?? null,
          total: params.tokenUsage?.total ?? null,
        });
        break;
      }
      case 'thread/status/changed': {
        this.options.onLifecycleEvent({
          sessionId: this.sessionId,
          type: 'codex:threadStatus',
          data: notification.params,
        });
        break;
      }
      case 'account/rateLimits/updated': {
        this.options.onLifecycleEvent({
          sessionId: this.sessionId,
          type: 'codex:rateLimits',
          data: notification.params,
        });
        break;
      }
      case 'mcpServer/startupStatus/updated': {
        this.options.onLifecycleEvent({
          sessionId: this.sessionId,
          type: 'codex:mcpStatus',
          data: notification.params,
        });
        break;
      }
      case 'turn/completed': {
        const params = notification.params as { turn: CodexTurn };
        const turn = params.turn;
        if ((this.activeCompaction || this.manualCompactionRequested)
          && (turn.status === 'failed' || turn.status === 'interrupted')) {
          this.options.onLifecycleEvent({
            sessionId: this.sessionId,
            type: 'context:compaction',
            data: {
              phase: 'failed',
              error: turn.error?.message ?? turn.error?.additionalDetails ?? `Codex compaction ${turn.status}`,
            },
          });
          this.activeCompaction = null;
          this.manualCompactionRequested = false;
        }
        this.enqueueTurnEnd(turn, turn.status ?? undefined);
        this.activeTurnId = null;
        void this.flushNextInput();
        break;
      }
      case 'error': {
        const params = notification.params as CodexErrorNotificationParams;
        // Log the payload whole: the rendered line can only say what the shape
        // exposes, and every past occurrence lost the reason entirely.
        logger.error('Codex app-server error', {
          threadId: this.threadId,
          turnId: params?.turnId ?? null,
          willRetry: params?.willRetry ?? null,
          error: params?.error ?? null,
        });
        this.enqueueAssistantText(
          describeCodexError(params),
          `codex-error-${Date.now()}`,
        );
        break;
      }
      default:
        break;
    }
  }

  private get sessionId(): string {
    return this.options.sessionId;
  }

  private async flushNextInput(): Promise<void> {
    const next = this.pendingInputs.shift();
    if (!next) return;
    // startTurn has already put the failure in the thread before rethrowing;
    // nobody awaits a flush, so an escaping rejection would only surface as
    // an unhandled one.
    await this.startTurn(next).catch((err) => {
      logger.warn('Parked Codex input failed to start a turn', {
        threadId: this.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Tell the server what this thread is now running at, so a later process
   * replacement resumes on the same setting instead of a route default. Never
   * fatal: a failed write costs the next restart its effort, not this turn.
   */
  private reportSettingsApplied(): void {
    if (!this.options.onSettingsApplied) return;
    try {
      this.options.onSettingsApplied({
        sessionId: this.options.sessionId,
        model: this.currentModel,
        reasoningEffort: this.currentReasoningEffort,
      });
    } catch (err) {
      logger.warn('Failed to report applied Codex settings', {
        threadId: this.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private enqueueSystemInit(model: string, cwd: string, reasoningEffort: string | null): void {
    this.stdout.push(serializeRawEvent({
      type: 'system',
      subtype: 'init',
      session_id: this.threadId,
      cwd,
      tools: [],
      mcp_servers: [],
      model,
      permissionMode: 'codex-bypass',
      apiKeySource: 'chatgpt',
      provider: 'codex',
      reasoningEffort,
    }));
  }

  private enqueueAssistantText(text: string, messageId: string): void {
    if (!text) return;
    this.stdout.push(serializeRawEvent({
      type: 'assistant',
      session_id: this.threadId,
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        model: this.currentModel,
      },
      provider: 'codex',
    }));
  }

  private enqueueToolUse(id: string, name: string, input: Record<string, unknown>): void {
    this.stdout.push(serializeRawEvent({
      type: 'assistant',
      session_id: this.threadId,
      message: {
        id: `codex-tool-${id}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
      provider: 'codex',
    }));
  }

  private enqueueToolResult(id: string, content: string, isError: boolean): void {
    this.stdout.push(serializeRawEvent({
      type: 'user',
      session_id: this.threadId,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: id,
          content,
          ...(isError ? { is_error: true } : {}),
        }],
      },
      provider: 'codex',
    }));
  }

  private enqueueTurnEnd(turn: CodexTurn | undefined, fallbackStatus?: string, failure?: string): void {
    const turnId = turn?.id ?? this.activeTurnId ?? undefined;
    const usage = turnId ? this.lastTokenUsageByTurn.get(turnId)?.last : undefined;
    if (!usage) {
      // The context gauge and auto-compaction read this; a turn without it
      // shows as zero. Log which id was looked up so a mismatch is visible.
      logger.warn('Codex turn ended without token usage', {
        threadId: this.threadId,
        turnId: turnId ?? null,
        knownTurnIds: [...this.lastTokenUsageByTurn.keys()].slice(-3),
      });
    }
    this.stdout.push(serializeRawEvent({
      type: 'result',
      subtype: fallbackStatus === 'failed' ? 'error_max_turns' : 'success',
      is_error: fallbackStatus === 'failed',
      ...(fallbackStatus === 'failed'
        ? { result: failure ?? turn?.error?.message ?? turn?.error?.additionalDetails ?? 'Codex turn failed' }
        : {}),
      duration_ms: turn?.durationMs ?? 0,
      duration_api_ms: turn?.durationMs ?? 0,
      num_turns: 1,
      session_id: this.threadId,
      // Codex's inputTokens is the whole prompt, cached part included; the
      // harness convention (see cost-tracker.ts) is that input_tokens is the
      // uncached remainder and the three input fields sum to the context size.
      // Reporting the whole prompt here double-counted the cache everywhere
      // that sums them (composer gauge, session show usage line).
      usage: usage
        ? {
            input_tokens: Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)),
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: usage.cachedInputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            server_tool_use: { web_search_requests: 0 },
          }
        : undefined,
      provider: 'codex',
    }));
  }

  private handleItemStarted(item: CodexThreadItem, startedAtMs = Date.now()): void {
    const record = item as Record<string, unknown>;
    const id = stringField(record, 'id');
    if (!id) return;

    if (item.type === 'contextCompaction') {
      this.activeCompaction = {
        itemId: id,
        trigger: this.manualCompactionRequested ? 'manual' : 'auto',
        startedAtMs,
      };
      this.options.onLifecycleEvent({
        sessionId: this.sessionId,
        type: 'context:compaction',
        data: { phase: 'started' },
      });
      return;
    }

    if (item.type === 'commandExecution') {
      this.enqueueToolUse(id, 'Bash', {
        command: stringField(record, 'command') ?? '',
        cwd: stringField(record, 'cwd') ?? this.options.cwd,
        provider: 'codex',
      });
      return;
    }
    if (item.type === 'fileChange') {
      this.enqueueToolUse(id, 'ApplyPatch', {
        changes: Array.isArray(record.changes) ? record.changes : [],
        cwd: this.options.cwd,
        provider: 'codex',
      });
      return;
    }
    if (item.type === 'mcpToolCall') {
      const args = parseMcpArguments(record);
      // The result envelope is the only other place the arguments appear. Keep it
      // whole when they were missing here, so the card can still show what was called.
      if (Object.keys(args).length > 0) this.mcpArgsSeen.add(id);
      this.enqueueToolUse(id, mcpToolName(record), args);
      return;
    }
    if (item.type === 'dynamicToolCall') {
      this.enqueueToolUse(id, stringField(record, 'tool') ?? 'DynamicTool', {
        namespace: stringField(record, 'namespace') ?? null,
      });
    }
  }

  private handleItemCompleted(item: CodexThreadItem, completedAtMs = Date.now()): void {
    const record = item as Record<string, unknown>;
    const id = stringField(record, 'id');
    if (!id) return;

    if (item.type === 'contextCompaction') {
      const compaction = this.activeCompaction?.itemId === id
        ? this.activeCompaction
        : {
            itemId: id,
            trigger: this.manualCompactionRequested ? 'manual' as const : 'auto' as const,
            startedAtMs: completedAtMs,
          };
      const durationMs = Math.max(0, completedAtMs - compaction.startedAtMs);
      this.options.onLifecycleEvent({
        sessionId: this.sessionId,
        type: 'context:compaction',
        data: { phase: 'completed', result: 'success' },
      });
      this.stdout.push(serializeRawEvent({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: this.threadId,
        compact_metadata: {
          trigger: compaction.trigger,
          duration_ms: durationMs,
        },
        provider: 'codex',
      }));
      this.activeCompaction = null;
      this.manualCompactionRequested = false;
      // startTurn parks input while compaction holds the thread. Manual
      // compaction has no turn/completed to piggyback on, so without this the
      // parked message sits until some later turn ends and then arrives out of
      // order.
      void this.flushNextInput();
      return;
    }

    if (item.type === 'agentMessage') {
      const decision = asyncQuestionDecision(record);
      if (decision) {
        // The message is Codex's own rendering of the question; the card replaces it.
        this.options.onLifecycleEvent({ sessionId: this.sessionId, type: DECISION_ASKED_EVENT, data: decision });
        return;
      }
      const text = stringField(record, 'text');
      if (!this.deltaItems.has(id) && text) {
        this.enqueueAssistantText(text, `codex-${id}`);
      }
      return;
    }
    if (item.type === 'reasoning') {
      const text = [
        ...stringArrayField(record, 'summary'),
        ...stringArrayField(record, 'content'),
      ].join('\n');
      if (text) {
        this.stdout.push(serializeRawEvent({
          type: 'assistant',
          session_id: this.threadId,
          message: {
            id: `codex-reasoning-${id}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: text }],
          },
          provider: 'codex',
        }));
      }
      return;
    }
    if (item.type === 'commandExecution') {
      const exitCode = numberField(record, 'exitCode');
      this.enqueueToolResult(
        id,
        stringField(record, 'aggregatedOutput') ?? '',
        stringField(record, 'status') === 'failed' || (typeof exitCode === 'number' && exitCode !== 0),
      );
      return;
    }
    if (item.type === 'fileChange') {
      const failed = stringField(record, 'status') === 'failed';
      const changes = Array.isArray(record.changes) ? record.changes : [];
      this.enqueueToolResult(
        id,
        failed ? 'Patch failed' : `Applied ${changes.length} file change${changes.length === 1 ? '' : 's'}`,
        failed,
      );
      return;
    }
    if (item.type === 'mcpToolCall') {
      const hadArgs = this.mcpArgsSeen.delete(id);
      const payload = hadArgs ? mcpResultContent(record) : null;
      this.enqueueToolResult(
        id,
        payload ?? JSON.stringify(item),
        Boolean(record.error) || stringField(record, 'status') === 'failed',
      );
      return;
    }
    if (item.type === 'dynamicToolCall') {
      this.enqueueToolResult(id, JSON.stringify(item), record.success === false);
    }
  }

  private close(signal?: string): void {
    if (!this.aliveValue) return;
    this.aliveValue = false;
    this.options.client.off('notification', this.notificationHandler);
    this.options.client.off('request', this.requestHandler);
    this.options.client.off('exit', this.exitHandler);
    if (this.processId) {
      this.options.onProcessClosed?.(this.processId);
    }
    if (this.threadId) {
      this.options.onThreadActive(this.threadId, false);
    }
    this.stdout.terminate();
    this.exitedResolve({ code: signal ? 1 : 0, signal });
  }
}
