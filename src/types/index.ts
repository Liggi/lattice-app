// Core types and interfaces for CUI backend
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';

// Re-export ContentBlockParam for frontend use
export type { ContentBlockParam };

// =============================================================================
// BRANDED ID TYPES
// =============================================================================
//
// These branded types prevent accidentally mixing up the two session identifiers.
// This is the #1 source of agent confusion in this codebase.
//
// ClaudeSessionId: Claude CLI's permanent identifier
//   - Persists across resumes
//   - Used for: history files, database storage, --resume flag
//   - Example: stored in ~/.claude/projects/<hash>/<sessionId>.jsonl
//
// ConversationId: Unified conversation identifier (conv-*)
//   - Stable across provider switches inside one conversation
//   - Used for: frontend routing, unified APIs, cross-provider metadata
//
// StreamingId: Claudia's ephemeral per-run identifier
//   - New UUID generated on each start/resume
//   - Used for: SSE streams, process management, real-time tracking
//   - Only valid while process is running
//
// One ClaudeSessionId can have many StreamingIds over its lifetime:
//   Session abc123 (permanent)
//     ├── Run 1: streamingId = xyz789 (started, stopped)
//     ├── Run 2: streamingId = def456 (resumed, stopped)
//     └── Run 3: streamingId = ghi012 (currently running)
//
// =============================================================================

/** Claude CLI's permanent session identifier. Persists across resumes. */
export type ClaudeSessionId = string & { readonly __brand: 'ClaudeSessionId' };

/** Unified conversation identifier (conv-*). Stable across provider switches. */
export type ConversationId = string & { readonly __brand: 'ConversationId' };

/** Claudia's ephemeral streaming identifier. New on each start/resume. */
export type StreamingId = string & { readonly __brand: 'StreamingId' };

/**
 * Create a ClaudeSessionId from a raw string.
 * Use when receiving session IDs from Claude CLI or database.
 */
export function asClaudeSessionId(id: string): ClaudeSessionId {
  return id as ClaudeSessionId;
}

/**
 * Create a StreamingId from a raw string.
 * Use when generating new streaming IDs or receiving from process manager.
 */
export function asStreamingId(id: string): StreamingId {
  return id as StreamingId;
}

/**
 * Truncate any session ID for logging (first 8 chars).
 * Works with both ClaudeSessionId and StreamingId.
 */
export function truncateId(id: string | ClaudeSessionId | ConversationId | StreamingId): string {
  return id.slice(0, 8);
}

// Re-export all insight-related types from canonical source
export * from './insights.js';

// Import for local use within this file
import type { SessionInsights } from './insights.js';
import type { Provider } from './unified-messages.js';

// Tool metrics types
export interface ToolMetrics {
  linesAdded: number;
  linesRemoved: number;
  editCount: number;
  writeCount: number;
}

export interface AnthropicHealthResponse {
  status: 'healthy' | 'unhealthy';
  message: string;
  apiKeyValid: boolean;
}

// Base conversation types
export interface ConversationSummary {
  providerSessionId: string; // Provider session identifier (Claude session_id or Codex thread/session id)
  projectPath: string;
  summary: string;
  sessionInfo: SessionInfo; // Complete session metadata from SessionInfoService
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalDuration: number;
  model: string;
  status: 'completed' | 'ongoing' | 'pending'; // Conversation status based on active streams
  streamingId?: string; // CUI's internal streaming ID (only present when status is 'ongoing')
  toolMetrics?: ToolMetrics; // Optional tool usage metrics
  insights?: SessionInsights; // Cached session insights (progress, tasks, theme)
}

export interface ConversationMessage {
  uuid: string;
  type: 'user' | 'assistant' | 'system';
  message: Anthropic.Message | Anthropic.MessageParam;
  timestamp: string;
  sessionId: string; // Claude CLI's actual session ID
  provider?: Provider; // Source provider for unified sessions
  parentUuid?: string;
  isSidechain?: boolean; // Whether this message is part of a sidechain conversation
  userType?: string; // Type of user interaction (e.g., 'external')
  cwd?: string; // Working directory when the message was created
  version?: string; // Claude CLI version used for this message
  durationMs?: number;
}

