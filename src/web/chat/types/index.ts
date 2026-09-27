import type { FeedbackProposedData } from '@/types/feedback';
import type { DecisionAskedData } from '@/types/decisions';
import type { Provider } from '@/types/unified-messages';
import type { WorkerStartedData, WorkerReassignedData, WorkerAnsweredData, WorkerReportedData, WorkerReportSummaryData, WorkerMovedData } from '@/types/worker-events';
// Re-export necessary types from backend
import type {
  ConversationSummary,
  ConversationMessage,
  StartConversationRequest,
  StartConversationResponse,
  ConversationDetailsResponse,
  StreamEvent,
  AssistantStreamMessage,
  UserStreamMessage,
  ResultStreamMessage,
  SystemInitMessage,
  SystemCompactBoundaryMessage,
  CompactStartingEvent,
  PermissionRequest,
  PermissionDecisionRequest,
  PermissionDecisionResponse,
  InteractiveQuestionRequest,
  QuestionDefinition,
  QuestionOption,
  PersistedPendingQuestion,
  FileSystemEntry,
  FileSystemListQuery,
  FileSystemListResponse,
  CommandsResponse,
  // Session insights types - imported from canonical source
  SessionContext,
  SessionTags,
  SessionInsights,
  // Session review types
  Recommendation,
  StoredRecommendation,
  // Next steps types
  NextStepProposal,
} from '@/types';

// Import ContentBlock from Anthropic SDK
import type { ContentBlock, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';


/**
 * Loose content block type for frontend display.
 * The Anthropic SDK's ContentBlock requires strict fields (e.g., citations on TextBlock)
 * that aren't always present in locally-constructed objects. This type allows partial
 * content blocks while keeping the discriminated union shape for rendering.
 */
export type DisplayContentBlock = ContentBlock | {
  type: string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
};

export type {
  ConversationSummary,
  ConversationMessage,
  StartConversationRequest,
  StartConversationResponse,
  ConversationDetailsResponse,
  StreamEvent,
  AssistantStreamMessage,
  UserStreamMessage,
  ResultStreamMessage,
  SystemInitMessage,
  SystemCompactBoundaryMessage,
  CompactStartingEvent,
  PermissionRequest,
  PermissionDecisionRequest,
  PermissionDecisionResponse,
  InteractiveQuestionRequest,
  QuestionDefinition,
  QuestionOption,
  PersistedPendingQuestion,
  FileSystemEntry,
  FileSystemListQuery,
  FileSystemListResponse,
  CommandsResponse,
  // Session insights types - re-exported from canonical source
  SessionContext,
  SessionTags,
  SessionInsights,
  // Session review types
  Recommendation,
  StoredRecommendation,
  // Next steps types
  NextStepProposal,
};

// Re-export Anthropic SDK types for multimodal support
export type { ContentBlockParam };

// Frontend-friendly aliases retained for compatibility with existing components.
export type QuestionRequest = InteractiveQuestionRequest;
export type PendingQuestion = PersistedPendingQuestion;

// Dev notes (quick issue/todo capture)
export interface DevNote {
  id: string;
  content: string;
  priority: 'low' | 'normal' | 'high';
  status: 'pending' | 'done' | 'dismissed';
  projectPath: string | null;
  createdAt: string;
}

// Chat-specific types
export interface Command {
  name: string;
  type: 'builtin' | 'custom';
  description?: string;
  argumentHint?: string;
}
/**
 * Who sent a message that is not the user's own. `sender` is what the sending
 * conversation declared (`session send --from`); null means it declared
 * nothing, which is shown as unidentified rather than as anyone. `passedOn`
 * is the sender's claim that it is relaying the user's decision.
 */
export interface MessageAttribution {
  sender: string | null;
  passedOn: boolean;
}

export interface ConversationChatMessage {
  id: string; // Backend message ID (may not be unique, empty for pending user messages)
  messageId: string; // Client-side unique ID for React rendering
  type: 'user' | 'assistant' | 'system' | 'error';
  content: string | DisplayContentBlock[];
  timestamp: string;
  workingDirectory?: string; // Working directory when the message was created
  parentToolUseId?: string; // For nested messages from Task tool use
  provider?: Provider; // Which AI provider this message is from/to
  systemSubtype?: 'compact_boundary' | 'compact_starting' | 'worker' | 'feedback' | 'decision';
  /** Heading for an error message; 'Error' when absent. */
  errorTitle?: string;
  /** Present when another agent sent this message; absent on the user's own. */
  attribution?: MessageAttribution;
  /** Set when systemSubtype is 'worker': a coordinator's record of a worker it dispatched. */
  workerEvent?: {
    type: 'worker:started' | 'worker:reassigned' | 'worker:answered' | 'worker:reported' | 'worker:moved';
    data: WorkerStartedData | WorkerReassignedData | WorkerAnsweredData | WorkerReportedData | WorkerMovedData;
    /**
     * The card's readable summary of a report. Absent until it is written,
     * and for good whenever it was not — the card then shows the report.
     */
    reportSummary?: WorkerReportSummaryData;
  };
  /** Set when systemSubtype is 'feedback': an agent's feedback proposal, shown as a card to send. */
  feedbackProposal?: FeedbackProposedData;
  /** Set when systemSubtype is 'decision': an agent's question to the user (`lattice ask`), shown as a card to answer. */
  decision?: DecisionAskedData;
  /** Set on the user's message that is their answer to one of those questions. */
  decisionAnswer?: { decisionId: string; inboxId: string };
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
    costUsd?: number;
  };
  // isStreaming removed
}

// Backward-compatible alias while call sites migrate.
export type ChatMessage = ConversationChatMessage;

