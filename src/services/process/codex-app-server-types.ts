export type CodexGoalStatus = 'active' | 'paused' | 'budgetLimited' | 'complete';

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: CodexGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexThread {
  id: string;
  sessionId?: string;
  preview?: string;
  modelProvider?: string;
  cwd?: string;
  status?: unknown;
  turns?: CodexTurn[];
}

export interface CodexThreadStartResponse {
  thread: CodexThread;
  model: string;
  modelProvider: string;
  cwd: string;
  reasoningEffort: string | null;
  approvalPolicy?: unknown;
}

export interface CodexThreadResumeResponse extends CodexThreadStartResponse {}

export interface CodexTurn {
  id: string;
  status?: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error?: {
    message?: string;
    additionalDetails?: string | null;
    codexErrorInfo?: unknown;
  } | null;
  durationMs?: number | null;
}

export interface CodexTurnStartResponse {
  turn: CodexTurn;
}

/** `turn/steer` answers with the turn the input joined; it never creates one. */
export interface CodexTurnSteerResponse {
  turnId: string;
}

export type CodexThreadCompactStartResponse = Record<string, never>;

export interface CodexThreadGoalSetResponse {
  goal: CodexThreadGoal;
}

export interface CodexThreadGoalGetResponse {
  goal: CodexThreadGoal | null;
}

export interface CodexThreadGoalClearResponse {
  cleared: boolean;
}

export interface CodexTextUserInput {
  type: 'text';
  text: string;
  text_elements: [];
}

export interface CodexImageUserInput {
  type: 'image';
  url: string;
  detail?: 'auto' | 'low' | 'high' | 'original' | null;
}

export interface CodexLocalImageUserInput {
  type: 'localImage';
  path: string;
  detail?: 'auto' | 'low' | 'high' | 'original' | null;
}

export type CodexUserInput = CodexTextUserInput | CodexImageUserInput | CodexLocalImageUserInput;

export type CodexRequestId = string | number;

export interface CodexServerRequest {
  id: CodexRequestId;
  method: string;
  params?: unknown;
}

/** One file touched by a `fileChange` item, carrying a unified diff. */
export interface CodexFileUpdateChange {
  path?: string;
  diff?: string;
}

/** The MCP call result, in the transport's own envelope. */
export interface CodexMcpToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

export type CodexThreadItem =
  | { type: 'agentMessage'; id: string; text?: string; phase?: string | null }
  | { type: 'reasoning'; id: string; summary?: string[]; content?: string[] }
  | { type: 'contextCompaction'; id: string }
  | {
      type: 'commandExecution';
      id: string;
      command?: string;
      cwd?: string;
      status?: string;
      aggregatedOutput?: string | null;
      exitCode?: number | null;
      durationMs?: number | null;
    }
  | { type: 'fileChange'; id: string; status?: string; changes?: CodexFileUpdateChange[] }
  | {
      type: 'mcpToolCall';
      id: string;
      server?: string;
      tool?: string;
      status?: string;
      /** JSON-encoded tool input. Present on both item/started and item/completed. */
      arguments?: string | null;
      result?: CodexMcpToolResult | null;
      error?: unknown;
      durationMs?: number | null;
      appContext?: unknown;
      pluginId?: string | null;
    }
  | { type: 'dynamicToolCall'; id: string; namespace?: string | null; tool?: string; status?: string; success?: boolean | null; contentItems?: unknown[] | null }
  | { type: string; id?: string; [key: string]: unknown };

export type CodexServerNotification =
  | { method: 'thread/started'; params: { thread: CodexThread } }
  | { method: 'thread/status/changed'; params: { threadId: string; status: unknown } }
  | { method: 'thread/goal/updated'; params: { threadId: string; turnId: string | null; goal: CodexThreadGoal } }
  | { method: 'thread/goal/cleared'; params: { threadId: string } }
  | { method: 'thread/tokenUsage/updated'; params: { threadId: string; turnId: string; tokenUsage: CodexThreadTokenUsage } }
  | { method: 'turn/started'; params: { threadId: string; turn: CodexTurn } }
  | { method: 'turn/completed'; params: { threadId: string; turn: CodexTurn } }
  | { method: 'item/started'; params: { threadId: string; turnId: string; item: CodexThreadItem; startedAtMs: number } }
  | { method: 'item/completed'; params: { threadId: string; turnId: string; item: CodexThreadItem; completedAtMs: number } }
  | { method: 'item/agentMessage/delta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'account/rateLimits/updated'; params: unknown }
  | { method: 'mcpServer/startupStatus/updated'; params: unknown }
  | { method: 'error'; params: CodexErrorNotificationParams }
  | { method: string; params?: unknown };

/**
 * The app-server's `error` notification. Its payload is `error` / `willRetry`,
 * never a top-level `message` — reading `params.message` is why every one of
 * these surfaced as the same detail-free placeholder.
 *
 * `error` is typed loosely because the wire shape is not pinned down: the
 * `TurnError` object below is what the protocol's other error carriers use, but
 * a bare string is also plausible. The adapter logs the raw payload so the next
 * occurrence settles it from evidence rather than guesswork.
 */
export interface CodexErrorNotificationParams {
  error?: string | {
    message?: string;
    additionalDetails?: string | null;
    codexErrorInfo?: unknown;
  } | null;
  willRetry?: boolean;
  threadId?: string;
  turnId?: string | null;
  [key: string]: unknown;
}

export interface CodexThreadTokenUsage {
  total?: CodexTokenUsageBreakdown;
  last?: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface CodexTokenUsageBreakdown {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: unknown | null;
  secondary: unknown | null;
  credits: unknown | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface CodexAccountRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null;
}

export interface CodexAccountReadResponse {
  account: unknown | null;
  requiresOpenaiAuth: boolean;
}
