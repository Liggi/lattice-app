/**
 * The cross-project Inbox (`GET /api/inbox`): everything across the user's
 * open sessions that is waiting on them or has gone wrong, in one list. The
 * server builds it (`services/sessions/inbox-feed.ts`); the Inbox page draws it.
 */

export type InboxItemKind = 'decision' | 'call' | 'stalled-job' | 'failed-run' | 'failing-pr';
export type InboxGlyphKind = 'decision' | 'failed' | 'stalled' | 'waiting';
/** What the human has to supply on an ask (`decision` or `call`), following Ash Fleet's five request kinds. */
export const INBOX_REQUEST_KINDS = ['go-ahead', 'decision', 'review', 'access', 'info'] as const;
export type InboxRequestKind = (typeof INBOX_REQUEST_KINDS)[number];

export interface InboxMetric {
  label: string;
  value: string;
  tone?: 'worse' | 'better' | 'neutral';
}

export interface InboxOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/** Inline content shown inside an Inbox item so the user can decide or review cold without opening chat. */
export interface InboxArtifact {
  kind: 'message' | 'text' | 'image' | 'table';
  /** Short plain label naming the artifact (e.g. "Draft", "Trade-offs", "Layout comparison"). */
  label: string;
  /** Quiet metadata line (e.g. "Slack DM to Sam Patel", "2 screenshots"). */
  meta?: string;
  /** Verbatim text for `message` or `text` artifacts. */
  body?: string;
  /** Whether the user can edit `body` inline before approving (e.g. an outgoing draft message). */
  editable?: boolean;
  /** Preview images for `image` artifacts (1 to 3). */
  images?: Array<{ src: string; caption?: string }>;
  /** Compact aligned comparison table for numeric trade-offs (avoids burying numbers in prose). */
  table?: {
    columns: string[];
    rows: Array<{ label: string; values: string[] }>;
  };
}

export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  /** What the user needs to supply when `kind` is `decision` or `call`. */
  requestKind?: InboxRequestKind;
  glyph: InboxGlyphKind;
  priority: boolean;
  /** Short cost-of-waiting reason when `priority` is true (e.g. "Blocks 2 workers"). */
  priorityReason?: string | null;
  conversationId: string;
  projectTitle: string;
  title: string;
  reason: string;
  /** Legacy free-text detail; rendered when structured `context` bullets are not supplied. */
  detail?: string | null;
  /** Two to four concise cold-read facts so the item makes sense without reading the chat history. */
  context?: string[];
  /** Compact aligned metric rows (avoids burying numbers and deltas in prose). */
  metrics?: InboxMetric[];
  /** Inline draft, snippet or visual artifact to judge in place. */
  artifact?: InboxArtifact | null;
  /** Quiet one-line reason a person is needed rather than the agent acting on its own. */
  whyHuman?: string | null;
  /** What the agent will do if unanswered, and when. */
  ifUnanswered?: string | null;
  since: number;
  href?: string;
  /** On a failing pull request: its repo's short name, number and failed checks (empty when not read). */
  pr?: { repo: string; number: number; failedChecks: string[] };
  action?:
    | {
        kind: 'decision';
        decisionId: string;
        question: string;
        options: InboxOption[];
        threadSeq?: number;
        canPark?: boolean;
      }
    | {
        kind: 'thread';
        threadSeq: number;
        question: string;
        askText?: string | null;
        canPark: boolean;
        canDismiss: boolean;
      }
    | {
        kind: 'retry';
        errorMessage: string;
        circuitBroken?: boolean;
      }
    | {
        kind: 'open';
        label: string;
      };
}

export interface InboxFeedResponse {
  items: InboxItem[];
  priorityCount: number;
  totalCount: number;
  generatedAt: number;
}