export interface Theme {
  mode: 'light' | 'dark';
  toggle: () => void;
  colorScheme: 'light' | 'dark' | 'system';
}

export interface ApiError {
  error: string;
  code?: string;
}


// Working directories types
export interface WorkingDirectory {
  path: string;              // Full absolute path
  shortname: string;         // Smart suffix
  lastDate: string;          // ISO timestamp
  conversationCount: number; // Total conversations
}

export interface WorkingDirectoriesResponse {
  directories: WorkingDirectory[];
  totalCount: number;
}

export interface Preferences {
  colorScheme: 'light' | 'dark' | 'system';
  language: string;
  notifications?: {
    enabled: boolean;
    ntfyUrl?: string;
  };
}

// Tool result types
export interface ToolResult {
  status: 'pending' | 'completed';
  result?: string | ContentBlockParam[];
  is_error?: boolean;
}

// Mini action for rolling ticker display
export interface MiniAction {
  tool: string;
  timestamp: number;
}

// Termination reason for turns
export type TerminationReason =
  | 'normal_completion'   // Exit 0 - Claude finished cleanly
  | 'user_stop'           // Exit 143 - User clicked Stop (SIGTERM)
  | 'force_killed'        // Exit 137 - Force killed (SIGKILL)
  | 'process_crash';      // Other non-zero - Unexpected exit

// Turn = one user message + Claude's response (captured by turn-capture-service)
export interface Turn {
  id: string;
  sessionId: string;
  turnNumber: number;
  timestamp: string;
  headline: string;      // User intent, very short
  actions: string[];     // What Claude did
  tag: string;           // decision, fix, pivot, discovery, friction, etc.
  icon: string;          // Emoji for display
  exitCode: number | null;
  terminationReason: TerminationReason;  // Why the turn ended
  toolCount: number;
  incomplete: boolean;   // Did Claude finish or get cut off?
}

// Stream status types for live updates
export interface StreamStatus {
  streamingId?: string;
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'error';
  lastEvent?: StreamEvent;
  lastEventTime?: string;
  currentStatus: string;
  toolMetrics?: {
    linesAdded: number;
    linesRemoved: number;
    editCount: number;
    writeCount: number;
  };
}

/**
 * Work that will wake a session without the user typing anything: a background
 * command, a subagent, a workflow, or a scheduled wakeup.
 *
 * Re-exported from the deriving module rather than mirrored, so a new kind
 * there is a compile error in every place the UI enumerates them (the
 * composer's status wording, for one) instead of a silent fall-through.
 */
import type { PendingWork } from '@/harness/derive-pending-work.js';
import type { RunFailure } from '@/harness/derive-session-status.js';
import type { NeedsYouItem } from '@/services/sessions/project-needs-you.js';
export type { PendingWork, RunFailure, NeedsYouItem };

// Unified sidebar conversation shape from /api/conv list endpoint
export interface UnifiedConversationSummary {
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * When the conversation was last actually used, from its newest harness
   * event. Prefer this over `updatedAt` for recency — `updatedAt` only moves on
   * the legacy /resume route and segment changes, so for most conversations it
   * never leaves creation time. Optional: payloads from older servers omit it.
   */
  lastActivityAt?: string;
  /** When it was archived, from the archived list; null when not recorded. Optional: other lists omit it. */
  archivedAt?: string | null;
  workingDirectory: string;
  workspace?: string;
  teamName?: string | null;
  teamRole?: string | null;
  latestProvider: Provider;
  providersUsed?: Array<Provider>;
  activeProvider?: Provider | null;
  segmentCount: number;
  status: 'ongoing' | 'idle' | 'completed' | 'pending';
  /**
   * Set while the session is idle but still holding work that will resume on
   * its own. Optional: payloads from older servers omit it.
   */
  pendingWork?: PendingWork | null;
  /**
   * A context compaction is in flight for this conversation. Merged from the
   * status poll client-side; optional because list payloads omit it.
   */
  compacting?: boolean;
  /**
   * The latest turn or run ended in an error (a usage limit, a crash). Merged
   * from the status poll client-side; null once new work starts.
   */
  failure?: RunFailure | null;
  /**
   * On a project: the threads Jev judges need the user now, highest first.
   * Merged from the status poll; empty when none clear the bar.
   */
  projectNeedsYou?: NeedsYouItem[];
  /** On a project: its Working on line, without thread references. Merged from the status poll. */
  projectWorkingOn?: string | null;
  /** On a project: each worker's task, the name its right-panel card carries. Merged from the status poll. */
  projectWorkerTasks?: Record<string, string> | null;
  /** When a scheduled wake-up fires, epoch ms. Merged from the status poll. */
  wakeAt?: number | null;
  streamingId: string | null;
  customName: string;
  /**
   * A project's generated title, written from the outcome its coordinator
   * agreed rather than from the transcript, so it does not move as the tasks
   * underneath it change. Null on ordinary sessions, on projects with no
   * agreed outcome yet, and on servers that predate the field.
   */
  projectName?: string | null;
  pinned: boolean;
  archived: boolean;
  pausedReason: string | null;
  importedAt: string | null;
  permissionMode: string | null;
  identityImage: string | null;
  pinCharacterName?: string | null;
  pinCharacterImage?: string | null;
  /** First ~300 chars of the first user message — a list-projection preview; the full text lives on the detail route. */
  initialPromptPreview: string | null;
  /** Coordinator this session was picked up from as a worker; null for a session the user started. Optional: older servers omit it. */
  pickedUpFrom?: string | null;
  /** Started as `front`, the coordinator persona. Optional: older servers omit it. */
  coordinator?: boolean;
  insights?: SessionInsights;
  liveStatus?: StreamStatus;
}
