/**
 * The lifecycle of one inline ask, shared between the responder hook that
 * drives it and the card that renders it.
 *
 * There is no 'done' state: once the answer is persisted the exchange is just
 * an answered row like any other, and the card renders from storage. Keeping a
 * terminal success state would mean two sources of truth for the same text.
 */

export type AskStatus =
  /** Writing the exchange row, before anything has been sent. */
  | 'creating'
  /** Exchange row exists; resolving and reaching the responder session. */
  | 'connecting'
  /** The question is with the session; its answer is arriving. */
  | 'streaming'
  /** Turn finished; writing the answer back to the exchange. */
  | 'saving'
  /** Nothing further will arrive for this ask. The exchange stays unanswered. */
  | 'error';

export interface LiveAsk {
  /** Null only while status is 'creating' — the row does not exist yet. */
  exchangeId: string | null;
  question: string;
  quote: string;
  quoteStart: number | null;
  status: AskStatus;
  /** Answer text as it streams. Empty until the session starts replying. */
  answer: string;
  error: string | null;
}

/** Chrome label per state. Sentence case, per the visual language. */
export const ASK_STATUS_LABEL: Record<AskStatus, string> = {
  creating: 'Asking',
  connecting: 'Reaching session',
  streaming: 'Answering',
  saving: 'Saving',
  error: 'Failed',
};
