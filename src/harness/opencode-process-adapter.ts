/**
 * opencode provider adapter.
 *
 * opencode runs as a headless HTTP server that owns sessions and streams their
 * activity over SSE. This adapter creates one session per Lattice conversation,
 * subscribes to that session's event stream, and translates opencode's events
 * into the Claude-CLI-shaped JSONL the harness consumes.
 *
 * Event mapping (opencode -> emitted line):
 *   step.started      -> system/init, once per session
 *   reasoning.ended   -> assistant thinking block
 *   tool.called       -> assistant tool_use
 *   tool.success      -> user tool_result
 *   tool.failed       -> user tool_result with is_error
 *   text.ended        -> assistant text
 *   step.ended (stop) -> result, with usage accumulated across the turn's steps
 *
 * opencode reports usage per step rather than per turn, so a turn's totals are
 * summed as its steps complete and flushed when a step finishes with "stop".
 */

import type { ProcessAdapter, ProcessHandle, SpawnConfig } from '@liggi/agent-ui-harness/server';
import { Agent } from 'undici';
import { createLogger } from '../services/infrastructure/logger.js';
import { parseJson } from '../utils/json.js';
import { createStdoutQueue } from './stdout-queue.js';
import { getOpencodeServer } from './opencode-server.js';

const logger = createLogger('OpencodeAdapter');

/** Model used when neither the spawn config nor the environment names one. */
const FALLBACK_MODEL = process.env.LATTICE_OPENCODE_MODEL ?? '';

const LIVENESS_POLL_MS = 3_000;

/**
 * The event stream is long-lived and legitimately silent for minutes while the
 * model works. Node's fetch defaults to a 300s body-inactivity timeout, which
 * killed real turns mid-flight — a quiet stream is not a dead one, so both
 * timeouts are disabled here and liveness is judged by `/api/session/active`.
 */
const SSE_DISPATCHER = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

/** Cap on reconnects for a single turn, so a genuinely broken stream ends. */
const MAX_STREAM_RECONNECTS = 20;

/**
 * How many consecutive not-running polls to tolerate before a turn that never
 * started is declared dead. Covers the gap between the prompt being accepted
 * and the server registering the session as running.
 */
const NEVER_RUNNING_GRACE_POLLS = 4;

interface ModelRef {
  providerID: string;
  id: string;
}

/**
 * Split a Lattice model string into opencode's provider/model pair.
 *
 * Only the first segment is the provider — model ids themselves contain
 * slashes ("openrouter/stealth/ox-alpha" is provider "openrouter",
 * model "stealth/ox-alpha").
 */
function parseModelRef(model: string | undefined): ModelRef | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function argValue(args: readonly string[] | undefined, prefix: string): string | undefined {
  const hit = args?.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function stringExtra(config: SpawnConfig, key: string): string | undefined {
  const value = config.extra?.[key];
  return typeof value === 'string' ? value : undefined;
}

function serialize(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

/**
 * Unwrap one entry of an opencode tool result's `content` array.
 *
 * Entries are usually `{ type: 'text', text }`; anything else is kept as JSON
 * so no output is silently dropped.
 */
function contentPartText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object') {
    const text = (part as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  return JSON.stringify(part);
}

/** Flatten an opencode tool result into the string the harness renders. */
function toolResultText(data: Record<string, unknown>): string {
  const content = data.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length > 0) {
    return content.map(contentPartText).join('\n');
  }

  const structured = data.structured;
  if (structured && typeof structured === 'object') {
    const inner = (structured as Record<string, unknown>).content;
    if (typeof inner === 'string') return inner;
    if (Array.isArray(inner) && inner.length > 0) {
      return inner.map(contentPartText).join('\n');
    }
  }

  // A tool that produced no textual output still needs a result block, or the
  // preceding tool_use renders as permanently pending.
  return structured ? JSON.stringify(structured) : '';
}

interface OpencodeTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO_TOKENS: OpencodeTokens = {
  input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
};

function addTokens(acc: OpencodeTokens, raw: unknown): OpencodeTokens {
  if (!raw || typeof raw !== 'object') return acc;
  const t = raw as Record<string, unknown>;
  const cache = (t.cache ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    input: acc.input + num(t.input),
    output: acc.output + num(t.output),
    reasoning: acc.reasoning + num(t.reasoning),
    cacheRead: acc.cacheRead + num(cache.read),
    cacheWrite: acc.cacheWrite + num(cache.write),
  };
}

export class OpencodeProcessAdapter implements ProcessAdapter {
  readonly managedStreamingIds = new Set<string>();
  private readonly activeSessionIds = new Set<string>();

  hasActiveSession(sessionId: string): boolean {
    return this.activeSessionIds.has(sessionId);
  }

  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    const cwd = config.cwd ?? process.cwd();
    const conversationId = stringExtra(config, 'sessionId');
    if (!conversationId) {
      throw new Error('opencode adapter requires extra.sessionId');
    }

    const model = argValue(config.args, '--model=')
      ?? stringExtra(config, 'model')
      ?? FALLBACK_MODEL;
    const modelRef = parseModelRef(model);
    if (model && !modelRef) {
      throw new Error(`opencode model must be "provider/model", got "${model}"`);
    }

    const server = await getOpencodeServer();
    const resumeSessionId = config.resume && !config.resume.startsWith('pending-')
      ? config.resume
      : undefined;

    const handle = new OpencodeProcessHandle({
      baseUrl: server.baseUrl,
      cwd,
      conversationId,
      modelRef,
      initialPrompt: config.prompt,
      resumeSessionId,
      onSessionActive: (id, active) => {
        if (active) this.activeSessionIds.add(id);
        else this.activeSessionIds.delete(id);
      },
    });

    await handle.start();
    this.managedStreamingIds.add(handle.processId!);
    logger.info('opencode session started', {
      processId: handle.processId,
      opencodeSessionId: handle.opencodeSessionId,
      cwd,
      model: model || '(server default)',
      resumed: Boolean(resumeSessionId),
    });
    return handle;
  }
}

