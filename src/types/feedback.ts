/**
 * Feedback sent from a Lattice to the feedback collector, and the inbox the
 * collector's owner reads it in. Shared by the server and the web app.
 *
 * The wire contract with the collector (field names, limits, error codes) is
 * pinned in the lattice-feedback-collector README; the payload here is exactly
 * what POST /v1/feedback accepts. The request is authorised by the install
 * key the collector issued when the user passed its one-time check.
 */

export const FEEDBACK_CATEGORIES = ['bug', 'suggestion', 'other'] as const;
export type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number];

export const FEEDBACK_SCREENS = ['home', 'conversation', 'settings', 'cli', 'other'] as const;
export type FeedbackScreen = typeof FEEDBACK_SCREENS[number];

export type FeedbackSource = 'human' | 'agent';
export type FeedbackScope = 'app' | 'session';
export type FeedbackProvider = 'claude' | 'codex' | 'other';

/** Unicode code points, as the collector counts them. */
export const FEEDBACK_MESSAGE_MAX = 6000;

/** The fields the collector stores, in the order the digest hashes them. */
export interface FeedbackPayload {
  schema_version: 1;
  submission_id: string;
  install_id: string;
  source: FeedbackSource;
  category: FeedbackCategory;
  message: string;
  scope: FeedbackScope;
  screen: FeedbackScreen;
  session_ref: string | null;
  lattice_version: string;
  provider: FeedbackProvider | null;
  model: string | null;
}

export interface FeedbackReceipt {
  id: string;
  receivedAt: string;
}

export interface FeedbackSendError {
  code: string;
  message: string;
  at: string;
}

/** A draft as the browser sees it: what will be sent, and to where. */
export interface FeedbackDraftView {
  id: string;
  source: FeedbackSource;
  category: FeedbackCategory;
  message: string;
  scope: FeedbackScope;
  conversationId: string | null;
  /** Bumped by every edit; a send names the revision the user reviewed. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** The collector this draft was made for. */
  collectorOrigin: string;
  /** False when the destination has changed since: it can only be deleted. */
  sendable: boolean;
  payload: FeedbackPayload;
  lastError: FeedbackSendError | null;
}

export interface FeedbackStatus {
  enabled: boolean;
  /** The collector base URL in use, the build's default unless overridden. */
  collectorUrl: string;
  collectorOrigin: string | null;
  /** Why the configured URL cannot be used, when it cannot. */
  collectorProblem: string | null;
  pendingDrafts: number;
  pendingAgentDrafts: number;
  /** Whether this Lattice has a feedback inbox (a read-token file). */
  inbox: boolean;
  /**
   * Whether this install holds a key for the current destination, from the
   * one-time check. Without one, sending first asks for the check.
   */
  registered: boolean;
}

/** What the one-time check needs: the install it registers and where. */
export interface FeedbackRegistration {
  installId: string;
  collectorOrigin: string;
}

/**
 * An agent's proposal as its card in the chat shows it: waiting, with the
 * draft, or what became of it.
 */
export type FeedbackProposalView =
  | { state: 'pending'; draft: FeedbackDraftView }
  | { state: 'sent'; category: FeedbackCategory; message: string; at: string }
  | { state: 'rejected'; at: string }
  | { state: 'gone' };

/** Written into the chat's event log when an agent proposes feedback; UI only. */
export const FEEDBACK_PROPOSED_EVENT = 'feedback:proposed';

export interface FeedbackProposedData {
  draftId: string;
  /** The session that proposed it: this chat's own, or one of its workers. */
  from: string;
  /** That worker's title when the card sits in its coordinator's chat. */
  workerTitle: string | null;
}

/** What a new draft would carry besides the text: shown before sending. */
export interface FeedbackContext {
  installId: string;
  latticeVersion: string;
  collectorOrigin: string;
  scope: FeedbackScope;
  sessionRef: string | null;
  provider: FeedbackProvider | null;
  model: string | null;
}

export interface FeedbackSendResult {
  sent: boolean;
  receipt?: FeedbackReceipt;
  duplicate?: boolean;
  error?: FeedbackSendError;
  draft?: FeedbackDraftView;
}

// -- Inbox -------------------------------------------------------------------

export type FeedbackClassificationState = 'pending' | 'classified' | 'failed';

export interface FeedbackInboxItem {
  id: string;
  receivedAt: string;
  source: FeedbackSource;
  category: FeedbackCategory;
  message: string;
  scope: FeedbackScope;
  screen: string;
  sessionRef: string | null;
  installId: string;
  latticeVersion: string;
  provider: string | null;
  model: string | null;
  classificationState: FeedbackClassificationState;
  offTopic: boolean | null;
  abusive: boolean | null;
  classificationReason: string | null;
  readAt: string | null;
  doneAt: string | null;
}

export type FeedbackInboxView = 'unread' | 'all' | 'flagged';

export interface FeedbackInboxResponse {
  items: FeedbackInboxItem[];
  counts: { unread: number; all: number; flagged: number };
  lastRefreshAt: string | null;
  /** The last refresh's failure, cleared by the next success. */
  refreshError: string | null;
}
