/**
 * Unified Message Types
 *
 * A common message format that Claude, Codex, and opencode events can be
 * normalized into. This enables a unified UI that can render messages from
 * any provider.
 */

// =============================================================================
// PROVIDER IDENTIFICATION
// =============================================================================

export type Provider = 'claude' | 'codex' | 'opencode';

// =============================================================================
// UNIFIED CONTENT BLOCKS
// =============================================================================

/** Text content from the assistant */
export interface UnifiedTextBlock {
  type: 'text';
  text: string;
}

/** Thinking/reasoning content (Codex reasoning, Claude thinking) */
export interface UnifiedThinkingBlock {
  type: 'thinking';
  text: string;
}

/** Tool/command being used */
export interface UnifiedToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Result from a tool/command */
export interface UnifiedToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  output: string;
  isError?: boolean;
  exitCode?: number | null;
}

/** Code being displayed or edited */
export interface UnifiedCodeBlock {
  type: 'code';
  language?: string;
  code: string;
  filename?: string;
}

/** Shared media source format for image/document user content */
export interface UnifiedMediaSource {
  type: 'base64' | 'url';
  media_type: string;
  data?: string;
  url?: string;
}

/** Image attachment (typically user-provided) */
export interface UnifiedImageBlock {
  type: 'image';
  source: UnifiedMediaSource;
}

/** Document attachment (typically user-provided PDF) */
export interface UnifiedDocumentBlock {
  type: 'document';
  source: UnifiedMediaSource;
}

export type UnifiedContentBlock =
  | UnifiedTextBlock
  | UnifiedThinkingBlock
  | UnifiedToolUseBlock
  | UnifiedToolResultBlock
  | UnifiedCodeBlock
  | UnifiedImageBlock
  | UnifiedDocumentBlock;

// =============================================================================
// UNIFIED MESSAGES
// =============================================================================

export interface UnifiedMessage {
  id: string;
  provider: Provider;
  role: 'user' | 'assistant' | 'system';
  content: UnifiedContentBlock[];
  timestamp: string;

  // Provider-specific IDs for resumption
  providerMessageId?: string;

  // Usage stats (if available)
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };

  // Optional metadata for UI (e.g., thinking duration)
  metadata?: {
    thoughtMs?: number;
    thoughtBlocks?: number;
  };

  // Context transfer boundary marker
  // When set, indicates that context was transferred to another provider up to this message
  contextBoundary?: {
    transferredTo: Provider;
    transferredAt: string;
    transferId: string;  // Links to context_transfers audit table
  };
}

// =============================================================================
// UNIFIED SESSION
// =============================================================================

// =============================================================================
// STREAMING EVENTS
// =============================================================================

/** Approval request from Codex app-server for interactive approval mode */
export interface ApprovalRequestData {
  requestId: string | number;
  approvalType: 'command' | 'file_change';
  command?: string;
  cwd?: string;
  reason?: string;
  grantRoot?: string;
}

export interface UnifiedNextStepProposal {
  label: string;
  prompt: string;
  icon?: string;
  description?: string;
}