interface OpencodeProcessHandleOptions {
  baseUrl: string;
  cwd: string;
  conversationId: string;
  modelRef?: ModelRef;
  initialPrompt: string;
  resumeSessionId?: string;
  onSessionActive: (sessionId: string, active: boolean) => void;
}

class OpencodeProcessHandle implements ProcessHandle {
  readonly stdout = createStdoutQueue();
  readonly pid = undefined;

  private aliveValue = true;
  private exitedResolve!: (value: { code: number; signal?: string }) => void;
  readonly exited = new Promise<{ code: number; signal?: string }>((resolve) => {
    this.exitedResolve = resolve;
  });

  opencodeSessionId = '';
  processId?: string;

  private abort = new AbortController();
  private sentInit = false;
  private turnTokens: OpencodeTokens = { ...ZERO_TOKENS };
  private turnStartedAt = 0;

  /** Last event id seen, used to resume the stream after a reconnect. */
  private lastEventId?: string;
  /** True between sending a prompt and emitting that turn's result. */
  private awaitingResult = false;
  /** Whether opencode itself reported the turn finished (stop/failed). */
  private serverTurnEnded = false;
  /** Whether the server has ever reported this session as running this turn. */
  private sawRunning = false;
  private livenessTimer?: NodeJS.Timeout;

  constructor(private readonly options: OpencodeProcessHandleOptions) {}

  get alive(): boolean {
    return this.aliveValue;
  }

  async start(): Promise<void> {
    this.opencodeSessionId = this.options.resumeSessionId
      ?? await this.createSession();
    this.processId = `opencode-${this.opencodeSessionId}`;
    this.options.onSessionActive(this.opencodeSessionId, true);

    // Subscribe before prompting so the turn's first events cannot be missed.
    void this.consumeEvents();
    await this.sendPrompt(this.options.initialPrompt);
  }

  write(input: string): void {
    void this.sendPrompt(input).catch((err: unknown) => {
      logger.error('opencode prompt failed', { error: String(err) });
      this.emitResult(true, 'error_during_execution');
    });
  }

  async compact(): Promise<void> {
    await this.post(`/api/session/${this.opencodeSessionId}/compact`, {});
  }

  signal(_sig: NodeJS.Signals): void {
    void this.post(`/api/session/${this.opencodeSessionId}/interrupt`, {})
      .catch((err: unknown) => logger.warn('opencode interrupt failed', { error: String(err) }));
  }

  private async createSession(): Promise<string> {
    const body: Record<string, unknown> = {
      location: { directory: this.options.cwd },
    };
    if (this.options.modelRef) body.model = this.options.modelRef;
    const data = await this.post('/api/session', body);
    const id = (data as Record<string, unknown> | undefined)?.id;
    if (typeof id !== 'string') {
      throw new Error('opencode session create returned no id');
    }
    return id;
  }

  private async sendPrompt(text: string): Promise<void> {
    this.turnStartedAt = Date.now();
    this.turnTokens = { ...ZERO_TOKENS };
    this.awaitingResult = true;
    this.sawRunning = false;
    this.serverTurnEnded = false;
    await this.post(`/api/session/${this.opencodeSessionId}/prompt`, {
      prompt: { text },
    });
    this.startLivenessWatch();
  }

