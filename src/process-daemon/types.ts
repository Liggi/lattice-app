/**
 * IPC Protocol Types for Process Daemon
 *
 * Communication between lattice-server and process-daemon uses JSON-RPC style
 * messages over a Unix socket.
 */

import { ConversationConfig, SystemInitMessage, StreamEvent } from '../types/index.js';
import type { LoginAttemptState, LoginTerminalSize } from './claude-login-terminal.js';

// ============================================================================
// IPC Message Types
// ============================================================================

/** Request from client to daemon */
export interface IPCRequest {
  id: number;
  method: 'spawn' | 'spawnOptimistic' | 'stop' | 'forceKill' | 'interrupt' | 'write' | 'list' | 'isActive' | 'sendQuestionAnswer' | 'respondToControlRequest'
    | LoginTerminalMethod;
  params: Record<string, unknown>;
}

/** Response from daemon to client */
export interface IPCResponse {
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
}

/** Event pushed from daemon to all connected clients (no id) */
export interface IPCEvent {
  event: 'claude-message' | 'process-closed' | 'process-error' | 'process-spawned' | 'turn-idle'
    | 'system-init-completed' | 'system-init-failed' | 'claude-control-request'
    | 'login-terminal-output' | 'login-terminal-state';
  data: Record<string, unknown>;
}

// ============================================================================
// Spawn Command Types
// ============================================================================

export interface SpawnParams {
  config: ConversationConfig & { resumedSessionId?: string };
}

export interface SpawnResult {
  streamingId: string;
  systemInit: SystemInitMessage;
}

export interface SpawnOptimisticResult {
  streamingId: string;
}

// ============================================================================
// Stop Command Types
// ============================================================================

export interface StopParams {
  streamingId: string;
}

// ============================================================================
// Write Command Types (for stdin)
// ============================================================================

export interface WriteParams {
  streamingId: string;
  message: string;
}

// ============================================================================
// SendQuestionAnswer Command Types
// ============================================================================

export interface SendQuestionAnswerParams {
  streamingId: string;
  toolUseId: string;
  questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
  answers: Record<string, string>;
}

// ============================================================================
// List Command Types
// ============================================================================

// ============================================================================
// IsActive Command Types
// ============================================================================

export interface IsActiveParams {
  streamingId: string;
}

// ============================================================================
// RespondToControlRequest Command Types
// ============================================================================

/**
 * Sent by the server back to the daemon after the user (or hook) decides
 * how to handle a `can_use_tool` SDK control request that the daemon
 * forwarded via the `claude-control-request` event.
 *
 * On `behavior: 'allow'`, `updatedInput` is sent verbatim back to the
 * Claude CLI as the tool's input (typically the original input).
 * On `behavior: 'deny'`, `message` is what the model sees as the
 * tool_result error.
 */
export interface RespondToControlRequestParams {
  streamingId: string;
  requestId: string;
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

// ============================================================================
// Claude login terminal (see claude-login-terminal.ts)
//
// Its payloads are kept apart from conversation stdin and stream events on
// purpose: nothing that handles these may log, journal or persist them.
// ============================================================================

export type LoginTerminalMethod =
  | 'loginTerminalStart'
  | 'loginTerminalAttach'
  | 'loginTerminalInput'
  | 'loginTerminalResize'
  | 'loginTerminalState'
  | 'loginTerminalCancel';

export interface LoginTerminalStartParams {
  size?: Partial<LoginTerminalSize>;
  /** End a running attempt and begin a fresh one. */
  restart?: boolean;
}

export interface LoginTerminalStartResult {
  attemptId: string;
  state: LoginAttemptState;
  reused: boolean;
}

export interface LoginTerminalAttachParams {
  attemptId: string;
}

export interface LoginTerminalAttachResult {
  state: LoginAttemptState;
  output: string;
  outputEnd: number;
}

export interface LoginTerminalInputParams {
  attemptId: string;
  clientId: string;
  seq: number;
  data: string;
}

export interface LoginTerminalInputResult {
  accepted: boolean;
  lastSeq: number;
}

export interface LoginTerminalResizeParams {
  attemptId: string;
  size: Partial<LoginTerminalSize>;
}

export interface LoginTerminalOutputEventData {
  attemptId: string;
  data: string;
  offset: number;
}

export interface LoginTerminalStateEventData {
  attemptId: string;
  state: LoginAttemptState;
}

// ============================================================================
// Event Data Types
// ============================================================================

export interface ClaudeMessageEventData {
  streamingId: string;
  message: StreamEvent;
}

/**
 * Forwarded by the daemon when the Claude CLI emits a
 * `{type: 'control_request', request: {subtype: 'can_use_tool', ...}}`
 * SDK control message on stdout.
 *
 * This only fires when the CLI is spawned with `--permission-prompt-tool stdio`.
 * The most common trigger in Lattice is a sensitive-file edit
 * (`~/.claude/**`, `.git/**`, etc.) in `bypassPermissions` mode: the
 * binary's safety check is bypass-immune and routes through the SDK
 * control protocol rather than auto-allowing.
 *
 * The server is expected to reach a decision (typically by surfacing
 * a permission banner via `PermissionTracker`) and respond via the
 * `respondToControlRequest` RPC. If no response arrives, the CLI
 * eventually times out and treats the tool call as denied.
 */
export interface ClaudeControlRequestEventData {
  streamingId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
  decisionReason?: string;
  decisionReasonType?: string;
  permissionSuggestions?: unknown[];
}

export interface ProcessClosedEventData {
  streamingId: string;
  code: number | null;
  sessionId?: string;
  pid?: number;
  /**
   * Tail of the CLI's stderr (capped to ~4KB) if anything was emitted before
   * the process closed. Useful for diagnosing non-zero exits without having
   * to cross-reference per-chunk stderr warnings in daemon.log.
   */
  stderr?: string;
}

export interface ProcessErrorEventData {
  streamingId: string;
  error: string;
}

// ============================================================================
// Daemon Configuration
// ============================================================================

export interface DaemonConfig {
  socketPath: string;
  claudeExecutablePath?: string;
  envOverrides?: Record<string, string | undefined>;
}

export const DEFAULT_SOCKET_PATH = '/tmp/lattice-daemon.sock';
