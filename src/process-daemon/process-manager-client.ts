/**
 * Process Manager Client - Drop-in replacement for ClaudeProcessManager
 *
 * This client connects to the process daemon via Unix socket and provides
 * the same interface as ClaudeProcessManager, so lattice-server can swap them
 * with minimal code changes.
 */

import * as net from 'net';
import { EventEmitter } from 'events';

import { ConversationConfig, SystemInitMessage, LatticeError } from '../types/index.js';
import {
  IPCRequest,
  IPCResponse,
  IPCEvent,
  SpawnResult,
  SpawnOptimisticResult,
  DEFAULT_SOCKET_PATH,
  ClaudeMessageEventData,
  ProcessClosedEventData,
  ProcessErrorEventData,
  ClaudeControlRequestEventData,
  LoginTerminalStartParams,
  LoginTerminalStartResult,
  LoginTerminalAttachResult,
  LoginTerminalInputResult,
  LoginTerminalOutputEventData,
  LoginTerminalStateEventData,
} from './types.js';
import type { LoginAttemptState, LoginTerminalSize } from './claude-login-terminal.js';
import { createLogger, type Logger } from '../services/infrastructure/logger.js';
import { parseJson } from '../utils/json.js';

/** Spawn + system init can take up to 180s; this is the request ceiling. */
const REQUEST_TIMEOUT_MS = 185_000;

const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
/** A connection that lasted this long resets the backoff; a daemon dying sooner is a crash loop. */
const RECONNECT_STABLE_MS = 60_000;

export interface ProcessManagerClientOptions {
  /** Starts a daemon if none answers on the socket; run before each reconnect attempt. */
  revive?: () => Promise<void>;
}

/**
 * Client that talks to the process daemon via Unix socket.
 * Implements the same interface as ClaudeProcessManager.
 */
