import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import readline from 'node:readline';
import { codexSkillsRoot } from '../infrastructure/agent-skills.js';
import { createLogger } from '../infrastructure/logger.js';
import { parseJson } from '../../utils/json.js';
import { LatticeError } from '../../types/index.js';
import type {
  CodexAccountReadResponse,
  CodexAccountRateLimitsResponse,
  CodexRequestId,
  CodexServerNotification,
  CodexServerRequest,
  CodexThreadGoalClearResponse,
  CodexThreadGoalGetResponse,
  CodexThreadGoalSetResponse,
  CodexThreadCompactStartResponse,
  CodexThreadResumeResponse,
  CodexThreadStartResponse,
  CodexTurnStartResponse,
  CodexTurnSteerResponse,
  CodexUserInput,
} from './codex-app-server-types.js';

type JsonRecord = Record<string, unknown>;

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface CodexThreadStartOptions {
  cwd: string;
  model: string;
  reasoningEffort: string;
}

export interface CodexTurnStartOptions {
  threadId: string;
  input: CodexUserInput[];
  model?: string;
  reasoningEffort: string;
}

export interface CodexTurnSteerOptions {
  threadId: string;
  /** Precondition: the app-server refuses the call unless this turn is the running one. */
  expectedTurnId: string;
  input: CodexUserInput[];
  /** Echoed back as the `clientId` of the resulting `userMessage` item. */
  clientUserMessageId?: string;
}

const logger = createLogger('CodexAppServerClient');
const DEFAULT_RPC_TIMEOUT_MS = 185_000;
/** See `steerTurn`: the caller is holding the turn boundary while this runs. */
const STEER_RPC_TIMEOUT_MS = 15_000;
const CODEX_APPROVAL_POLICY = 'never';
const CODEX_SANDBOX_MODE = 'danger-full-access';

function isResponseMessage(value: JsonRecord): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'id')
    && (Object.prototype.hasOwnProperty.call(value, 'result')
      || Object.prototype.hasOwnProperty.call(value, 'error'));
}

function isServerRequestMessage(value: JsonRecord): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'id')
    && typeof value.method === 'string';
}

function errorFromRpc(method: string, raw: unknown): Error {
  if (raw && typeof raw === 'object') {
    const error = raw as { code?: unknown; message?: unknown };
    const message = typeof error.message === 'string'
      ? error.message
      : JSON.stringify(error);
    const err = new Error(`Codex ${method} failed: ${message}`);
    if (typeof error.code === 'string' || typeof error.code === 'number') {
      (err as Error & { code?: string | number }).code = error.code;
    }
    return err;
  }
  return new Error(`Codex ${method} failed: ${String(raw)}`);
}

/**
 * Whether the app-server answered this call with an error, as opposed to the
 * call never getting an answer.
 *
 * The distinction is the whole safety property for steering: an error response
 * proves the input was not taken, so the caller can keep it and deliver it
 * later. A timeout or a dead transport proves nothing, and re-sending on one
 * would be how the same correction arrives twice. `errorFromRpc` copies the
 * JSON-RPC error code onto the Error; nothing else here sets one.
 */
