/**
 * Minimal type definitions for the toolkit.
 *
 * These are structurally compatible with Lattice's types — consumers can
 * pass their richer types and TypeScript's structural typing handles the rest.
 */

export interface ToolResult {
  status: 'pending' | 'completed';
  result?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface DisplayContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  messageId: string;
  type: 'user' | 'assistant' | 'system' | 'error';
  content: string | DisplayContentBlock[];
  timestamp: string;
  workingDirectory?: string;
  parentToolUseId?: string;
}

export interface QuestionOption {
  label: string;
  /** What choosing it sets in motion, shown under the label. */
  description?: string;
  /** The asker's suggestion. Claude marks it instead with a "(Recommended)" suffix on the label. */
  recommended?: boolean;
}

export interface QuestionDefinition {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

/** Callback-based renderer for consumer-defined tool cards. */
export type CustomToolRenderer = (props: {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  isPending: boolean;
  toolUseId?: string;
  workingDirectory?: string;
  isStreaming?: boolean;
}) => React.ReactNode | null;

/** Background task output shape for BashTool polling. */
export interface BackgroundTaskOutput {
  content: string;
  size: number;
  truncated: boolean;
}

/** Where a background command stands, taken from the session's task events. */
export type BackgroundTaskState = 'running' | 'finished' | 'lost';