// Stream message types
export interface StreamMessage {
  type: 'system' | 'assistant' | 'user' | 'result';
  session_id: string; // Claude CLI's session ID (in stream messages)
}

export interface SystemInitMessage extends StreamMessage {
  type: 'system';
  subtype: 'init';
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string; }[];
  model: string;
  permissionMode: string;
  apiKeySource: string;
}

export interface SystemCompactBoundaryMessage extends StreamMessage {
  type: 'system';
  subtype: 'compact_boundary';
  compact_metadata?: {
    trigger?: 'auto' | 'manual' | string;
    pre_tokens?: number;
  };
}

export interface CompactStartingEvent {
  type: 'compact_starting';
  streamingId: string;
  sessionId?: string;
  trigger?: 'auto' | 'manual' | string;
  timestamp: string;
}

export interface AssistantStreamMessage extends StreamMessage {
  type: 'assistant';
  message: Anthropic.Message;
  parent_tool_use_id?: string;
}

export interface UserStreamMessage extends StreamMessage {
  type: 'user';
  message: Anthropic.MessageParam;
  parent_tool_use_id?: string;
}

export interface ResultStreamMessage extends StreamMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns';
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result?: string;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    server_tool_use: {
      web_search_requests: number;
    };
  };
}

// Permission types
export interface PermissionRequest {
  id: string;
  streamingId: string; // CUI's internal streaming identifier
  sessionId?: string;
  conversationId?: string; // Unified conversation ID (conv-*), resolved at query time
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: string;
  status: 'pending' | 'approved' | 'denied';
  modifiedInput?: Record<string, unknown>;
  denyReason?: string;
  /** Why the provider asked, in its own words (Claude Code's `decisionReason`). */
  reason?: string;
  /**
   * The coordinator (`conv-*`) that decides this request because the asking
   * session is its worker. Until it escalates, the user is not asked.
   */
  coordinator?: string;
  /** Set when the coordinator handed the decision to the user, with its reason. */
  escalation?: { why: string; at: string };
}