  /**
   * Watch the server's own liveness state for this session.
   *
   * opencode can abandon a turn without emitting anything on the session
   * stream — a model that fails to resolve is logged as "Failed to drain
   * Session" and never reaches any client (reproduced on 1.18.15 and 1.18.20).
   * Without this, the harness waits on a result that will never arrive and the
   * session shows as working forever.
   *
   * This polls state rather than running a timer, so a genuinely slow turn
   * stays `running` and is never cut short.
   */
  private startLivenessWatch(): void {
    clearInterval(this.livenessTimer);
    let missedWhileNeverRunning = 0;
    this.livenessTimer = setInterval(() => {
      if (!this.awaitingResult) {
        clearInterval(this.livenessTimer);
        return;
      }
      void this.isRunning().then((running) => {
        if (!this.awaitingResult) return;
        if (running) {
          this.sawRunning = true;
          missedWhileNeverRunning = 0;
          return;
        }
        // Ran and then stopped without a result, or never started at all.
        if (!this.sawRunning && ++missedWhileNeverRunning < NEVER_RUNNING_GRACE_POLLS) return;
        logger.error('opencode abandoned a turn without reporting it', {
          opencodeSessionId: this.opencodeSessionId,
          everStarted: this.sawRunning,
        });
        this.emitResult(true, 'error_during_execution');
      });
    }, LIVENESS_POLL_MS);
  }

