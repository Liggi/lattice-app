/**
 * Types for the read-only session history surface (CLI + HTTP).
 *
 * Distinct from the runtime harness types in `src/harness/` — those describe
 * live event capture; these describe browsing past sessions.
 */

export type EventType =
  | 'input:sent'
  | 'content'
  | 'result'
  | 'run:start'
  | 'run:ready'
  | 'run:end'
  | 'run:error'
  | 'turn:end'
  | 'task:started'
  | 'task:updated'
  | 'task:notification'
  | 'stop:requested'
  | 'compact:starting'
  | string;

export interface RawEvent {
  conversationId: string;
  seq: number;
  runId: string;
  timestamp: number;
  type: EventType;
  data: unknown;
  meta: unknown;
}

export interface SessionMetadata {
  conversationId: string;
  customName: string | null;
  workspace: string | null;
  archived: boolean;
  createdAt: string | null;
  /** Write clock. Rarely moves — prefer `lastActivityAt` for "when was this used". */
  updatedAt: string | null;
  /** Timestamp of the newest harness event; null when the session has none. */
  lastActivityAt: string | null;
  /** Model the last run reported, from the event log rather than the DB row. */
  model: string | null;
  initialPrompt: string | null;
  workingDirectory: string | null;
  latestProvider: string | null;
  /** Coordinator conversation this one was picked up from, when it is a worker. */
  pickedUpFrom: string | null;
}

/** Insight-engine categories, when a session has been categorized. */
export interface SessionCategories {
  primary: string | null;
  secondary: string[];
  theme: string | null;
}

export interface SessionSummaryRow {
  conversationId: string;
  project: string | null;
  title: string | null;
  summary: string | null;
  notable: string | null;
  tags: string[];
  filesTouched: string[];
  eventCount: number | null;
  startedAt: string | null;
  endedAt: string | null;
  status: string;
  generatorModel: string | null;
  generatedAt: string | null;
}

export interface SessionListItem {
  conversationId: string;
  customName: string | null;
  archived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivityAt: string | null;
  model: string | null;
  eventCount: number;
  summary: SessionSummaryRow | null;
}

export interface ToolCall {
  seq: number;
  name: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
  /** matching result event seq if present */
  resultSeq: number | null;
}

export interface TranscriptLine {
  seq: number;
  /**
   * Last seq folded into this line when consecutive events were joined. Codex
   * emits one content event per streamed token, so a single sentence can span
   * hundreds of seqs.
   */
  endSeq?: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export interface UsageTotals {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  turnCount: number;
}