// Question types (for AskUserQuestion tool)
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionDefinition {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface InteractiveQuestionRequest {
  id: string;
  streamingId: string;
  toolUseId: string; // Claude's tool_use ID for correlating the answer
  questions: QuestionDefinition[];
  timestamp: string;
  status: 'pending' | 'answered';
  answers?: Record<string, string>; // Keyed by question index or header
}

// Pending question - persisted across browser disconnects/server restarts
export interface PersistedPendingQuestion {
  id: string;
  sessionId: string;       // Claude session ID (for --resume)
  conversationId?: string; // Unified conversation ID (conv-*), resolved at query time
  streamingId: string;     // CUI streaming ID
  toolUseId: string;       // Original tool_use ID
  questions: QuestionDefinition[];
  createdAt: string;
  status: 'pending' | 'answered' | 'expired';
  answers?: Record<string, string>;
  answeredAt?: string;
  resumedStreamingId?: string;  // Streaming ID of the resumed session
}

// Next steps proposal - Claude can propose next directions at end of response
export interface NextStepProposal {
  label: string;           // Button text (1-5 words)
  prompt: string;          // Full prompt to send when clicked
  description?: string;    // Tooltip/hover text explaining this option
  icon?: string;           // Lucide icon name (e.g., "Play", "GitCommit", "TestTube")
}

// Configuration types
export interface ConversationConfig {
  workingDirectory: string;
  initialPrompt: string;
  initialContent?: ContentBlockParam[]; // Multimodal content (images, documents) - sent via stdin
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  /**
   * Lattice-managed session-index block injected into the agent's system prompt
   * so it's aware of past sessions on this machine. Built by
   * SessionSummaryService.buildSystemPromptIndexBlock; concatenated into the
   * --system-prompt arg by process-daemon. Distinct from `systemPrompt`
   * (caller-supplied) — Lattice owns this one.
   */
  sessionIndexBlock?: string;
  claudeExecutablePath?: string;
  /**
   * The session is a coordinator, for which a turn ending with no text is the
   * normal case; process-daemon switches off Claude Code's nudge for one.
   */
  coordinator?: boolean;
  /** The Lattice conversation the process is for, so a later server can take it over. */
  conversationId?: string;
  previousMessages?: ConversationMessage[]; // Messages from previous session for resume context
  permissionMode?: string; // Permission mode: "acceptEdits" | "bypassPermissions" | "default" | "plan"
}

// API request/response types
export interface StartConversationRequest {
  workingDirectory: string;
  initialPrompt: string;
  userMessage?: string; // Optional display message stored in history (when initialPrompt includes hidden transfer context)
  initialContent?: ContentBlockParam[]; // Multimodal content (images, documents) - sent via stdin
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  permissionMode?: string; // Permission mode: "acceptEdits" | "bypassPermissions" | "default" | "plan"
  resumedSessionId?: string; // Optional: session ID to resume from
  workspace?: string; // Workspace this session belongs to (default: 'main')
  traceId?: string; // Optional: correlates provider switch/session events for debugging
}


export interface StartConversationResponse {
  streamingId: string; // CUI's internal streaming identifier for managing streaming connections
  streamUrl: string;
  // System init fields from Claude CLI
  sessionId: string; // Claude CLI's session ID
  cwd: string; // Working directory
  tools: string[]; // Available tools
  mcpServers: { name: string; status: string; }[]; // MCP server list
  model: string; // Actual model being used
  permissionMode: string; // Permission handling mode
  apiKeySource: string; // API key source
}

export interface ConversationListQuery {
  projectPath?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'created' | 'updated';
  order?: 'asc' | 'desc';
  hasContinuation?: boolean;
  archived?: boolean;
  pinned?: boolean;
  workspace?: string;
}

export interface ConversationDetailsResponse {
  sessionId?: string; // The session ID
  messages: ConversationMessage[];
  summary: string;
  projectPath: string;
  metadata: {
      totalDuration: number;
    model: string;
  };
  toolMetrics?: ToolMetrics; // Optional tool usage metrics
  status?: 'completed' | 'ongoing' | 'pending'; // Session status (ongoing if currently streaming)
  streamingId?: string; // CUI streaming ID (only present when status is 'ongoing')
  sessionInfo?: SessionInfo; // Session metadata including branch lineage
  // Pagination fields
  totalMessages?: number; // Total message count (when paginated)
  hasMore?: boolean; // Whether there are older messages to load
  oldestMessageId?: string; // ID of oldest message in this batch (cursor for loading more)
  deduplication?: {
    storesMerged: number;
    duplicateMessagesDropped: number;
    uniqueMessages: number;
  };
  // Branch children (sessions that branched from this one)
  branchChildren?: Array<{ childSessionId: string; atTurn: number }>;
  // For branch sessions: the message ID marking the branch point (server-computed)
  branchPointMessageId?: string;
  /** Started as `front`, the coordinator persona; its thread folds its own tool use behind the worker blocks. */
  coordinator?: boolean;
  /**
   * The coordinator conversation this one was picked up from, i.e. it is a
   * worker. Carried here as well as on the list row because an archived
   * worker is a normal destination from a report link but is not in the
   * active list the sidebar holds.
   */
  pickedUpFrom?: string | null;
  /**
   * Codex reasoning effort the latest segment is recorded as running at.
   * Absent when nothing was ever recorded, which is not the same as a default:
   * the composer shows its own default entry in that case.
   */
  reasoningEffort?: string;
  // Proposed next steps from Claude's last response (displayed as clickable pills)
  proposedNextSteps?: NextStepProposal[];
  // MCP servers connected to this session
  mcpServers?: Array<{ name: string; status: string }>;
}


export interface PermissionDecisionRequest {
  /** `escalate` is the coordinator handing its worker's request to the user. */
  action: 'approve' | 'deny' | 'escalate';
  modifiedInput?: Record<string, unknown>;
  denyReason?: string;
  /** The deciding coordinator (`conv-*`); must match the request's coordinator. Absent when the user decides. */
  from?: string;
  /** With `escalate`: one sentence telling the user why it is theirs to decide. */
  why?: string;
}

export interface PermissionDecisionResponse {
  success: boolean;
  message?: string;
}

export interface SystemStatusResponse {
  claudeVersion: string;
  claudePath: string;
  configPath: string;
  activeConversations: number;
  anthropicConfigured: boolean;
}

// Stream event types
export type StreamEvent =
  | { type: 'connected'; streamingId: string; streaming_id?: string; timestamp: string }
  | { type: 'permission_request'; data: PermissionRequest; streamingId: string; timestamp: string }
  | { type: 'question_request'; data: InteractiveQuestionRequest; streamingId: string; timestamp: string }
  | { type: 'next_steps'; steps: NextStepProposal[]; streamingId: string; sessionId: string; timestamp: string }
  | CompactStartingEvent
  | { type: 'error'; error: string; streamingId: string; timestamp: string }
  | { type: 'closed'; streamingId: string; timestamp: string }
  | { type: 'session_end'; sessionId?: string; provider?: Provider; streamingId?: string; timestamp?: string }
  | SystemInitMessage
  | SystemCompactBoundaryMessage
  | AssistantStreamMessage
  | UserStreamMessage
  | ResultStreamMessage;

// Error types
export class LatticeError extends Error {
  constructor(public code: string, message: string, public statusCode: number = 500) {
    super(message);
    this.name = 'LatticeError';
  }
}

// File system types
export interface FileSystemEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  lastModified: string;
}

