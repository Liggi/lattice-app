/**
 * Process Daemon - Long-running process that owns Claude CLI PTY processes
 *
 * This daemon runs independently of the web server and survives server
 * restarts, and so do its processes. A process's events go to the server that
 * owns it; while that server is gone they are kept, and the next server
 * attaches and receives them (held-streams.ts), so a turn carries on through
 * the restart.
 *
 * It communicates with lattice-server via Unix socket IPC.
 */

import * as pty from 'node-pty';
import * as net from 'net';
import * as fs from 'fs';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { ConversationConfig, SystemInitMessage, StreamEvent, StreamMessage, LatticeError } from '../types/index.js';
import { ClaudeLoginTerminalManager, type LoginTerminalProcess, type LoginTerminalSize } from './claude-login-terminal.js';
import { findUserClaudeExecutable } from '../services/process/claude-cli.js';
import { claudeSpawnEnv } from './claude-spawn-auth.js';
import { agentEnv } from '../services/infrastructure/agent-env.js';

class JsonLinesParser extends EventEmitter {
  private buffer = '';

  write(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = parseJson(trimmed);
        this.emit('data', parsed);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
import {
  IPCRequest,
  IPCResponse,
  IPCEvent,
  SpawnParams,
  SpawnResult,
  SpawnOptimisticResult,
  StopParams,
  WriteParams,
  SendQuestionAnswerParams,
  IsActiveParams,
  LoginTerminalStartParams,
  LoginTerminalAttachParams,
  LoginTerminalInputParams,
  LoginTerminalResizeParams,
  RespondToControlRequestParams,
  ClaudeControlRequestEventData,
  DaemonConfig,
  DEFAULT_SOCKET_PATH,
  DaemonIdentityResult,
  AttachParams,
  AttachResult,
  ActiveSession,
} from './types.js';
import { HeldStreams } from './held-streams.js';
import { CONFIG_DIR } from '../utils/constants.js';
import { claudePluginDir } from '../services/infrastructure/agent-skills.js';
import { createLogger } from '../services/infrastructure/logger.js';
import { getEventJournal } from '../services/infrastructure/event-journal.js';
import { parseJson } from '../utils/json.js';
// classifyClaudeSpawnFailure removed — was only used in PTY spawn error path (now pipe-only)

/**
 * Expand tilde (~) in paths to the user's home directory.
 */
function expandTilde(filePath: string): string {
  if (filePath === '~' || filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

const logger = createLogger('ProcessDaemon');

/**
 * Kill an entire process group (negative PID) to ensure child processes
 * (like MCP servers spawned by Claude CLI) are cleaned up.
 * PTY-spawned processes are session leaders with their own process group,
 * so -pid targets all descendants.
 */
/**
 * Outcome of a signal attempt.
 * - delivered: the signal reached the process group or the bare PID.
 * - confirmedDead: every attempt failed with ESRCH ("no such process"), so the
 *   process is definitively gone. Callers use this to drive close/cleanup when
 *   the OS-level exit event (pty `onExit` / pipe `close`) never fired — without
 *   it the daemon's bookkeeping keeps a dead PID alive and the session hangs in
 *   a phantom "busy" state until a later resume recovers it (observed ~6-min
 *   hang, 2026-05-30).
 */
interface KillResult {
  delivered: boolean;
  confirmedDead: boolean;
}

function killProcessGroup(pid: number, signal?: NodeJS.Signals): KillResult {
  const sig = signal || 'SIGTERM';
  try {
    process.kill(-pid, sig);
    logger.info('Process group signal delivered', { pid, signal: sig, target: 'group' });
    return { delivered: true, confirmedDead: false };
  } catch (e: unknown) {
    const code = e && typeof e === 'object' && 'code' in e ? (e as { code: string }).code : undefined;
    logger.info('Process group signal failed, falling back to direct PID', { pid, signal: sig, errorCode: code });
    // ESRCH on negative PID means no process *group* with that PGID — the process
    // itself may still be alive (e.g. piped spawns that aren't process group leaders).
    // Always fall through to the direct PID kill.
    try {
      process.kill(pid, sig);
      logger.info('Direct PID signal delivered', { pid, signal: sig });
      return { delivered: true, confirmedDead: false };
    } catch (e2: unknown) {
      const code2 = e2 && typeof e2 === 'object' && 'code' in e2 ? (e2 as { code: string }).code : undefined;
      logger.info('Direct PID signal failed (process likely exited)', { pid, signal: sig, errorCode: code2 });
      // Only ESRCH proves the process is gone. Other errors (e.g. EPERM) leave
      // liveness unknown, so don't claim death then.
      return { delivered: false, confirmedDead: code2 === 'ESRCH' };
    }
  }
}

/**
 * Unified process wrapper - handles both PTY and regular child processes
 */
interface ManagedProcess {
  type: 'pty' | 'pipe';
  pty?: pty.IPty & { destroy?: () => void };
  child?: ChildProcess;
  pid: number;
  write: (data: string) => void;
  kill: (signal?: NodeJS.Signals) => void;
  endStdin?: () => void; // Only for piped processes - signals end of input
  /** False once stdin has been ended; the CLI can never read input again. */
  inputOpen?: () => boolean;
}

/**
 * Process Daemon - owns and manages Claude CLI PTY processes
 */
export class ProcessDaemon extends EventEmitter {
  private processes: Map<string, ManagedProcess> = new Map();
  private outputBuffers: Map<string, string> = new Map();
  private timeouts: Map<string, NodeJS.Timeout[]> = new Map();
  private conversationConfigs: Map<string, ConversationConfig> = new Map();
  private sessionIds: Map<string, string> = new Map(); // streamingId -> claude session_id
  private killedProcesses: Set<string> = new Set();
  private idleTimeouts: Map<string, NodeJS.Timeout> = new Map();
  /** Processes already logged as running on with a closed stdin. */
  private closedInputReported: Set<string> = new Set();
  private static readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  /**
   * Work the CLI will wake itself for. Closing stdin kills background tasks and
   * drops scheduled wakeups, so the idle timer waits for them.
   */
  private backgroundTasks: Map<string, Set<string>> = new Map();
  private wakeupDeadlines: Map<string, number> = new Map();
  /** Turn ended, but the idle timer is held back by running background tasks. */
  private idleDeferred: Set<string> = new Set();

  private ipcServer: net.Server | null = null;
  private connectedClients: Set<net.Socket> = new Set();
  /** Each process's events, kept while the server that owns it is gone (held-streams.ts). */
  private readonly heldStreams = new HeldStreams<net.Socket>((socket) => this.connectedClients.has(socket));
  private socketPath: string;
  /** null when Claude Code is not installed: a Codex-only install still runs. */
  private claudeExecutablePath: string | null;
  private envOverrides: Record<string, string | undefined>;
  private readonly identity: string | null;
  private readonly loginTerminals: ClaudeLoginTerminalManager;

  // Cached capability probes for the resolved `claude` CLI. Lazily populated
  // on first spawn; guards against passing flags the user's CLI doesn't know
  // about (hidden flags that vary by version/auth tier).
  private claudeSupportsThinkingDisplay: boolean | null = null;

  // Rolling stderr buffer per streamingId (capped). Included in process-closed
  // events/logs so crash reasons surface in server.log without tailing
  // daemon.log separately.
  private static readonly STDERR_BUFFER_MAX = 4096;
  private stderrBuffers: Map<string, string> = new Map();

  // Pending system init resolvers (streamingId -> {resolve, reject})
  private pendingSystemInits: Map<
    string,
    {
      resolve: (init: SystemInitMessage) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();

  constructor(config: DaemonConfig = { socketPath: DEFAULT_SOCKET_PATH }) {
    super();
    this.socketPath = config.socketPath;
    this.claudeExecutablePath = config.claudeExecutablePath || this.findClaudeExecutable();
    this.envOverrides = config.envOverrides || {};
    this.identity = config.identity ?? null;
    this.loginTerminals = new ClaudeLoginTerminalManager({
      spawn: (size) => this.spawnLoginTerminal(size),
      checkSignedIn: () => this.isClaudeSignedIn(),
    });
    this.loginTerminals.on('output', (data) => this.broadcastEvent({ event: 'login-terminal-output', data }));
    this.loginTerminals.on('state', (data) => this.broadcastEvent({ event: 'login-terminal-state', data }));
  }

  /**
   * The user's own `claude auth login`, on a PTY, in the same environment
   * conversations run in. Fixed arguments and no shell: when the CLI exits
   * there is nothing else to type into.
   */
  private spawnLoginTerminal(size: LoginTerminalSize): LoginTerminalProcess {
    const child = pty.spawn(this.requireClaudeExecutable(), ['auth', 'login'], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: os.homedir(),
      env: this.childEnv() as Record<string, string>,
    });
    return {
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      kill: () => child.kill(),
      onData: (listener) => { child.onData(listener); },
      onExit: (listener) => { child.onExit(listener); },
    };
  }

  /** `claude auth status --json`, asked of the same binary conversations use. */
  private isClaudeSignedIn(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.requireClaudeExecutable(), ['auth', 'status', '--json'], {
        env: this.childEnv() as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', () => {
        try {
          const parsed = parseJson(stdout.trim()) as { loggedIn?: unknown };
          resolve(parsed.loggedIn === true);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  /**
   * The environment every Claude child gets: the daemon's, minus what
   * configures the server rather than the agent (agent-env.ts), plus the
   * user's settings.json overrides.
   *
   * CLAUDE_CODE_AUTO_MODE_SERVER=1: a `-p` session does not ask the API to run
   * auto mode's classifier checks unless told to, and makes its own classifier
   * requests instead, which are billed. Only auto (and plan) sessions read it.
   *
   * BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS: stock Claude Code stops a
   * Bash call at 2 minutes, which cuts off ordinary builds and test runs. A
   * value in the daemon's environment or the user's settings.json wins.
   */
  private childEnv(): Record<string, string | undefined> {
    return {
      CLAUDE_CODE_AUTO_MODE_SERVER: '1',
      BASH_DEFAULT_TIMEOUT_MS: '300000',
      BASH_MAX_TIMEOUT_MS: '600000',
      ...agentEnv(),
      ...this.envOverrides,
    };
  }

  /**
   * The Claude executable for a spawn. Looked up again when it was missing at
   * startup, so installing Claude Code does not need a restart.
   */
  private requireClaudeExecutable(): string {
    this.claudeExecutablePath ??= this.findClaudeExecutable();
    if (this.claudeExecutablePath) return this.claudeExecutablePath;
    throw new LatticeError(
      'CLAUDE_NOT_INSTALLED',
      'Claude Code is not installed on the machine running Lattice. Install it with: npm install -g @anthropic-ai/claude-code, then sign in with: claude',
      400,
    );
  }

  /**
   * Find the Claude executable, or null when it is not installed.
   */
  private findClaudeExecutable(): string | null {
    return findUserClaudeExecutable();
  }

  /**
   * Probe the resolved `claude` CLI to see if it accepts `--thinking-display`.
   *
   * Context: this is a hidden CLI flag that was rolled out progressively
   * (and may be auth-tier gated). Versions without it exit with code 1 and
   * `error: unknown option '--thinking-display'` the moment they're spawned,
   * which used to crash every session on machines running older CLIs.
   *
   * We invoke the CLI with a deliberately invalid value and parse stderr:
   *   - "unknown option" → flag not supported, must NOT be passed
   *   - "invalid. Allowed choices" → flag parsed, supported
   *   - anything else → assume unsupported (safe default)
   *
   * Cached after first call. ~50–100ms one-time cost at first spawn.
   */
  private supportsThinkingDisplay(): boolean {
    if (this.claudeSupportsThinkingDisplay !== null) {
      return this.claudeSupportsThinkingDisplay;
    }
    // Outside the try: a missing CLI is the spawn's error, not "unsupported".
    const claudePath = this.requireClaudeExecutable();
    try {
      const result = spawnSync(
        claudePath,
        ['--thinking-display', '__lattice_probe__'],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const stderr = (result.stderr || '') + (result.stdout || '');
      if (/unknown option/i.test(stderr)) {
        this.claudeSupportsThinkingDisplay = false;
      } else if (/Allowed choices/i.test(stderr) || /--thinking-display/i.test(stderr)) {
        this.claudeSupportsThinkingDisplay = true;
      } else {
        // Unrecognized output — assume unsupported to avoid crashing sessions.
        this.claudeSupportsThinkingDisplay = false;
      }
      logger.info('Claude CLI capability probe: --thinking-display', {
        supported: this.claudeSupportsThinkingDisplay,
        claudePath: this.claudeExecutablePath,
      });
    } catch (err) {
      logger.warn('Claude CLI capability probe failed, assuming --thinking-display unsupported', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.claudeSupportsThinkingDisplay = false;
    }
    return this.claudeSupportsThinkingDisplay;
  }


  /**
   * Check if another daemon is already running by attempting to connect to the socket.
   * Returns true if a daemon is actively listening, false if socket is stale or missing.
   */
  private async isExistingDaemonRunning(): Promise<boolean> {
    if (!fs.existsSync(this.socketPath)) {
      return false;
    }

    return new Promise((resolve) => {
      const testSocket = new net.Socket();
      const timeout = setTimeout(() => {
        testSocket.destroy();
        resolve(false); // Timeout = no daemon responding
      }, 1000);

      testSocket.on('connect', () => {
        clearTimeout(timeout);
        testSocket.destroy();
        resolve(true); // Connected = daemon is running
      });

      testSocket.on('error', () => {
        clearTimeout(timeout);
        testSocket.destroy();
        resolve(false); // Error = socket is stale
      });

      testSocket.connect(this.socketPath);
    });
  }

  /**
   * Start the IPC server
   */
  async start(): Promise<void> {
    // Check if another daemon is already running
    const existingDaemon = await this.isExistingDaemonRunning();
    if (existingDaemon) {
      logger.warn('Another daemon is already running on this socket', { socketPath: this.socketPath });
      throw new Error(`Another daemon is already listening on ${this.socketPath}. Kill the existing daemon first or use a different socket path.`);
    }

    // Clean up stale socket file (we know no daemon is listening now)
    if (fs.existsSync(this.socketPath)) {
      logger.info('Removing stale socket file', { path: this.socketPath });
      fs.unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.ipcServer = net.createServer((socket) => {
        this.handleClientConnection(socket);
      });

      this.ipcServer.on('error', (err) => {
        logger.error('IPC server error', err);
        reject(err);
      });

      this.ipcServer.listen(this.socketPath, () => {
        // Set socket permissions so any local user can connect
        fs.chmodSync(this.socketPath, 0o777);
        logger.info('Process daemon started', {
          socketPath: this.socketPath,
          claudePath: this.claudeExecutablePath,
        });
        resolve();
      });
    });
  }

  /**
   * Stop the daemon gracefully
   */
  async stop(): Promise<void> {
    logger.info('Stopping process daemon...');
    this.loginTerminals.shutdown();

    // Stop all active processes
    const sessions = Array.from(this.processes.keys());
    for (const streamingId of sessions) {
      await this.stopConversation(streamingId);
    }

    // Close all client connections
    for (const client of this.connectedClients) {
      client.destroy();
    }
    this.connectedClients.clear();

    // Close IPC server
    if (this.ipcServer) {
      await new Promise<void>((resolve) => {
        this.ipcServer!.close(() => {
          logger.info('IPC server closed');
          resolve();
        });
      });
    }

    // Clean up socket file
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    logger.info('Process daemon stopped');
  }

  /**
   * Handle a new client connection
   */
  private handleClientConnection(socket: net.Socket): void {
    logger.info('Client connected');
    this.connectedClients.add(socket);
    this.emit('clients', this.connectedClients.size);

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Parse newline-delimited JSON messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const request = parseJson(line) as IPCRequest;
            void this.handleRequest(socket, request);
          } catch (err) {
            logger.error('Failed to parse IPC message', err, { line });
          }
        }
      }
    });

    socket.on('close', () => {
      logger.info('Client disconnected');
      this.connectedClients.delete(socket);
      this.emit('clients', this.connectedClients.size);
    });

    socket.on('error', (err) => {
      logger.error('Client socket error', err);
      this.connectedClients.delete(socket);
      this.emit('clients', this.connectedClients.size);
    });
  }

  /**
   * Handle an IPC request
   */
  private async handleRequest(socket: net.Socket, request: IPCRequest): Promise<void> {
    logger.debug('Received request', { method: request.method, id: request.id });

    try {
      let result: unknown;
      // Events sent to this client once the response is.
      let after: IPCEvent[] = [];

      switch (request.method) {
        case 'spawn':
          result = await this.handleSpawn(request.params as unknown as SpawnParams, socket);
          break;
        case 'spawnOptimistic':
          result = await this.handleSpawnOptimistic(request.params as unknown as SpawnParams, socket);
          break;
        case 'stop':
          result = await this.handleStop(request.params as unknown as StopParams);
          break;
        case 'forceKill':
          result = this.handleForceKill(request.params as unknown as StopParams);
          break;
        case 'interrupt':
          result = this.handleInterrupt(request.params as unknown as StopParams);
          break;
        case 'write':
          result = this.handleWrite(request.params as unknown as WriteParams);
          break;
        case 'sendQuestionAnswer':
          result = this.handleSendQuestionAnswer(request.params as unknown as SendQuestionAnswerParams);
          break;
        case 'respondToControlRequest':
          result = this.handleRespondToControlRequest(request.params as unknown as RespondToControlRequestParams);
          break;
        case 'list':
          result = { sessions: this.getActiveSessions() };
          break;
        case 'isActive':
          result = { active: this.isSessionActive((request.params as unknown as IsActiveParams).streamingId) };
          break;
        case 'attach': {
          const { streamingId } = request.params as unknown as AttachParams;
          const attached = this.heldStreams.attach(streamingId, socket);
          if (!attached) throw new LatticeError('STREAM_NOT_FOUND', `No process ${streamingId} to attach to`, 404);
          if (attached.dropped > 0) logger.warn('Attached with events dropped while no server was attached', { streamingId, dropped: attached.dropped });
          logger.info('Server attached to a running process', { streamingId, replayed: attached.events.length });
          result = { replayed: attached.events.length, dropped: attached.dropped } satisfies AttachResult;
          after = attached.events;
          break;
        }
        case 'identity':
          result = { pid: process.pid, identity: this.identity } satisfies DaemonIdentityResult;
          break;
        case 'loginTerminalStart': {
          const params = request.params as unknown as LoginTerminalStartParams;
          result = this.loginTerminals.start(params.size, params.restart === true);
          break;
        }
        case 'loginTerminalAttach': {
          const attached = this.loginTerminals.attach((request.params as unknown as LoginTerminalAttachParams).attemptId);
          if (!attached) throw new LatticeError('LOGIN_ATTEMPT_NOT_FOUND', 'Claude sign-in attempt not found or expired', 404);
          result = attached;
          break;
        }
        case 'loginTerminalInput': {
          const params = request.params as unknown as LoginTerminalInputParams;
          result = this.loginTerminals.input(params.attemptId, params.clientId, params.seq, params.data);
          break;
        }
        case 'loginTerminalResize': {
          const params = request.params as unknown as LoginTerminalResizeParams;
          this.loginTerminals.resize(params.attemptId, params.size);
          result = { success: true };
          break;
        }
        case 'loginTerminalState': {
          const state = this.loginTerminals.getState((request.params as unknown as LoginTerminalAttachParams).attemptId);
          if (!state) throw new LatticeError('LOGIN_ATTEMPT_NOT_FOUND', 'Claude sign-in attempt not found or expired', 404);
          result = { state };
          break;
        }
        case 'loginTerminalCancel':
          result = { cancelled: this.loginTerminals.cancel((request.params as unknown as LoginTerminalAttachParams).attemptId) };
          break;
        default: {
          const _exhaustiveCheck: never = request.method;
          throw new Error(`Unknown method: ${String(_exhaustiveCheck)}`);
        }
      }

      this.sendResponse(socket, { id: request.id, result });
      for (const event of after) socket.write(JSON.stringify(event) + '\n');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('IPC request failed', err, {
        method: request.method,
        requestId: request.id,
        errorCode: error instanceof LatticeError ? error.code : 'INTERNAL_ERROR',
      });
      this.sendResponse(socket, {
        id: request.id,
        error: {
          code: error instanceof LatticeError ? error.code : 'INTERNAL_ERROR',
          message: err.message,
        },
      });
    }
  }

  /**
   * Send a response to a specific client
   */
  private sendResponse(socket: net.Socket, response: IPCResponse): void {
    socket.write(JSON.stringify(response) + '\n');
  }

  /**
   * Send an event: a process's events to the server that owns it (held-streams.ts), the rest to every client
   */
  private broadcastEvent(event: IPCEvent): void {
    const message = JSON.stringify(event) + '\n';
    // A process's events go to the server that owns it, or are kept for the next one.
    const streamingId = (event.data as { streamingId?: unknown }).streamingId;
    if (typeof streamingId === 'string' && this.heldStreams.has(streamingId)) {
      const owner = this.heldStreams.route(streamingId, event);
      try {
        owner?.write(message);
      } catch (err) {
        logger.error('Failed to send to the owning client', err);
      }
      return;
    }
    for (const client of this.connectedClients) {
      try {
        client.write(message);
      } catch (err) {
        logger.error('Failed to broadcast to client', err);
      }
    }
  }

  // ============================================================================
  // Process Management (extracted from ClaudeProcessManager)
  // ============================================================================

  private async handleSpawn(params: SpawnParams, owner: net.Socket | null = null): Promise<SpawnResult> {
    const { config } = params;
    const isResume = !!config.resumedSessionId;
    const streamingId = randomUUID();
    this.heldStreams.own(streamingId, owner, config.conversationId ?? null);
    const spawnStartTime = Date.now();
    const hasMultimodalContent = !!(config.initialContent && config.initialContent.length > 0);
    const cwd = expandTilde(config.workingDirectory || process.cwd());

    logger.info('Spawning conversation', { streamingId, isResume });

    // Store config
    this.conversationConfigs.set(streamingId, config);

    try {
      // For multimodal, don't pass message as CLI arg - we'll send via stdin
      const args = isResume && config.resumedSessionId
        ? this.buildResumeArgs({ sessionId: config.resumedSessionId, message: config.initialPrompt, permissionMode: config.permissionMode, streamingId, hasMultimodalContent, model: config.model })
        : this.buildStartArgs(config);

      logger.info('Spawn cwd', { streamingId, configWorkingDirectory: config.workingDirectory, resolvedCwd: cwd, processCwd: process.cwd() });

      const env = {
        ...this.childEnv(),
        ...claudeSpawnEnv(config.model),
        ...silentTurnEnv(config),
        CUI_STREAMING_ID: streamingId,
        PWD: cwd,
        INIT_CWD: cwd,
      };

      let managedProcess: ManagedProcess;

      // Always use pipe mode — Claude Code's stdin reader checks process.stdin.isTTY
      // and skips stdin entirely when it's a TTY (node-pty). Pipe mode ensures Claude
      // reads --input-format stream-json from stdin, enabling mid-turn message injection.
      {
        const childProcess = await this.spawnPipedClaude(args, cwd, env as NodeJS.ProcessEnv);
        const pipePid = childProcess.pid;
        managedProcess = {
          type: 'pipe',
          child: childProcess,
          pid: pipePid,
          write: (data: string) => childProcess.stdin?.write(data),
          kill: (signal?: NodeJS.Signals) => killProcessGroup(pipePid, signal),
          endStdin: () => childProcess.stdin?.end(),
      inputOpen: () => Boolean(childProcess.stdin && !childProcess.stdin.writableEnded && !childProcess.stdin.destroyed),
        };

        this.processes.set(streamingId, managedProcess);
        this.setupPipedProcessHandlers(streamingId, childProcess);
      }

      // Broadcast process-spawned event so clients can start buffering
      this.broadcastEvent({
        event: 'process-spawned',
        data: { streamingId },
      });

      const spawnMs = Date.now() - spawnStartTime;
      logger.info('Process spawned', { streamingId, pid: managedProcess.pid, spawnMs, type: managedProcess.type });

      // Send initial content via stdin BEFORE waiting for system init.
      // stdin is kept open so future inject calls can queue messages mid-turn.
      if (hasMultimodalContent && config.initialContent) {
        const contentBlocks = [
          ...config.initialContent,
          ...(config.initialPrompt ? [{ type: 'text' as const, text: config.initialPrompt }] : [])
        ];

        const stdinMessage = JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: contentBlocks
          },
          session_id: config.resumedSessionId || ''
        });
        logger.info('Sending multimodal content via stdin', {
          streamingId,
          contentBlockCount: contentBlocks.length,
          messageLength: stdinMessage.length
        });
        managedProcess.write(stdinMessage + '\n');
        // stdin intentionally left open for mid-turn message injection
      } else if (config.initialPrompt) {
        // Text-only: send prompt via stdin so Claude stays in stdin-reading mode
        const stdinMessage = JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: config.initialPrompt
          }
        });
        logger.info('Sending initial prompt via stdin', {
          streamingId,
          promptLength: config.initialPrompt.length
        });
        managedProcess.write(stdinMessage + '\n');
      }

      // Wait for system init message
      const systemInit = await this.waitForSystemInit(streamingId);

      const totalSpawnMs = Date.now() - spawnStartTime;
      logger.info('System init received', { streamingId, totalSpawnMs, waitForInitMs: totalSpawnMs - spawnMs });

      // Store session ID mapping
      this.sessionIds.set(streamingId, systemInit.session_id);

      return { streamingId, systemInit };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Conversation spawn failed', err, {
        streamingId,
        isResume,
        hasMultimodalContent,
        cwd,
        errorCode: error instanceof LatticeError ? error.code : 'INTERNAL_ERROR',
      });
      getEventJournal().record({
        event: 'daemon.conversation_spawn_failed',
        severity: 'error',
        component: 'ProcessDaemon',
        streamingId,
        provider: 'claude',
        message: err.message,
        fields: {
          isResume,
          hasMultimodalContent,
          cwd,
          errorCode: error instanceof LatticeError ? error.code : 'INTERNAL_ERROR',
        },
      });

      // If spawn failed after process creation, terminate it before cleanup
      // so failed starts do not leave orphaned Claude processes running.
      const leakedProcess = this.processes.get(streamingId);
      if (leakedProcess) {
        try {
          logger.warn('Terminating process after spawn failure', {
            streamingId,
            pid: leakedProcess.pid,
            error: error instanceof Error ? error.message : String(error),
          });
          leakedProcess.kill('SIGKILL');
          this.killedProcesses.add(streamingId);
        } catch (killError) {
          logger.warn('Failed to terminate process after spawn failure', {
            streamingId,
            pid: leakedProcess.pid,
            error: killError instanceof Error ? killError.message : String(killError),
          });
        }
      }

      // Cleanup on failure
      this.cleanup(streamingId);
      throw error;
    }
  }

  /**
   * Spawns the Claude CLI with piped stdio. A missing working directory or
   * binary rejects here, for this session only; Node reports a failed spawn
   * as a later 'error' event, which without a listener stops the daemon.
   */
  private async spawnPipedClaude(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ChildProcess & { pid: number }> {
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new LatticeError('WORKING_DIRECTORY_NOT_FOUND', `Working directory does not exist: ${cwd}`, 400);
    }
    const childProcess = spawn(this.requireClaudeExecutable(), args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const spawnError = new Promise<Error>((resolve) => childProcess.once('error', resolve));
    if (childProcess.pid === undefined) {
      const error = await spawnError;
      throw new LatticeError('PROCESS_SPAWN_FAILED', `Failed to spawn Claude process: ${error.message}`, 500);
    }
    return childProcess as ChildProcess & { pid: number };
  }

  /**
   * Optimistic spawn: returns the streamingId immediately after process creation,
   * before waiting for system init. System init completion/failure is broadcast
   * as events so the caller can handle bookkeeping asynchronously.
   *
   * This is used for resume flows where the frontend needs a streamingId
   * immediately to connect SSE and show a live indicator.
   */
  private async handleSpawnOptimistic(params: SpawnParams, owner: net.Socket | null = null): Promise<SpawnOptimisticResult> {
    const { config } = params;
    const isResume = !!config.resumedSessionId;
    const streamingId = randomUUID();
    this.heldStreams.own(streamingId, owner, config.conversationId ?? null);
    const spawnStartTime = Date.now();
    const hasMultimodalContent = !!(config.initialContent && config.initialContent.length > 0);
    const cwd = expandTilde(config.workingDirectory || process.cwd());

    logger.info('Spawning conversation (optimistic)', { streamingId, isResume });

    // Kill any old keep-alive process for the same session before spawning
    if (isResume && config.resumedSessionId) {
      for (const [oldStreamingId, sessionId] of this.sessionIds.entries()) {
        if (sessionId === config.resumedSessionId && this.processes.has(oldStreamingId)) {
          logger.info('Killing old keep-alive process before optimistic resume', {
            oldStreamingId,
            newStreamingId: streamingId,
            sessionId: config.resumedSessionId,
          });
          const oldProc = this.processes.get(oldStreamingId);
          if (oldProc) {
            const idleTimeout = this.idleTimeouts.get(oldStreamingId);
            if (idleTimeout) {
              clearTimeout(idleTimeout);
              this.idleTimeouts.delete(oldStreamingId);
            }
            this.killedProcesses.add(oldStreamingId);
            oldProc.kill('SIGTERM');
          }
        }
      }
    }

    this.conversationConfigs.set(streamingId, config);

    // Spawn the process (same as handleSpawn)
    const args = isResume && config.resumedSessionId
      ? this.buildResumeArgs({ sessionId: config.resumedSessionId, message: config.initialPrompt, permissionMode: config.permissionMode, streamingId, hasMultimodalContent, model: config.model })
      : this.buildStartArgs(config);

    logger.info('Optimistic spawn cwd', { streamingId, configWorkingDirectory: config.workingDirectory, resolvedCwd: cwd });

    const env = {
      ...this.childEnv(),
      ...claudeSpawnEnv(config.model),
      ...silentTurnEnv(config),
      CUI_STREAMING_ID: streamingId,
      PWD: cwd,
      INIT_CWD: cwd,
    };

    let childProcess: ChildProcess & { pid: number };
    try {
      childProcess = await this.spawnPipedClaude(args, cwd, env as NodeJS.ProcessEnv);
    } catch (error) {
      logger.error('Conversation spawn failed (optimistic)', error instanceof Error ? error : new Error(String(error)), {
        streamingId,
        isResume,
        cwd,
        errorCode: error instanceof LatticeError ? error.code : 'INTERNAL_ERROR',
      });
      this.cleanup(streamingId);
      throw error;
    }

    const pipePid = childProcess.pid;
    const managedProcess: ManagedProcess = {
      type: 'pipe',
      child: childProcess,
      pid: pipePid,
      write: (data: string) => childProcess.stdin?.write(data),
      kill: (signal?: NodeJS.Signals) => killProcessGroup(pipePid, signal),
      endStdin: () => childProcess.stdin?.end(),
      inputOpen: () => Boolean(childProcess.stdin && !childProcess.stdin.writableEnded && !childProcess.stdin.destroyed),
    };

    this.processes.set(streamingId, managedProcess);
    this.setupPipedProcessHandlers(streamingId, childProcess);

    this.broadcastEvent({
      event: 'process-spawned',
      data: { streamingId },
    });

    const spawnMs = Date.now() - spawnStartTime;
    logger.info('Process spawned (optimistic)', { streamingId, pid: managedProcess.pid, spawnMs });

    // Send initial content via stdin
    if (hasMultimodalContent && config.initialContent) {
      const contentBlocks = [
        ...config.initialContent,
        ...(config.initialPrompt ? [{ type: 'text' as const, text: config.initialPrompt }] : [])
      ];
      const stdinMessage = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: contentBlocks },
        session_id: config.resumedSessionId || ''
      });
      managedProcess.write(stdinMessage + '\n');
    } else if (config.initialPrompt) {
      const stdinMessage = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: config.initialPrompt }
      });
      managedProcess.write(stdinMessage + '\n');
    }

    // Wait for system init in the background — broadcast result as events
    void this.waitForSystemInit(streamingId).then(
      (systemInit) => {
        const totalSpawnMs = Date.now() - spawnStartTime;
        logger.info('System init received (optimistic)', { streamingId, totalSpawnMs });
        this.sessionIds.set(streamingId, systemInit.session_id);
        this.broadcastEvent({
          event: 'system-init-completed',
          data: { streamingId, systemInit },
        });
      },
      (error) => {
        logger.error('System init failed (optimistic)', error instanceof Error ? error : new Error(String(error)), { streamingId });
        // Broadcast failure so the server can notify the frontend
        this.broadcastEvent({
          event: 'system-init-failed',
          data: {
            streamingId,
            error: error instanceof Error ? error.message : String(error),
            code: error instanceof LatticeError ? error.code : 'SYSTEM_INIT_TIMEOUT',
          },
        });
        // Kill the process if it's still alive
        const leakedProcess = this.processes.get(streamingId);
        if (leakedProcess) {
          try {
            leakedProcess.kill('SIGKILL');
            this.killedProcesses.add(streamingId);
          } catch { /* already dead */ }
        }
        this.cleanup(streamingId);
      }
    );

    // Return immediately — system init will complete asynchronously
    return { streamingId };
  }

  private async handleStop(params: StopParams): Promise<{ success: boolean }> {
    const success = await this.stopConversation(params.streamingId);
    return { success };
  }

  private handleForceKill(params: StopParams): { success: boolean } {
    const success = this.forceKillConversation(params.streamingId);
    return { success };
  }

  private handleInterrupt(params: StopParams): { success: boolean } {
    const success = this.interruptConversation(params.streamingId);
    return { success };
  }

  private handleWrite(params: WriteParams): { success: boolean } {
    const process = this.processes.get(params.streamingId);
    if (!process) {
      logger.warn('handleWrite: process not found', { streamingId: params.streamingId });
      return { success: false };
    }
    // Reject writes to processes that are shutting down (idle timeout or explicit stop)
    if (this.killedProcesses.has(params.streamingId)) {
      logger.warn('handleWrite: process is shutting down, rejecting write', { streamingId: params.streamingId });
      return { success: false };
    }
    if (process.inputOpen && !process.inputOpen()) {
      logger.error('handleWrite: stdin is closed, so the CLI cannot read this; rejecting write', {
        streamingId: params.streamingId,
        messagePreview: params.message.slice(0, 100),
      });
      return { success: false };
    }
    // Cancel idle timeout — process is active again
    this.clearIdleTimeout(params.streamingId);
    logger.info('handleWrite: writing to stdin', {
      streamingId: params.streamingId,
      messageLength: params.message.length,
      messagePreview: params.message.slice(0, 100)
    });
    process.write(params.message + '\n');
    return { success: true };
  }

  private handleSendQuestionAnswer(params: SendQuestionAnswerParams): { success: boolean } {
    const process = this.processes.get(params.streamingId);
    const sessionId = this.sessionIds.get(params.streamingId);

    if (!process || !sessionId) {
      return { success: false };
    }

    // Build the tool result content per SDK docs:
    // { questions: [...], answers: { "Question text?": "Selected label" } }
    const toolResultContent = JSON.stringify({
      questions: params.questions,
      answers: params.answers
    });

    // Format as a tool_result message per Claude CLI stream-json protocol
    const stdinMessage = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: params.toolUseId,
          content: toolResultContent
        }]
      },
      session_id: sessionId,
    });

    process.write(stdinMessage + '\n');
    return { success: true };
  }

  /**
   * Inspect a parsed stdout message; if it's an SDK `control_request` of
   * subtype `can_use_tool`, forward it as a `claude-control-request` IPC
   * event and return true to indicate the message has been handled and
   * should NOT propagate to `handleClaudeMessage` (which would broadcast
   * it to UI clients that aren't expecting control-protocol traffic).
   *
   * Other `control_request` subtypes (e.g. `interrupt`, `mcp_message`)
   * are passed through unchanged for now — the daemon doesn't act on
   * them, but the broadcast lets future server-side handlers observe
   * them. If those subtypes start causing UI noise, narrow this filter.
   */
  private maybeHandleControlRequest(
    streamingId: string,
    message: { type?: string; request_id?: string; request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown>; tool_use_id?: string; decision_reason?: string; decision_reason_type?: string; permission_suggestions?: unknown[] } },
  ): boolean {
    if (message?.type !== 'control_request') {
      return false;
    }
    const inner = message.request;
    if (inner?.subtype !== 'can_use_tool') {
      return false;
    }
    const requestId = message.request_id;
    if (!requestId || !inner.tool_name) {
      logger.warn('Malformed can_use_tool control_request', {
        streamingId,
        hasRequestId: Boolean(requestId),
        hasToolName: Boolean(inner.tool_name),
      });
      return true;
    }

    const eventData: ClaudeControlRequestEventData = {
      streamingId,
      requestId,
      toolName: inner.tool_name,
      toolInput: inner.input ?? {},
      toolUseId: inner.tool_use_id,
      decisionReason: inner.decision_reason,
      decisionReasonType: inner.decision_reason_type,
      permissionSuggestions: inner.permission_suggestions,
    };

    logger.info('Forwarding can_use_tool control_request', {
      streamingId,
      requestId: requestId.slice(0, 8),
      toolName: inner.tool_name,
      decisionReasonType: inner.decision_reason_type,
    });

    this.broadcastEvent({
      event: 'claude-control-request',
      data: eventData as unknown as Record<string, unknown>,
    });
    return true;
  }

  /**
   * Server-initiated RPC: the server has decided how to respond to a
   * `can_use_tool` SDK control request that we previously forwarded.
   * Build the `control_response` envelope per the schema in the Claude
   * Code source (`PermissionPromptToolResultSchema.ts` for `response.response`,
   * remote/RemoteSessionManager.ts:264 for the outer wrapper) and write
   * it to the CLI's stdin.
   */
  private handleRespondToControlRequest(
    params: RespondToControlRequestParams,
  ): { success: boolean } {
    this.heldStreams.answered(params.streamingId, params.requestId);
    const proc = this.processes.get(params.streamingId);
    if (!proc) {
      logger.warn('respondToControlRequest: process not found', { streamingId: params.streamingId });
      return { success: false };
    }
    if (this.killedProcesses.has(params.streamingId)) {
      logger.warn('respondToControlRequest: process is shutting down, dropping response', { streamingId: params.streamingId });
      return { success: false };
    }

    const innerResponse = params.behavior === 'allow'
      ? {
          behavior: 'allow' as const,
          // Empty object is valid per PermissionPromptToolResultSchema; the
          // CLI treats it as "use original tool input" (mobile-client pattern).
          updatedInput: params.updatedInput ?? {},
        }
      : {
          behavior: 'deny' as const,
          message: params.message ?? 'Permission denied by user.',
        };

    const controlResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: params.requestId,
        response: innerResponse,
      },
    };

    proc.write(JSON.stringify(controlResponse) + '\n');
    logger.info('Sent control_response', {
      streamingId: params.streamingId,
      requestId: params.requestId.slice(0, 8),
      behavior: params.behavior,
    });
    return { success: true };
  }

  private async stopConversation(streamingId: string): Promise<boolean> {
    const process = this.processes.get(streamingId);
    if (!process) {
      return false;
    }

    try {
      if (!this.killedProcesses.has(streamingId)) {
        logger.info('Sending SIGTERM to process', { streamingId, pid: process.pid });
        process.kill('SIGTERM');
        this.killedProcesses.add(streamingId);

        const killTimeout = setTimeout(() => {
          try {
            if (this.processes.has(streamingId)) {
              logger.warn('Process not responding to SIGTERM, sending SIGKILL', { streamingId, pid: process.pid });
              process.kill('SIGKILL');
            }
          } catch {
            // Process may have already exited.
          }
        }, 3000);
        const sessionTimeouts = this.timeouts.get(streamingId) || [];
        sessionTimeouts.push(killTimeout);
        this.timeouts.set(streamingId, sessionTimeouts);
      } else {
        logger.warn('Stop requested again for already-stopping process, escalating to SIGKILL', {
          streamingId,
          pid: process.pid,
        });
        process.kill('SIGKILL');
      }

      // Note: cleanup happens in onExit handler, not here
      logger.info('Stop signal sent', { streamingId });
      return true;
    } catch (error) {
      logger.error('Error stopping conversation', error, { streamingId });
      return false;
    }
  }

  private forceKillConversation(streamingId: string): boolean {
    const process = this.processes.get(streamingId);
    if (!process) {
      return false;
    }

    try {
      logger.warn('Force killing process with SIGKILL', { streamingId, pid: process.pid });
      process.kill('SIGKILL');
      this.killedProcesses.add(streamingId);
      return true;
    } catch (error) {
      logger.error('Error force killing conversation', error, { streamingId });
      return false;
    }
  }

  private interruptConversation(streamingId: string): boolean {
    const process = this.processes.get(streamingId);
    if (!process) {
      return false;
    }

    try {
      logger.info('Sending SIGINT to process', { streamingId, pid: process.pid });
      process.kill('SIGINT');
      return true;
    } catch (error) {
      logger.error('Error interrupting conversation', error, { streamingId });
      return false;
    }
  }

  private getActiveSessions(): ActiveSession[] {
    const running: ActiveSession[] = Array.from(this.processes.keys()).map(streamingId => ({
      streamingId,
      sessionId: this.sessionIds.get(streamingId) || '',
      conversationId: this.heldStreams.conversationId(streamingId),
      isIdle: this.idleTimeouts.has(streamingId) || this.idleDeferred.has(streamingId),
      initializing: !this.sessionIds.has(streamingId), // no sessionId yet = still waiting for system init
      exited: false,
    })); // Include all sessions with processes, even those still initializing
    // Exited while no server was attached: listed so the next one collects the ending.
    const exited: ActiveSession[] = this.heldStreams.exitedWaiting().map((streamingId) => ({
      streamingId,
      sessionId: '',
      conversationId: this.heldStreams.conversationId(streamingId),
      isIdle: false,
      initializing: false,
      exited: true,
    }));
    return [...running, ...exited];
  }

  private isSessionActive(streamingId: string): boolean {
    return this.processes.has(streamingId);
  }

  private clearIdleTimeout(streamingId: string): void {
    this.idleDeferred.delete(streamingId);
    const existing = this.idleTimeouts.get(streamingId);
    if (existing) {
      clearTimeout(existing);
      this.idleTimeouts.delete(streamingId);
    }
  }

  /**
   * Arms the timer that ends an idle CLI. It is held back while background tasks
   * run, and pushed past any scheduled wakeup, because ending stdin kills both.
   */
  private scheduleIdleTimeout(streamingId: string): void {
    this.clearIdleTimeout(streamingId);
    const proc = this.processes.get(streamingId);
    if (!proc || this.killedProcesses.has(streamingId)) return;

    const runningTasks = this.backgroundTasks.get(streamingId)?.size ?? 0;
    if (runningTasks > 0) {
      this.idleDeferred.add(streamingId);
      logger.info('Idle timeout deferred: background tasks running', { streamingId, runningTasks });
      return;
    }

    const wakeupAt = this.wakeupDeadlines.get(streamingId) ?? 0;
    const timeoutMs = ProcessDaemon.IDLE_TIMEOUT_MS + Math.max(0, wakeupAt - Date.now());
    const idleTimeout = setTimeout(() => {
      if (this.processes.has(streamingId) && !this.killedProcesses.has(streamingId)) {
        logger.info('Idle timeout reached, terminating process', {
          streamingId,
          pid: proc.pid,
          timeoutMs,
        });
        // Mark as killed BEFORE closing stdin/signaling — prevents race
        // where handleWrite tries to write to a dying process.
        this.killedProcesses.add(streamingId);
        if (proc.endStdin) {
          proc.endStdin();
        } else {
          proc.kill('SIGTERM');
        }
      }
    }, timeoutMs);
    this.idleTimeouts.set(streamingId, idleTimeout);
  }

  /** Tracks the background tasks and scheduled wakeups the CLI reports. */
  private trackPendingWork(streamingId: string, message: StreamEvent): void {
    const m = message as {
      type?: string;
      subtype?: string;
      tasks?: Array<{ task_id?: string }>;
      message?: { content?: unknown };
    };
    if (m.type === 'system' && m.subtype === 'init') {
      // A turn is starting, including one the CLI starts itself when a task
      // finishes or a wakeup fires. The process is no longer idle.
      this.clearIdleTimeout(streamingId);
    } else if (m.type === 'system' && m.subtype === 'background_tasks_changed' && Array.isArray(m.tasks)) {
      const ids = new Set(m.tasks.map((t) => t.task_id).filter((id): id is string => typeof id === 'string'));
      this.backgroundTasks.set(streamingId, ids);
      if (ids.size === 0 && this.idleDeferred.has(streamingId)) this.scheduleIdleTimeout(streamingId);
    } else if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
        if (block.type !== 'tool_use' || block.name !== 'ScheduleWakeup') continue;
        if (block.input?.stop === true) {
          this.wakeupDeadlines.delete(streamingId);
          continue;
        }
        const delaySeconds = Number(block.input?.delaySeconds);
        if (!Number.isFinite(delaySeconds)) continue;
        // The CLI clamps to [60, 3600] and rounds up to the next minute.
        const clamped = Math.min(3600, Math.max(60, delaySeconds)) + 60;
        this.wakeupDeadlines.set(streamingId, Date.now() + clamped * 1000);
      }
    }
  }

  private cleanup(streamingId: string): void {
    this.clearIdleTimeout(streamingId);
    this.closedInputReported.delete(streamingId);
    this.backgroundTasks.delete(streamingId);
    this.wakeupDeadlines.delete(streamingId);
    const timeouts = this.timeouts.get(streamingId);
    if (timeouts) {
      timeouts.forEach((t) => clearTimeout(t));
      this.timeouts.delete(streamingId);
    }

    const managedProcess = this.processes.get(streamingId);
    if (managedProcess?.type === 'pty' && managedProcess.pty?.destroy) {
      try {
        managedProcess.pty.destroy();
      } catch (error) {
        logger.warn('Failed to destroy PTY during cleanup', {
          streamingId,
          pid: managedProcess.pid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.processes.delete(streamingId);
    this.outputBuffers.delete(streamingId);
    this.conversationConfigs.delete(streamingId);
    this.sessionIds.delete(streamingId);
    this.killedProcesses.delete(streamingId);
  }

  // ============================================================================
  // Process Handlers
  // ============================================================================

  /**
   * Setup handlers for PTY-based processes (normal text conversations)
   */
  private setupPtyProcessHandlers(streamingId: string, process: pty.IPty): void {
    const parser = new JsonLinesParser();
    this.outputBuffers.set(streamingId, '');

    parser.on('data', (message: StreamMessage & { message?: { content?: unknown } }) => {
      // SDK control protocol: --permission-prompt-tool stdio routes 'ask'
      // decisions through stdout as control_request messages. Intercept
      // here so they don't leak into the Claude-message broadcast (which
      // would confuse the UI). See `applyPermissionMode` for context.
      if (this.maybeHandleControlRequest(streamingId, message)) {
        return;
      }

      // Skip echoed stdin messages - PTY echoes our input back
      // BUT: tool_result messages are also type: 'user' (Claude API protocol:
      // user = input TO Claude, assistant = output FROM Claude)
      // We need to let tool_result messages through so the UI can update tool status
      if (message.type === 'user') {
        const content = message.message?.content;
        if (!content) {
          return;
        }
        const isToolResult = Array.isArray(content) &&
          content.some((block: { type?: string }) => block.type === 'tool_result');

        if (!isToolResult) {
          // Filter non-tool-result user messages (echoed stdin)
          return;
        }
        // Fall through to emit tool_result messages
        logger.debug('Allowing tool_result message through', {
          streamingId,
          toolResultCount: (content as { type?: string }[]).filter(b => b.type === 'tool_result').length
        });
      }

      this.handleClaudeMessage(streamingId, message as StreamEvent);
    });

    parser.on('error', (error: Error) => {
      this.handleProcessError(streamingId, error);
    });

    process.onData((data: string) => {
      // Strip ANSI escape sequences
      const cleanedData = data.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');
      if (cleanedData.trim()) {
        // Debug: log first chunk to see if we're getting any output
        if (!this.outputBuffers.get(streamingId)) {
          logger.debug('First PTY data received', {
            streamingId,
            dataLength: data.length,
            cleanedLength: cleanedData.length,
            preview: cleanedData.substring(0, 200)
          });
          this.outputBuffers.set(streamingId, 'received');
        }
        parser.write(cleanedData);
      }
    });

    process.onExit(({ exitCode }) => {
      this.handleProcessClose(streamingId, exitCode);
    });
  }

  /**
   * Setup handlers for piped child processes (multimodal with images)
   * No stdin echo filtering needed since pipes don't echo
   */
  private setupPipedProcessHandlers(streamingId: string, childProcess: ChildProcess): void {
    const parser = new JsonLinesParser();
    this.outputBuffers.set(streamingId, '');

    parser.on('data', (message: StreamMessage & { message?: { content?: unknown } }) => {
      // SDK control protocol: --permission-prompt-tool stdio routes 'ask'
      // decisions through stdout as control_request messages. Intercept
      // here so they don't leak into the Claude-message broadcast (which
      // would confuse the UI). See `applyPermissionMode` for context.
      if (this.maybeHandleControlRequest(streamingId, message)) {
        return;
      }

      // Piped processes don't echo stdin, but still filter non-tool-result user messages
      if (message.type === 'user') {
        const content = message.message?.content;
        if (!content) {
          return;
        }
        const isToolResult = Array.isArray(content) &&
          content.some((block: { type?: string }) => block.type === 'tool_result');

        if (!isToolResult) {
          return;
        }
        logger.debug('Allowing tool_result message through (piped)', {
          streamingId,
          toolResultCount: (content as { type?: string }[]).filter(b => b.type === 'tool_result').length
        });
      }

      this.handleClaudeMessage(streamingId, message as StreamEvent);
    });

    parser.on('error', (error: Error) => {
      this.handleProcessError(streamingId, error);
    });

    childProcess.stdout?.on('data', (data: Buffer) => {
      const str = data.toString();
      if (str.trim()) {
        if (!this.outputBuffers.get(streamingId)) {
          logger.debug('First piped stdout data received', {
            streamingId,
            dataLength: str.length,
            preview: str.substring(0, 200)
          });
          this.outputBuffers.set(streamingId, 'received');
        }
        parser.write(str);
      }
    });

    childProcess.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      logger.warn('Claude CLI stderr (piped)', { streamingId, stderr: chunk });
      const existing = this.stderrBuffers.get(streamingId) || '';
      const combined = existing + chunk;
      // Keep only the tail — early crashes fit easily, later verbose output is
      // truncated but the last error is what we care about at close time.
      this.stderrBuffers.set(
        streamingId,
        combined.length > ProcessDaemon.STDERR_BUFFER_MAX
          ? combined.slice(-ProcessDaemon.STDERR_BUFFER_MAX)
          : combined,
      );
    });

    childProcess.on('close', (code) => {
      this.handleProcessClose(streamingId, code);
    });

    childProcess.on('error', (error) => {
      this.handleProcessError(streamingId, error);
    });

    // Writing to a CLI that has exited fails with EPIPE on stdin; the close
    // handler reports the exit, and an unhandled stream error would stop the daemon.
    childProcess.stdin?.on('error', (error) => {
      logger.warn('Claude CLI stdin error', { streamingId, error: error.message });
    });
  }

  private handleClaudeMessage(streamingId: string, message: StreamEvent): void {
    // Self-heal stale `killedProcesses` flag. If we receive output for a
    // streamingId we thought we killed, a signal did not terminate it, and
    // the process can still take input. A process whose stdin was ended can
    // keep producing output (it finishes its background tasks first) but can
    // never read again, so its flag stays: clearing it sent every later
    // message into the closed pipe as a success (2026-09-25).
    const managed = this.processes.get(streamingId);
    if (this.killedProcesses.has(streamingId) && managed?.inputOpen && !managed.inputOpen()) {
      if (!this.closedInputReported.has(streamingId)) {
        this.closedInputReported.add(streamingId);
        logger.warn('CLI still running after its stdin was closed; it cannot take input', {
          streamingId,
          messageType: message?.type,
        });
      }
    } else if (this.killedProcesses.has(streamingId)) {
      logger.warn(
        'Received CLI output from process marked as killed — kill did not take effect, clearing stale flag',
        { streamingId, messageType: message?.type },
      );
      this.killedProcesses.delete(streamingId);
    }

    // Check if this is the system init we're waiting for
    if (message?.type === 'system' && 'subtype' in message && message.subtype === 'init') {
      const initMessage = message as SystemInitMessage;
      const tools = Array.isArray(initMessage.tools) ? initMessage.tools : [];
      logger.info('System init message received', {
        streamingId,
        model: initMessage.model,
        permissionMode: initMessage.permissionMode,
        toolCount: tools.length,
        hasTeamTools: tools.includes('TeamCreate'),
        mcpServerCount: initMessage.mcp_servers?.length || 0,
        mcpServers: initMessage.mcp_servers,
      });
      const pending = this.pendingSystemInits.get(streamingId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingSystemInits.delete(streamingId);
        pending.resolve(initMessage);
      }
    }

    this.trackPendingWork(streamingId, message);

    // Broadcast to all connected clients
    this.broadcastEvent({
      event: 'claude-message',
      data: { streamingId, message },
    });

    // Also emit locally for internal handlers
    this.emit('claude-message', { streamingId, message });

    // Turn complete — keep process alive for follow-up messages via stdin.
    // The CLI stays in persistent stdin-reading mode with --input-format stream-json,
    // so we transition to idle rather than killing. This avoids respawning with
    // --resume on every turn, which replays the full conversation history each time.
    if (message?.type === 'result' && !this.killedProcesses.has(streamingId)) {
      const proc = this.processes.get(streamingId);

      // A failed turn arrives as an ordinary result, so it is otherwise
      // indistinguishable from success and the reason is discarded. The CLI
      // puts the cause in `errors` — e.g. "No conversation found with session
      // ID: …" when resuming a transcript Claude Code has pruned.
      const failed = message as { is_error?: boolean; subtype?: string; errors?: unknown[] };
      if (failed.is_error) {
        // Context goes in the second argument: logger.error() drops a third
        // argument when the second is undefined (see logger.ts).
        logger.error('CLI reported a failed turn', {
          streamingId,
          subtype: failed.subtype,
          errors: Array.isArray(failed.errors) ? failed.errors.map(String) : [],
        });
      }

      if (proc) {
        logger.info('Result received, transitioning to idle (keep-alive)', { streamingId, pid: proc.pid });

        // Broadcast turn-idle to server via IPC
        this.broadcastEvent({
          event: 'turn-idle',
          data: { streamingId },
        });

        // Schedule idle timeout — kill the process if no new message arrives
        this.scheduleIdleTimeout(streamingId);
      }
    }
  }

  private handleProcessClose(streamingId: string, code: number | null): void {
    // Idempotency. A process can reach close via two paths now: the OS-level
    // exit event (pty `onExit` / pipe `close`) and a synthetic close driven by
    // a confirmed-dead signal (see handleInterrupt / killAndCleanup). Whichever
    // runs first calls cleanup(), which deletes the `processes` entry; the other
    // then short-circuits here. Safe against early-exit because `processes` is
    // populated before the exit handlers are attached in every spawn path.
    if (!this.processes.has(streamingId)) {
      logger.debug('handleProcessClose: already handled, skipping', { streamingId, code });
      return;
    }

    // Capture sessionId and pid BEFORE cleanup deletes them
    const sessionId = this.sessionIds.get(streamingId);
    const process = this.processes.get(streamingId);
    const pid = process?.pid;
    const stderr = this.stderrBuffers.get(streamingId);

    // Include stderr tail in the close log so non-zero exits are diagnosable
    // from server.log / daemon.log directly, without cross-referencing the
    // stream of per-chunk stderr warnings above.
    if (code && code !== 0 && stderr && stderr.trim().length > 0) {
      logger.warn('Process closed with non-zero exit; stderr tail included', {
        streamingId,
        code,
        sessionId,
        pid,
        stderrTail: stderr,
      });
    } else {
      logger.info('Process closed', { streamingId, code, sessionId, pid });
    }

    // Reject any pending system init. Include stderr in the error message so
    // the server surface ("process exited before system init") tells the user
    // *why* instead of just that it happened.
    const pending = this.pendingSystemInits.get(streamingId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingSystemInits.delete(streamingId);
      const stderrSuffix = stderr && stderr.trim().length > 0
        ? `: ${stderr.trim().slice(-500)}`
        : '';
      // Claude Code before 2.1.71 has no auto mode, which new workers start in.
      const updateHint = /argument 'auto' is invalid/.test(stderr ?? '')
        ? '. Auto mode needs Claude Code 2.1.71 or later: run `claude update`'
        : '';
      pending.reject(new LatticeError(
        'CLAUDE_PROCESS_EXITED_EARLY',
        `Claude CLI process exited before sending system init (code=${code})${stderrSuffix}${updateHint}`,
        500,
      ));
    }

    this.cleanup(streamingId);
    this.stderrBuffers.delete(streamingId);

    this.broadcastEvent({
      event: 'process-closed',
      data: { streamingId, code, sessionId, pid, stderr },
    });

    this.emit('process-closed', { streamingId, code, sessionId, pid, stderr });
  }

  private handleProcessError(streamingId: string, error: Error): void {
    logger.error('Process error', error, { streamingId });

    this.broadcastEvent({
      event: 'process-error',
      data: { streamingId, error: error.message },
    });

    this.emit('process-error', { streamingId, error: error.message });
  }

  // ============================================================================
  // Argument Building
  // ============================================================================

  private buildBaseArgs(): string[] {
    const args = ['-p'];
    // The skills Lattice ships (agent-skills.ts); the server writes them on start.
    const pluginDir = claudePluginDir();
    if (existsSync(pluginDir)) args.push('--plugin-dir', pluginDir);
    return args;
  }

  private buildResumeArgs(config: { sessionId: string; message: string; permissionMode?: string; streamingId: string; hasMultimodalContent?: boolean; model?: string }): string[] {
    const args = this.buildBaseArgs();

    // Resume message is sent via stdin (not as CLI arg) so that Claude stays
    // in stdin-reading mode for mid-turn message injection.

    args.push(
      '--resume', config.sessionId,
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    );

    // Opus 4.7 defaults thinking display to "omitted" (signature only, empty
    // text). Force summarized so the UI receives readable thinking content.
    // Hidden CLI flag — version/auth-tier gated; probe first to avoid crashing
    // sessions on CLIs that don't recognize it (see supportsThinkingDisplay).
    if (this.supportsThinkingDisplay()) {
      args.push('--thinking-display', 'summarized');
    }

    // Pass model if specified - needed for experimental features like Agent Teams
    if (config.model) {
      args.push('--model', config.model);
    }

    // Apply permission mode
    this.applyPermissionMode(args, config.permissionMode);

    return args;
  }

  /**
   * Apply permission mode flags to CLI args
   * Modes:
   * - "bypassPermissions" (default): Skip all permission prompts (--dangerously-skip-permissions)
   * - "default": Use Claude's default permission behavior (permission prompts)
   * - "acceptEdits": Auto-accept file edits but prompt for other tools
   * - "plan": Plan mode - research only, no edits
   * - "auto": Claude Code's classifier reviews each action and blocks risky
   *   ones; after repeated blocks it falls back to prompting through the bridge.
   *   Claude Code starts in Manual instead when auto is unavailable, so the
   *   init message's `permissionMode` is what the session really runs in.
   *
   * For non-default modes, also installs Lattice as the SDK permission
   * host via `--permission-prompt-tool stdio`. This catches `behavior: 'ask'`
   * decisions that the bypass / acceptEdits / plan paths don't normally
   * surface — most importantly the bypass-immune sensitive-file safety
   * check (`~/.claude/**`, `.git/**`, shell configs) at
   * `permissions.ts:1144` in the Claude Code source. Without this flag,
   * those calls return 'ask' all the way back to the model loop and are
   * silently converted to deny by `toolExecution.ts:995`.
   *
   * `default` (ASK) mode is excluded because Lattice's PreToolUse hook
   * already bridges every tool call to a permission banner; adding
   * SDK-control would cause a double-prompt for sensitive paths.
   */
  private applyPermissionMode(args: string[], permissionMode?: string): void {
    switch (permissionMode) {
      case 'default':
        // Default mode is Claude's built-in ask behavior.
        break;
      case 'acceptEdits':
        args.push('--permission-mode', 'acceptEdits');
        args.push('--permission-prompt-tool', 'stdio');
        break;
      case 'plan':
        args.push('--permission-mode', 'plan');
        args.push('--permission-prompt-tool', 'stdio');
        break;
      case 'auto':
        args.push('--permission-mode', 'auto');
        args.push('--permission-prompt-tool', 'stdio');
        break;
      case 'bypassPermissions':
      default:
        // Default to bypass for backwards compatibility
        args.push('--dangerously-skip-permissions');
        args.push('--permission-prompt-tool', 'stdio');
        break;
    }
  }

  private buildStartArgs(config: ConversationConfig): string[] {
    const args = this.buildBaseArgs();

    // Initial prompt is sent via stdin (not as CLI arg) so that Claude stays
    // in stdin-reading mode for mid-turn message injection.

    args.push(
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    );

    // Opus 4.7 defaults thinking display to "omitted" (signature only, empty
    // text). Force summarized so the UI receives readable thinking content.
    // Hidden CLI flag — version/auth-tier gated; probe first to avoid crashing
    // sessions on CLIs that don't recognize it (see supportsThinkingDisplay).
    if (this.supportsThinkingDisplay()) {
      args.push('--thinking-display', 'summarized');
    }

    if (config.model) {
      args.push('--model', config.model);
    }

    if (config.allowedTools?.length) {
      args.push('--allowedTools', config.allowedTools.join(','));
    }

    if (config.disallowedTools?.length) {
      args.push('--disallowedTools', config.disallowedTools.join(','));
    }

    // Add system prompt with Lattice environment info and personality profile
    const latticeEnvInfo = `
## Lattice Orchestrator Environment

You are running inside the Lattice orchestrator dashboard.

**Server logs** (for debugging issues):
- \`${path.join(CONFIG_DIR, 'logs', 'server.jsonl')}\` - Express server logs
- \`${path.join(CONFIG_DIR, 'logs', 'daemon.log')}\` - Process daemon logs

**Canonical session API** (for launching/managing Lattice sessions):
- Start new unified session: \`POST /api/conv/create\` with \`{ provider, message, workingDirectory, permissionMode?, workspace? }\`
- Default \`permissionMode\` to \`"bypassPermissions"\` (trust mode) unless the parent session uses ask mode
- Continue existing unified session: \`POST /api/conv/:conversationId/resume\`
- Switch provider in-place: \`POST /api/conv/:conversationId/switch\`
- Resolve legacy IDs first: \`GET /api/conv/resolve/:id\`
- Prefer \`/api/conv/*\` over legacy \`/api/conversations/start\` for new orchestration flows
`;
    const personalityProfile = this.loadPersonalityProfile();
    const systemPromptParts = [
      config.systemPrompt,
      latticeEnvInfo,
      personalityProfile,
      config.sessionIndexBlock,
    ].filter(Boolean);
    const systemPrompt = systemPromptParts.join('\n');
    // Appended, not replacing: `--system-prompt` dropped Claude Code's own prompt
    // (tool guidance, care with commits) from every Lattice session. Resume passes
    // nothing because Claude Code keeps the first spawn's prompt in the transcript.
    args.push('--append-system-prompt', systemPrompt);

    // Apply permission mode
    this.applyPermissionMode(args, config.permissionMode);

    return args;
  }

  /**
   * Load the personality profile for injection into the system prompt.
   * Returns formatted markdown section or empty string if no profile exists.
   */
  private loadPersonalityProfile(userId: string = 'default'): string {
    try {
      const profilePath = path.join(CONFIG_DIR, 'users', userId, 'personality.md');
      if (!existsSync(profilePath)) {
        logger.debug('No personality profile found', { userId, profilePath });
        return '';
      }

      const content = fs.readFileSync(profilePath, 'utf-8');
      // Extract just the items, skip header and empty sections
      const lines = content.split('\n');
      const relevantLines: string[] = [];
      let hasItems = false;

      for (const line of lines) {
        if (line.startsWith('## ')) {
          if (hasItems) {
            relevantLines.push(''); // Add spacing between sections
          }
          hasItems = false;
          relevantLines.push(line);
        } else if (line.startsWith('- [')) {
          hasItems = true;
          relevantLines.push(line);
        } else if (line.startsWith('_(No items yet)_')) {
          // Remove the section header we just added if it has no items
          if (relevantLines.length > 0 && relevantLines[relevantLines.length - 1].startsWith('## ')) {
            relevantLines.pop();
          }
        }
      }

      if (relevantLines.length === 0) {
        return '';
      }

      logger.debug('Loaded personality profile', { userId, itemCount: relevantLines.filter(l => l.startsWith('- [')).length });

      return `
## User Psychological Profile

The following profile has been developed through reflection on past interactions. Use this to calibrate your communication style, anticipate preferences, and build on the established working relationship.

${relevantLines.join('\n')}
`;
    } catch (error) {
      logger.warn('Failed to load personality profile', { userId, error });
      return '';
    }
  }

  // ============================================================================
  // System Init Waiting
  // ============================================================================

  private waitForSystemInit(streamingId: string): Promise<SystemInitMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSystemInits.delete(streamingId);
        reject(new LatticeError('SYSTEM_INIT_TIMEOUT', 'Timeout waiting for system initialization from Claude CLI', 500));
      }, 180000);

      this.pendingSystemInits.set(streamingId, { resolve, reject, timeout });
    });
  }

}

/**
 * Claude Code answers a turn that ends with no text by asking the model to
 * "produce a user-visible response", which turns a coordinator's deliberate
 * silence into a note about the silence. It skips that nudge when the turn's
 * last tool call succeeded and is named in CLAUDE_CODE_TERMINAL_MCP_TOOLS;
 * a coordinator's silent turn ends on a Bash call to the lattice CLI.
 */
function silentTurnEnv(config: ConversationConfig): Record<string, string> {
  return config.coordinator ? { CLAUDE_CODE_TERMINAL_MCP_TOOLS: 'Bash' } : {};
}
