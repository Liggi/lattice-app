/**
 * What the server writes into a coordinator's log when a message reaches it
 * mid-turn and is routed to the fast responder. Shared by the server (writer) and the web client (the
 * fast reply renders as the coordinator's message with a marker).
 *
 *   `coordinator:routed  { inboxId?, needsReplyNow, score, threshold, ms, error? }`
 *       the router's verdict on one message; `score` null and `error` set
 *       when Jev could not be asked, in which case the message waited.
 *   `coordinator:replied { inboxId, text, model, responder: 'fast' }`
 *       the fast responder's reply, shown as the coordinator's.
 */

export const COORDINATOR_ROUTED_EVENT = 'coordinator:routed';
export const COORDINATOR_REPLIED_EVENT = 'coordinator:replied';

export interface CoordinatorRoutedData {
  /** Set when the message was given a row (routed to the fast responder). */
  inboxId?: string;
  needsReplyNow: boolean;
  score: number | null;
  threshold: number;
  ms: number;
  error?: string;
}

export interface CoordinatorRepliedData {
  inboxId: string;
  text: string;
  model: string;
  responder: 'fast';
}
