export const AMBIENT_AGENT_NAME = 'Argus';

/** Batch runtime status as narrowed by the frontend status client. */
export type SessionStatus = 'completed' | 'ongoing' | 'idle' | 'pending';

/**
 * Presentation-level runtime state for the art header. Superset of SessionStatus:
 * the backend status route can return 'stopping' even though the frontend client
 * type omits it, and the portfolio adds its own 'paused' / 'needs-you' states.
 */
export type RuntimeStatus =
  | 'ongoing'
  | 'pending'
  | 'stopping'
  | 'idle'
  | 'completed'
  | 'paused'
  | 'needs-you';

export type AmbientFlag = 'drift' | 'stuck' | 'overlap';

/**
 * The one thing that determines whether the user can push a thread forward.
 * your-move: an act only the user can do. waiting-on: blocked on something external.
 * working: the meaningful checkpoint the agent is advancing. nothing-pending:
 * finished, nothing to do. Working text may be empty when no distinct
 * checkpoint would add useful context.
 */
export type ArrowKind = 'your-move' | 'waiting-on' | 'working' | 'nothing-pending';

export interface AmbientArrow {
  kind: ArrowKind;
  text: string;
}

/** What kind of work dominated the recent activity — drives the header word and art. */
export type AmbientMode =
  | 'exploring'
  | 'researching'
  | 'investigating'
  | 'designing'
  | 'building'
  | 'debugging'
  | 'verifying'
  | 'writing-up'
  | 'operating';

/** What the thread ships when done. Derived from clustering real sessions (ontology-lab). */
export type AmbientDeliverable = 'ships' | 'design' | 'assessment' | 'answer' | 'record';

export type AmbientMarker = 'risky';

export interface AmbientRead {
  sessionId: string;
  /** Newest meaningful evidence timestamp represented by the generated fields. */
  sourceBoundaryTs?: number;
  /** User/goal revision represented by the stable description. */
  sourceDescriptionSeq?: number;
  /** Lifecycle/activity revision represented by the relationship line. */
  sourceArrowSeq?: number;
  /** The thread's durable purpose and intended outcome, not its latest method. */
  context: string;
  /** Scanner judgment used to preserve context across non-pivot user messages. */
  contextChanged?: boolean;
  arrow: AmbientArrow;
  /** Which area of the user's work the thread belongs to. */
  portfolio: string;
  workArea: string | null;
  mode: AmbientMode | string;
  deliverable: AmbientDeliverable | string;
  /** The concrete current obstacle, at most six words; null when the work flows. */
  snag: string | null;
  /**
   * A drafted reply the user could send to this session to make their move —
   * only on your-move arrows whose act happens inside the session.
   * Optional: absent in payloads written before scan v3.3.
   */
  suggestedNext?: string | null;
  /** Sparse portfolio-relative markers, hard-budgeted in the scan. */
  markers: Array<{ marker: AmbientMarker; why: string }>;
  flag: AmbientFlag | null;
  /** One-sentence flag explanation; null when flag is null. */
  flagLine: string | null;
  evidence: Array<{ quote: string; seq: number }>;
}

export interface AmbientPayload {
  generatedAt: string;
  model: string;
  promptVersion: string;
  agentName: string;
  reads: AmbientRead[];
}

export type Verdict = 'right' | 'wrong' | 'missed';

export interface StoredVerdict {
  readId: string;
  sessionId: string;
  verdict: Verdict;
  flag: string;
  note?: string;
  at: string;
}

export const VERDICT_STORAGE_KEY = 'ambient-verdicts-v0';