export interface FileSystemListQuery {
  path: string;
  recursive?: boolean;
  respectGitignore?: boolean;
}

export interface FileSystemListResponse {
  path: string;
  entries: FileSystemEntry[];
  total: number;
}

export interface FileSystemReadQuery {
  path: string;
}

export interface FileSystemReadResponse {
  path: string;
  content: string;
  size: number;
  lastModified: string;
  encoding: string;
}

// Termination reason for sessions
export type TerminationReason =
  | 'normal_completion'   // Exit 0 - Claude finished cleanly
  | 'user_stop'           // Exit 143 - User clicked Stop (SIGTERM)
  | 'force_killed'        // Exit 137 - Force killed (SIGKILL)
  | 'process_crash';      // Other non-zero - Unexpected exit

// Session Info Database types for lowdb
export interface SessionInfo {
  custom_name: string;          // Custom name for the session, default: ""
  created_at: string;           // ISO 8601 timestamp when session info was created
  updated_at: string;           // ISO 8601 timestamp when session info was last updated
  version: number;              // Schema version for future migrations
  pinned: boolean;              // Whether session is pinned, default: false
  archived: boolean;            // Whether session is archived, default: false
  continuation_session_id: string; // ID of the continuation session if exists, default: ""
  initial_commit_head: string;  // Git commit HEAD when session started, default: ""
  permission_mode: string;      // Permission mode used for the session, default: "default"
  identity_image?: string;      // Base64-encoded PNG visual identity (80x150), generated once on first insights
  pin_character_name?: string;  // Persistent character name, generated on first Pro pin
  pin_character_image?: string; // Base64-encoded 256x256 PNG portrait, retained across unpin/re-pin
  last_termination_reason?: TerminationReason; // Why the last turn ended (for sidebar display)
  branched_from_session_id?: string; // ID of parent session if this was branched
  branched_at_turn?: number;    // Turn number in parent session where branch was made
  workspace: string;            // Workspace this session belongs to, default: 'main'
  proposed_next_steps?: NextStepProposal[]; // Proposed next directions from Claude's last response
  team_name?: string;           // Name of the team this session leads (Agent Teams integration)
  team_role?: string;           // Role in the team ('lead' for team lead sessions)
  paused_reason?: string;       // User-written reason for pausing session (empty/undefined = not paused)
  conversation_id?: string;     // Unified conversation ID (conv-*) this session belongs to
  project_name?: string;        // Generated title for a coordinator's project; custom_name still wins when set
  slept_at?: string;            // When the user put it to sleep by hand; cleared when its next turn starts
  mcp_servers?: Array<{ name: string; status: string }>; // MCP servers connected at session start
  imported_at?: string;         // ISO timestamp if this session was imported (read-only)
  last_turn_usage?: TurnUsage;  // Token usage from the most recent turn
}

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}