export function isCodexRpcRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number';
}

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private initializePromise: Promise<void> | null = null;
  private stderrTail = '';

  constructor(
    private readonly key: string,
    private readonly cwd: string,
  ) {
    super();
    this.setMaxListeners(100);
  }

  async ensureStarted(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.startAndInitialize();
    return this.initializePromise;
  }

  async startThread(options: CodexThreadStartOptions): Promise<CodexThreadStartResponse> {
    await this.ensureStarted();
    return this.rpc<CodexThreadStartResponse>('thread/start', {
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandbox: CODEX_SANDBOX_MODE,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      config: { model_reasoning_effort: options.reasoningEffort },
    });
  }

  async resumeThread(threadId: string, options: CodexThreadStartOptions): Promise<CodexThreadResumeResponse> {
    await this.ensureStarted();
    return this.rpc<CodexThreadResumeResponse>('thread/resume', {
      threadId,
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandbox: CODEX_SANDBOX_MODE,
      persistExtendedHistory: false,
      config: { model_reasoning_effort: options.reasoningEffort },
    });
  }

  async startTurn(options: CodexTurnStartOptions): Promise<CodexTurnStartResponse> {
    await this.ensureStarted();
    return this.rpc<CodexTurnStartResponse>('turn/start', {
      threadId: options.threadId,
      input: options.input,
      ...(options.model ? { model: options.model } : {}),
      effort: options.reasoningEffort,
    });
  }

  /**
   * Add input to the turn that is already running, without starting a new one.
   *
   * `expectedTurnId` is a precondition, not a hint: the app-server rejects the
   * call when that turn is not the running one, naming what it found instead
   * (verified 2026-09-21 against 0.153.3 — see the evidence README). That
   * rejection is what makes this safe to use against a turn that may have
   * ended while the request was being composed. Do not read a turn id out of
   * the rejection and retry with it: the turn it names is a different piece of
   * work from the one the input was written for.
   *
   * Short timeout. Acceptance was measured at ~70ms and the caller holds the
   * session's turn admission while it waits, so the default 185s would wedge
   * the session rather than fail. A timeout here is uncertain acceptance, not
   * a refusal — `isCodexRpcRefusal` is the discriminator.
   */
  async steerTurn(options: CodexTurnSteerOptions, timeoutMs = STEER_RPC_TIMEOUT_MS): Promise<CodexTurnSteerResponse> {
    await this.ensureStarted();
    return this.rpc<CodexTurnSteerResponse>('turn/steer', {
      threadId: options.threadId,
      expectedTurnId: options.expectedTurnId,
      input: options.input,
      ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}),
    }, timeoutMs);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.ensureStarted();
    await this.rpc<Record<string, never>>('turn/interrupt', { threadId, turnId });
  }

  async startThreadCompaction(threadId: string): Promise<CodexThreadCompactStartResponse> {
    await this.ensureStarted();
    return this.rpc<CodexThreadCompactStartResponse>('thread/compact/start', { threadId });
  }

  async setGoal(params: {
    threadId: string;
    objective?: string | null;
    status?: string | null;
    tokenBudget?: number | null;
  }): Promise<CodexThreadGoalSetResponse> {
    await this.ensureStarted();
    return this.rpc<CodexThreadGoalSetResponse>('thread/goal/set', params);
  }

  async getGoal(threadId: string): Promise<CodexThreadGoalGetResponse> {
    await this.ensureStarted();
    return this.rpc<CodexThreadGoalGetResponse>('thread/goal/get', { threadId });
  }

  async clearGoal(threadId: string): Promise<CodexThreadGoalClearResponse> {
    await this.ensureStarted();
    return this.rpc<CodexThreadGoalClearResponse>('thread/goal/clear', { threadId });
  }

  async readRateLimits(): Promise<CodexAccountRateLimitsResponse> {
    await this.ensureStarted();
    return this.rpc<CodexAccountRateLimitsResponse>('account/rateLimits/read', undefined);
  }

  async refreshChatGptAuth(): Promise<CodexAccountReadResponse> {
    await this.ensureStarted();
    const response = await this.rpc<CodexAccountReadResponse>('account/read', { refreshToken: true });
    logger.debug('Refreshed Codex ChatGPT auth', {
      key: this.key,
      hasAccount: Boolean(response.account),
      requiresOpenaiAuth: response.requiresOpenaiAuth,
    });
    return response;
  }

  async archiveThread(threadId: string): Promise<unknown> {
    await this.ensureStarted();
    return this.rpc('thread/archive', { threadId });
  }

  async readThread(threadId: string, includeTurns = true): Promise<unknown> {
    await this.ensureStarted();
    return this.rpc('thread/read', { threadId, includeTurns });
  }

  async listThreads(params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted();
    return this.rpc('thread/list', params ?? {});
  }

  shutdown(): void {
    if (!this.child) return;
    this.child.kill('SIGTERM');
    this.child = null;
  }

  respondToServerRequest(id: CodexRequestId, result: unknown): void {
    this.writeServerMessage({ jsonrpc: '2.0', id, result });
  }

  respondToServerRequestError(
    id: CodexRequestId,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    this.writeServerMessage({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  private async startAndInitialize(): Promise<void> {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;

    this.child = spawn('codex', [
      '-c', 'preferred_auth_method=chatgpt',
      '-c', 'features.goals=true',
      'app-server',
      '--listen', 'stdio://',
    ], {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.on('exit', (code, signal) => {
      const message = `Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      logger.warn(message, { key: this.key, stderrTail: this.stderrTail || null });
      this.handleGone((method) => new Error(`${message} while waiting for ${method}`), code, signal);
    });

    // A spawn that fails emits 'error' and never 'exit'. Without this
    // listener that 'error' was unhandled and took the whole server down,
    // which is what creating a Codex session did on a machine without Codex.
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      if (!error.syscall?.startsWith('spawn')) {
        logger.warn('Codex app-server process error', { key: this.key, error: error.message });
        return;
      }
      logger.warn('Codex app-server failed to start', { key: this.key, error: error.message });
      const failure = error.code === 'ENOENT'
        ? new LatticeError(
            'PROVIDER_NOT_INSTALLED',
            'Codex is not installed on the machine running Lattice: there is no `codex` on its PATH. '
              + 'Install it (https://learn.chatgpt.com/docs/codex/cli), then try again.',
            400,
          )
        : new Error(`Codex app-server failed to start: ${error.message}`);
      this.handleGone(() => failure, null, null);
    });

    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stderrTail = (this.stderrTail + text).slice(-4096);
      logger.debug('Codex app-server stderr', { key: this.key, text: text.slice(0, 500) });
    });

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.handleLine(line));

    await this.initializeProtocol();

    logger.info('Codex app-server initialized', { key: this.key, cwd: this.cwd });
  }

  /** The app-server is gone: fail what was waiting on it and start afresh next time. */
  private handleGone(
    failure: (method: string) => Error,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(failure(pending.method));
      this.pending.delete(id);
    }
    this.child = null;
    this.initializePromise = null;
    this.emit('exit', { code, signal });
  }

  private async initializeProtocol(): Promise<void> {
    await this.rpc('initialize', {
      clientInfo: { name: 'lattice-app', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    });
    // The app-server handshake is two-phase. It deliberately does not answer
    // later requests until the client acknowledges the initialize response.
    this.writeServerMessage({
      jsonrpc: '2.0',
      method: 'initialized',
      params: {},
    });
    // The skills Lattice ships (agent-skills.ts), alongside the user's own.
    const skillsRoot = codexSkillsRoot();
    if (existsSync(skillsRoot)) {
      await this.rpc('skills/extraRoots/set', { extraRoots: [skillsRoot] }).catch((error: unknown) => {
        logger.warn('Codex did not take the Lattice skills root; sessions will not have the Lattice skills', {
          key: this.key,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private rpc<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<T> {
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }

    const id = this.nextId++;
    const request = { jsonrpc: '2.0', id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        timeout,
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      child.stdin.write(JSON.stringify(request) + '\n', (err) => {
        if (!err) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`Failed to write Codex ${method}: ${err.message}`));
      });
    });
  }

  private writeServerMessage(message: JsonRecord): void {
    const child = this.child;
    if (!child?.stdin.writable) {
      logger.warn('Could not answer Codex server request because app-server is not running', {
        key: this.key,
        id: message.id,
      });
      return;
    }
    child.stdin.write(JSON.stringify(message) + '\n', (err) => {
      if (!err) return;
      logger.warn('Failed to answer Codex server request', {
        key: this.key,
        id: message.id,
        error: err.message,
      });
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: unknown;
    try {
      parsed = parseJson(line);
    } catch (err) {
      logger.warn('Failed to parse Codex app-server line', {
        key: this.key,
        error: err instanceof Error ? err.message : String(err),
        line: line.slice(0, 500),
      });
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    const msg = parsed as JsonRecord;

    if (isResponseMessage(msg)) {
      const id = Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) {
        logger.warn('Received Codex response for unknown request', { key: this.key, id });
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(id);

      if (msg.error) {
        pending.reject(errorFromRpc(pending.method, msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (isServerRequestMessage(msg)) {
      const request = msg as unknown as CodexServerRequest;

      // This request is independent of a thread, so answer it once here rather
      // than broadcasting it to every active thread handle on the shared client.
      if (request.method === 'currentTime/read') {
        this.respondToServerRequest(request.id, {
          currentTimeAt: Math.floor(Date.now() / 1000),
        });
        return;
      }

      const requestParams = request.params && typeof request.params === 'object'
        ? request.params as Record<string, unknown>
        : {};
      const hasThreadIdentity = typeof requestParams.threadId === 'string'
        || typeof requestParams.conversationId === 'string';
      if (!hasThreadIdentity) {
        this.respondToServerRequestError(
          request.id,
          -32601,
          `Lattice does not implement global Codex server request ${request.method}`,
        );
        return;
      }

      let claimed = false;
      this.emit('request', request, () => {
        claimed = true;
      });
      if (!claimed) {
        this.respondToServerRequestError(
          request.id,
          -32601,
          `Lattice does not implement Codex server request ${request.method}`,
        );
      }
      return;
    }

    if (typeof msg.method === 'string') {
      const notification = msg as CodexServerNotification;
      // Never re-emit the raw method name: codex sends method 'error', and an
      // unlistened 'error' emit crashes the process.
      this.emit('notification', notification);
      return;
    }

    logger.debug('Ignored Codex app-server message', { key: this.key, message: msg });
  }
}

const clients = new Map<string, CodexAppServerClient>();

export function getCodexAppServerClient(key: string, cwd: string): CodexAppServerClient {
  const existing = clients.get(key);
  if (existing) return existing;

  const client = new CodexAppServerClient(key, cwd);
  clients.set(key, client);
  client.on('exit', () => {
    if (clients.get(key) === client) {
      clients.delete(key);
    }
  });
  return client;
}

/**
 * Retires every app-server so the next thread spawns a fresh one. The
 * app-server caches auth.json in memory and only re-reads it for a login it
 * ran itself, so this is how a CLI-side login or logout takes effect.
 */
export function shutdownAllCodexAppServerClients(): void {
  for (const [key, client] of clients) {
    clients.delete(key);
    client.shutdown();
  }
}