export class ProcessManagerClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private socketPath: string;
  private logger: Logger;
  private connected = false;
  private reconnecting = false;
  private shuttingDown = false;  // Prevents reconnection during shutdown
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private connectedAt = 0;
  private readonly revive?: () => Promise<void>;
  private requestId = 0;
  private pendingRequests: Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private buffer = '';

  constructor(socketPath: string = DEFAULT_SOCKET_PATH, options: ProcessManagerClientOptions = {}) {
    super();
    this.socketPath = socketPath;
    this.revive = options.revive;
    this.logger = createLogger('ProcessManagerClient');
  }

  /**
   * Connect to the process daemon
   */
  async connect(): Promise<void> {
    if (this.connected) {
      this.logger.debug('Already connected to daemon');
      return;
    }

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath, () => {
        this.connected = true;
        this.connectedAt = Date.now();
        this.logger.info('Connected to process daemon', { socketPath: this.socketPath });
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        // A failed reconnect attempt closes a socket that never connected;
        // the retry path already reports it.
        if (!wasConnected) return;
        const uptimeMs = Date.now() - this.connectedAt;
        if (uptimeMs >= RECONNECT_STABLE_MS) this.reconnectAttempts = 0;
        this.logger.warn('Disconnected from process daemon', { uptimeMs, reconnectAttempts: this.reconnectAttempts });

        // Reject all pending requests
        for (const [id, { reject }] of this.pendingRequests) {
          this.takePendingRequest(id);
          reject(new LatticeError('DAEMON_DISCONNECTED', 'Disconnected from process daemon', 503));
        }
        // The daemon only drops the socket when it stops, and its processes
        // stop with it; nothing more will arrive for any of them.
        this.emit('daemon-disconnected');

        // Attempt reconnection if not intentionally closed
        if (!this.reconnecting) {
          this.scheduleReconnect();
        }
      });

      this.socket.on('error', (err) => {
        this.logger.error('Socket error', err);
        if (!this.connected) {
          reject(new LatticeError('DAEMON_CONNECTION_FAILED', `Failed to connect to process daemon: ${err.message}`, 503));
        }
      });
    });
  }

  /**
   * Schedule a reconnection attempt, starting a new daemon first when a
   * `revive` was given. The delay doubles with each attempt since the last
   * stable connection, so a daemon that keeps dying is not restarted in a loop.
   */
  private scheduleReconnect(): void {
    if (this.reconnecting || this.shuttingDown) return;

    this.reconnecting = true;
    const attempt = ++this.reconnectAttempts;
    const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
    this.logger.info('Scheduling daemon reconnection', { attempt, delayMs, revive: Boolean(this.revive) });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      // Check shutdown flag before attempting reconnect
      if (this.shuttingDown) {
        this.reconnecting = false;
        return;
      }

      (this.revive ? this.revive() : Promise.resolve())
        .then(() => this.connect())
        .then(() => {
          this.reconnecting = false;
          this.logger.info('Reconnected to process daemon', { attempt });
          this.emit('daemon-reconnected');
        })
        .catch((error) => {
          this.reconnecting = false;
          if (!this.shuttingDown) {
            this.logger.error('Daemon reconnection failed; every Claude session is down until it succeeds', error, { attempt });
            this.scheduleReconnect();
          }
        });
    }, delayMs);
  }

  /**
   * Handle incoming data from the daemon
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = parseJson(line) as { id?: unknown; event?: unknown };

        // Check if it's a response (has id) or an event
        if ('id' in message) {
          this.handleResponse(message as IPCResponse);
        } else if ('event' in message) {
          this.handleEvent(message as IPCEvent);
        }
      } catch (err) {
        this.logger.error('Failed to parse daemon message', err, { line });
      }
    }
  }

  /**
   * Remove a pending request and cancel its timeout.
   *
   * Every settle path goes through here. The timeout is 185s, so leaving the
   * handle armed after a response arrived pinned a live timer and its closure
   * for three minutes per spawn/send/status call.
   */
  private takePendingRequest(id: number): { resolve: (result: unknown) => void; reject: (error: Error) => void } | undefined {
    const pending = this.pendingRequests.get(id);
    if (!pending) return undefined;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timeout);
    return pending;
  }

  /**
   * Handle a response to a request we made
   */
  private handleResponse(response: IPCResponse): void {
    const pending = this.takePendingRequest(response.id);
    if (!pending) {
      this.logger.warn('Received response for unknown request', { id: response.id });
      return;
    }

    if (response.error) {
      pending.reject(new LatticeError(response.error.code, response.error.message, 500));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle an event broadcast from the daemon
   */
  private handleEvent(event: IPCEvent): void {
    this.logger.debug('Daemon event received', { eventType: event.event });
    switch (event.event) {
      case 'claude-message': {
        const data = event.data as unknown as ClaudeMessageEventData;
        this.emit('claude-message', data);
        break;
      }
      case 'process-closed': {
        const data = event.data as unknown as ProcessClosedEventData;
        this.emit('process-closed', data);
        break;
      }
      case 'process-error': {
        const data = event.data as unknown as ProcessErrorEventData;
        this.emit('process-error', data);
        break;
      }
      case 'process-spawned': {
        const data = event.data as { streamingId: string };
        this.emit('process-spawned', data);
        break;
      }
      case 'turn-idle': {
        const data = event.data as { streamingId: string };
        this.emit('turn-idle', data);
        break;
      }
      case 'system-init-completed': {
        const data = event.data as { streamingId: string; systemInit: SystemInitMessage };
        this.emit('system-init-completed', data);
        break;
      }
      case 'system-init-failed': {
        const data = event.data as { streamingId: string; error: string; code: string };
        this.emit('system-init-failed', data);
        break;
      }
      case 'claude-control-request': {
        const data = event.data as unknown as ClaudeControlRequestEventData;
        this.emit('claude-control-request', data);
        break;
      }
      case 'login-terminal-output':
        this.emit('login-terminal-output', event.data as unknown as LoginTerminalOutputEventData);
        break;
      case 'login-terminal-state':
        this.emit('login-terminal-state', event.data as unknown as LoginTerminalStateEventData);
        break;
      default:
        this.logger.warn('Unknown event type', { event: event.event });
    }
  }

  /**
   * Send a request to the daemon and wait for response
   */
  private async sendRequest<T>(method: IPCRequest['method'], params: Record<string, unknown> = {}): Promise<T> {
    if (!this.connected || !this.socket) {
      throw new LatticeError('DAEMON_NOT_CONNECTED', 'Not connected to process daemon', 503);
    }

    const id = ++this.requestId;
    const request: IPCRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      // Timeout after 185 seconds (spawn + system init can take up to 180s).
      // Cleared by takePendingRequest() on every settle path.
      const timeout = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new LatticeError('DAEMON_REQUEST_TIMEOUT', 'Request to process daemon timed out', 504));
        }
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      this.socket!.write(JSON.stringify(request) + '\n', (err) => {
        if (err) {
          this.takePendingRequest(id);
          reject(new LatticeError('DAEMON_WRITE_FAILED', `Failed to send request: ${err.message}`, 500));
        }
      });
    });
  }

  /**
   * Disconnect from the daemon
   */
  disconnect(): void {
    this.shuttingDown = true;  // Permanently stop reconnection attempts
    this.reconnecting = true;  // Also set this for backwards compatibility

    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }

    this.logger.info('Client disconnected and shutdown');
  }

  /**
   * Check if connected to daemon
   */
  isConnected(): boolean {
    return this.connected;
  }

  // ============================================================================
  // ClaudeProcessManager-compatible Interface
  // ============================================================================

  /**
   * Start a new conversation (or resume if resumedSessionId is provided)
   */
  async startConversation(
    config: ConversationConfig & { resumedSessionId?: string }
  ): Promise<{ streamingId: string; systemInit: SystemInitMessage }> {
    this.logger.debug('Starting conversation via daemon', {
      hasInitialPrompt: !!config.initialPrompt,
      workingDirectory: config.workingDirectory,
      isResume: !!config.resumedSessionId,
    });

    const result = await this.sendRequest<SpawnResult>('spawn', { config });
    return result;
  }

  /**
   * Start a conversation optimistically — returns streamingId immediately before
   * system init completes. System init result arrives via events:
   * - 'system-init-completed': { streamingId, systemInit }
   * - 'system-init-failed': { streamingId, error, code }
   */
  async startConversationOptimistic(
    config: ConversationConfig & { resumedSessionId?: string }
  ): Promise<{ streamingId: string }> {
    this.logger.debug('Starting conversation optimistically via daemon', {
      hasInitialPrompt: !!config.initialPrompt,
      workingDirectory: config.workingDirectory,
      isResume: !!config.resumedSessionId,
    });

    const result = await this.sendRequest<SpawnOptimisticResult>('spawnOptimistic', { config });
    return result;
  }

  /**
   * Wait for system init to complete for an optimistic spawn.
   * Returns a promise that resolves with the SystemInitMessage or rejects on failure/timeout.
   */
  onSystemInit(streamingId: string, timeoutMs: number = 180000): Promise<SystemInitMessage> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        this.removeListener('system-init-completed', onCompleted);
        this.removeListener('system-init-failed', onFailed);
      };

      const onCompleted = (data: { streamingId: string; systemInit: SystemInitMessage }) => {
        if (data.streamingId !== streamingId || settled) return;
        cleanup();
        resolve(data.systemInit);
      };

      const onFailed = (data: { streamingId: string; error: string; code: string }) => {
        if (data.streamingId !== streamingId || settled) return;
        cleanup();
        reject(new LatticeError(data.code, data.error, 500));
      };

      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new LatticeError('SYSTEM_INIT_TIMEOUT', 'Timed out waiting for system init event', 500));
      }, timeoutMs);

      this.on('system-init-completed', onCompleted);
      this.on('system-init-failed', onFailed);
    });
  }

  /**
   * Stop a conversation
   */
  async stopConversation(streamingId: string): Promise<boolean> {
    this.logger.debug('Stopping conversation via daemon', { streamingId });

    const result = await this.sendRequest<{ success: boolean }>('stop', { streamingId });
    return result.success;
  }

  /**
   * Force kill a conversation immediately
   */
  async forceKillConversation(streamingId: string): Promise<boolean> {
    this.logger.debug('Force killing conversation via daemon', { streamingId });

    const result = await this.sendRequest<{ success: boolean }>('forceKill', { streamingId });
    return result.success;
  }

  /**
   * Interrupt a conversation (SIGINT - like Ctrl-C)
   */
  async interruptConversation(streamingId: string): Promise<boolean> {
    this.logger.debug('Interrupting conversation via daemon', { streamingId });

    const result = await this.sendRequest<{ success: boolean }>('interrupt', { streamingId });
    return result.success;
  }

  /**
   * Get active sessions with their session IDs
   */
  async getActiveSessions(): Promise<Array<{ streamingId: string; sessionId: string; isIdle?: boolean }>> {
    const result = await this.sendRequest<{ sessions: Array<{ streamingId: string; sessionId: string; isIdle?: boolean }> }>('list');
    return result.sessions;
  }

  /**
   * Check if a session is active
   */
  async isSessionActive(streamingId: string): Promise<boolean> {
    const result = await this.sendRequest<{ active: boolean }>('isActive', { streamingId });
    return result.active;
  }

  /**
   * Send an answer to an AskUserQuestion tool
   */
  async sendQuestionAnswer(
    streamingId: string,
    toolUseId: string,
    questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>,
    answers: Record<string, string>
  ): Promise<boolean> {
    this.logger.debug('Sending question answer via daemon', { streamingId, toolUseId });

    const result = await this.sendRequest<{ success: boolean }>('sendQuestionAnswer', {
      streamingId,
      toolUseId,
      questions,
      answers,
    });
    return result.success;
  }

  /**
   * Respond to a `can_use_tool` SDK control request the daemon previously
   * forwarded via the `claude-control-request` event. The daemon serializes
   * the response into the wire shape expected by the Claude CLI and writes
   * it to the underlying process's stdin.
   *
   * For `behavior: 'allow'`, leaving `updatedInput` undefined preserves the
   * original tool input (the CLI treats the empty-object response as "use
   * original input"). For `behavior: 'deny'`, `message` becomes the
   * tool_result error the model sees.
   */
  async respondToControlRequest(
    streamingId: string,
    requestId: string,
    decision:
      | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
      | { behavior: 'deny'; message?: string },
  ): Promise<boolean> {
    this.logger.debug('Sending control_response via daemon', {
      streamingId,
      requestId: requestId.slice(0, 8),
      behavior: decision.behavior,
    });

    const result = await this.sendRequest<{ success: boolean }>('respondToControlRequest', {
      streamingId,
      requestId,
      behavior: decision.behavior,
      ...(decision.behavior === 'allow' ? { updatedInput: decision.updatedInput } : {}),
      ...(decision.behavior === 'deny' ? { message: decision.message } : {}),
    });
    return result.success;
  }

  /**
   * Send a raw stdin message to a Claude process
   */
  async sendStdinMessage(streamingId: string, message: string): Promise<boolean> {
    this.logger.debug('Sending stdin message via daemon', { streamingId });

    const result = await this.sendRequest<{ success: boolean }>('write', {
      streamingId,
      message,
    });
    return result.success;
  }

  // ============================================================================
  // Claude login terminal. Screen data and keystrokes pass through these and
  // through the two login-terminal events; none of it is logged here.
  // ============================================================================

  async startLoginTerminal(params: LoginTerminalStartParams = {}): Promise<LoginTerminalStartResult> {
    return this.sendRequest<LoginTerminalStartResult>('loginTerminalStart', params as unknown as Record<string, unknown>);
  }

  async attachLoginTerminal(attemptId: string): Promise<LoginTerminalAttachResult> {
    return this.sendRequest<LoginTerminalAttachResult>('loginTerminalAttach', { attemptId });
  }

  async sendLoginTerminalInput(attemptId: string, clientId: string, seq: number, data: string): Promise<LoginTerminalInputResult> {
    return this.sendRequest<LoginTerminalInputResult>('loginTerminalInput', { attemptId, clientId, seq, data });
  }

  async resizeLoginTerminal(attemptId: string, size: Partial<LoginTerminalSize>): Promise<void> {
    await this.sendRequest<{ success: boolean }>('loginTerminalResize', { attemptId, size });
  }

  async getLoginTerminalState(attemptId: string): Promise<LoginAttemptState> {
    const result = await this.sendRequest<{ state: LoginAttemptState }>('loginTerminalState', { attemptId });
    return result.state;
  }

  async cancelLoginTerminal(attemptId: string): Promise<boolean> {
    const result = await this.sendRequest<{ cancelled: boolean }>('loginTerminalCancel', { attemptId });
    return result.cancelled;
  }

  // ============================================================================
  // No-op stubs (these operations are handled by the daemon)
  // ============================================================================

  /**
   * No-op: Status manager integration is handled by lattice-server
   */
  setConversationStatusManager(_service: unknown): void {
    this.logger.debug('setConversationStatusManager called (no-op in client mode)');
  }

  /**
   * No-op: Router service is not used in daemon mode yet
   */
  setRouterService(_service: unknown): void {
    this.logger.debug('setRouterService called (no-op in client mode)');
  }
}