  private async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.options.baseUrl}/api/session/active`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return true; // Inconclusive — do not declare the turn dead.
      const json = await res.json() as { data?: Record<string, unknown> };
      return Boolean(json?.data?.[this.opencodeSessionId]);
    } catch {
      return true; // Same: a failed probe is not evidence of a dead turn.
    }
  }

  /** POST JSON and unwrap opencode's `{ data: ... }` envelope. */
  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.options.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      throw new Error(`opencode ${path} -> HTTP ${res.status}: ${await res.text()}`);
    }
    const json = await res.json() as { data?: unknown };
    return json?.data;
  }

  /**
   * Consume the session event stream, reconnecting if it drops.
   *
   * A dropped connection is not evidence the turn died — only
   * `/api/session/active` is. Reconnects resume from the last event id via
   * `?after=`, so nothing is missed across the gap.
   */
  private async consumeEvents(): Promise<void> {
    for (let attempt = 0; attempt <= MAX_STREAM_RECONNECTS; attempt++) {
      try {
        await this.readStreamOnce();
        // Clean end of stream. If the turn is still live, reconnect; otherwise
        // the session is genuinely finished.
        if (!this.awaitingResult || this.abort.signal.aborted) {
          this.close(0);
          return;
        }
      } catch (err) {
        if (this.abort.signal.aborted) return;
        logger.warn('opencode event stream dropped; will check liveness', {
          opencodeSessionId: this.opencodeSessionId,
          attempt,
          error: String(err),
        });
      }

      if (this.abort.signal.aborted) return;
      if (!this.awaitingResult) {
        this.close(0);
        return;
      }
      if (!(await this.isRunning())) {
        // Stream gone and the server says the turn is not running — really dead.
        logger.error('opencode event stream ended and the turn is not running', {
          opencodeSessionId: this.opencodeSessionId,
        });
        this.emitResult(true, 'error_during_execution');
        this.close(1);
        return;
      }
    }

    logger.error('opencode event stream exceeded reconnect budget', {
      opencodeSessionId: this.opencodeSessionId,
      maxReconnects: MAX_STREAM_RECONNECTS,
    });
    this.emitResult(true, 'error_during_execution');
    this.close(1);
  }

  /** One connection's worth of stream. Returns when the server closes it. */
  private async readStreamOnce(): Promise<void> {
    const base = `${this.options.baseUrl}/api/session/${this.opencodeSessionId}/event`;
    const url = this.lastEventId
      ? `${base}?after=${encodeURIComponent(this.lastEventId)}`
      : base;

    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: this.abort.signal,
      // @ts-expect-error -- undici-specific option, not in the DOM fetch types.
      dispatcher: SSE_DISPATCHER,
    });
    if (!res.ok || !res.body) {
      throw new Error(`opencode event stream -> HTTP ${res.status}`);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      // SSE frames are separated by a blank line.
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        this.handleFrame(frame);
        split = buffer.indexOf('\n\n');
      }
    }
  }

  private handleFrame(frame: string): void {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let parsed: unknown;
      try {
        parsed = parseJson(payload);
      } catch {
        logger.warn('opencode emitted an unparseable event frame');
        continue;
      }
      if (parsed && typeof parsed === 'object') {
        this.handleEvent(parsed as Record<string, unknown>);
      }
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === 'string' ? event.type : '';
    const data = (event.data ?? {}) as Record<string, unknown>;
    // Cursor for resuming after a dropped connection.
    if (typeof event.id === 'string') this.lastEventId = event.id;

    switch (type) {
      case 'session.next.step.started': {
        if (!this.sentInit) {
          const model = data.model as Record<string, unknown> | undefined;
          const label = model
            ? `${String(model.providerID)}/${String(model.id)}`
            : 'unknown';
          this.emitInit(label);
          this.sentInit = true;
        }
        break;
      }

      case 'session.next.reasoning.ended':
        this.emitThinking(String(data.text ?? ''));
        break;

      case 'session.next.text.ended':
        this.emitText(String(data.text ?? ''), String(data.textID ?? 'text'));
        break;

      case 'session.next.tool.called':
        this.emitToolUse(
          String(data.callID ?? ''),
          String(data.tool ?? 'unknown'),
          (data.input ?? {}) as Record<string, unknown>,
        );
        break;

      case 'session.next.tool.success':
        this.emitToolResult(String(data.callID ?? ''), toolResultText(data), false);
        break;

      case 'session.next.tool.failed':
        this.emitToolResult(
          String(data.callID ?? ''),
          String(data.error ?? toolResultText(data) ?? 'tool failed'),
          true,
        );
        break;

      case 'session.next.step.ended': {
        this.turnTokens = addTokens(this.turnTokens, data.tokens);
        // "tool-calls" means the model is continuing; only "stop" ends a turn.
        if (data.finish === 'stop') {
          this.serverTurnEnded = true;
          this.emitResult(false, 'success');
        }
        break;
      }

      case 'session.next.step.failed':
        this.serverTurnEnded = true;
        this.turnTokens = addTokens(this.turnTokens, data.tokens);
        this.emitResult(true, 'error_during_execution');
        break;

      case 'session.error':
        logger.error('opencode session error', { data });
        this.emitResult(true, 'error_during_execution');
        break;

      default:
        break;
    }
  }

  private emitInit(model: string): void {
    this.stdout.push(serialize({
      type: 'system',
      subtype: 'init',
      session_id: this.opencodeSessionId,
      cwd: this.options.cwd,
      tools: [],
      mcp_servers: [],
      model,
      permissionMode: 'opencode-managed',
      apiKeySource: 'opencode',
      provider: 'opencode',
    }));
  }

  private emitThinking(text: string): void {
    if (!text) return;
    this.stdout.push(serialize({
      type: 'assistant',
      session_id: this.opencodeSessionId,
      message: {
        id: `opencode-thinking-${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: text }],
      },
      provider: 'opencode',
    }));
  }

  private emitText(text: string, id: string): void {
    if (!text) return;
    this.stdout.push(serialize({
      type: 'assistant',
      session_id: this.opencodeSessionId,
      message: {
        id: `opencode-${id}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
      provider: 'opencode',
    }));
  }

  private emitToolUse(id: string, name: string, input: Record<string, unknown>): void {
    this.stdout.push(serialize({
      type: 'assistant',
      session_id: this.opencodeSessionId,
      message: {
        id: `opencode-tool-${id}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
      provider: 'opencode',
    }));
  }

  private emitToolResult(id: string, content: string, isError: boolean): void {
    this.stdout.push(serialize({
      type: 'user',
      session_id: this.opencodeSessionId,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: id,
          content,
          ...(isError ? { is_error: true } : {}),
        }],
      },
      provider: 'opencode',
    }));
  }

  private emitResult(isError: boolean, subtype: string): void {
    // Whichever path gets here first owns the turn's single result line.
    if (!this.awaitingResult) return;
    this.awaitingResult = false;
    clearInterval(this.livenessTimer);
    const duration = this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
    this.stdout.push(serialize({
      type: 'result',
      subtype,
      is_error: isError,
      duration_ms: duration,
      duration_api_ms: duration,
      num_turns: 1,
      session_id: this.opencodeSessionId,
      usage: {
        input_tokens: this.turnTokens.input,
        cache_creation_input_tokens: this.turnTokens.cacheWrite,
        cache_read_input_tokens: this.turnTokens.cacheRead,
        output_tokens: this.turnTokens.output,
        server_tool_use: { web_search_requests: 0 },
      },
      provider: 'opencode',
    }));
  }

  private close(code: number): void {
    if (!this.aliveValue) return;
    this.aliveValue = false;
    clearInterval(this.livenessTimer);
    // Closing before opencode reported the turn finished means Lattice is
    // giving up on it. opencode does not notice that on its own — without an
    // explicit interrupt the turn keeps running server-side, burning tokens for
    // output nobody will read and competing with whatever replaces it.
    // Checked against the server's own terminal event, not `awaitingResult`,
    // which the synthetic error result has already cleared by this point.
    if (!this.serverTurnEnded) {
      const url = `${this.options.baseUrl}/api/session/${this.opencodeSessionId}/interrupt`;
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      }).catch((err: unknown) => {
        logger.warn('Failed to interrupt an abandoned opencode turn', {
          opencodeSessionId: this.opencodeSessionId,
          error: String(err),
        });
      });
    }
    this.options.onSessionActive(this.opencodeSessionId, false);
    this.abort.abort();
    this.stdout.terminate();
    this.exitedResolve({ code });
  }
}