// API types for session update
export interface SessionUpdateRequest {
  customName?: string;           // Optional: update custom name
  pinned?: boolean;              // Optional: update pinned status
  archived?: boolean;            // Optional: update archived status
  continuationSessionId?: string; // Optional: update continuation session
  initialCommitHead?: string;    // Optional: update initial commit head
  permissionMode?: string;       // Optional: update permission mode
  workspace?: string;            // Optional: update workspace
  pausedReason?: string | null;  // Optional: set pause reason (null to unpause)
  slept?: boolean;               // Optional: put to sleep by hand (true) or take it back (false)
}

// Notification types
export interface Notification {
  title: string;
  message: string;
  priority: 'min' | 'low' | 'default' | 'high' | 'urgent';
  tags: string[];
  sessionId: string;
  streamingId: string;
  permissionRequestId?: string;
}

// Working directories API types
export interface WorkingDirectory {
  path: string;              // Full absolute path (e.g., "/home/user/projects/myapp")
  shortname: string;         // Smart suffix (e.g., "myapp" or "projects/myapp")
  lastDate: string;          // ISO timestamp of most recent conversation
  conversationCount: number; // Total conversations in this directory
}

export interface WorkingDirectoriesResponse {
  directories: WorkingDirectory[];
  totalCount: number;
}

// Commands API types
export interface Command {
  name: string;
  type: 'builtin' | 'custom';
  description?: string;
  argumentHint?: string;
}

export interface CommandsResponse {
  commands: Command[];
}

// =============================================================================
// SESSION REVIEW TYPES
// =============================================================================
// Shared types for session analysis/review (used by both API and frontend)

/**
 * Target types for recommendations - specifies where/how to action the recommendation.
 */
export type RecommendationTarget = 'project_instructions' | 'global_instructions' | 'codebase';

/**
 * Capability types for review-generated items.
 * Each maps to a distinct ID prefix used when generating review results.
 *
 * - 'skill': Claude Code skills (SKILL.md files), prefix: "skill-"
 * - 'guardrail': Concrete automation (tests, pre-commit hooks), prefix: "guardrail-"
 * - 'recommendation': General recommendations (instructions or codebase changes), prefix: "rec-"
 */
export type ReviewItemType = 'skill' | 'guardrail' | 'recommendation';

/**
 * Maps review item ID prefixes to their capability types.
 * Used for ID generation in session-review-service and validated by tests
 * to ensure new types are explicitly mapped.
 */
export const REVIEW_ITEM_ID_PREFIXES: Record<ReviewItemType, string> = {
  skill: 'skill',
  guardrail: 'guardrail',
  recommendation: 'rec',
} as const;

/**
 * A recommendation from session review analysis.
 * These are suggestions for Claude improvements based on session friction points.
 */
export interface Recommendation {
  id: string;
  /** Where this recommendation should be actioned */
  target: RecommendationTarget;
  /** Original improvement type from review analysis */
  improvementType?: 'codebase' | 'investigation' | 'workflow';
  /** What went wrong or was inefficient (1 sentence) */
  friction: string;
  /** Specific action to take - concrete enough to execute */
  action: string;
  /** Why this helps future sessions (1 sentence) */
  rationale: string;
}

/**
 * Stored recommendation (from database) with session context and status.
 */
export interface StoredRecommendation {
  id: string;
  sessionId: string;
  /** Where this recommendation should be actioned */
  target: RecommendationTarget;
  /** Original improvement type from review analysis */
  improvementType?: 'codebase' | 'investigation' | 'workflow';
  /** What went wrong or was inefficient */
  friction: string;
  /** Specific action to take */
  action: string;
  /** Why this helps future sessions */
  rationale: string;
  status: 'accepted' | 'dismissed' | 'completed';
  createdAt: string;
  actionedAt?: string;
  /** Project path for project_instructions recommendations (null for global/codebase if unknown) */
  projectPath?: string | null;
  /** User-provided note/clarification when accepting */
  userNote?: string | null;
  /** Human-readable project name from session insights (e.g., "Lattice", "Analyst") */
  sourceProject?: string | null;
  /** Session mission/goal from session insights */
  sourceMission?: string | null;
}

export * from './config.js';
