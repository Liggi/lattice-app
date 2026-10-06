/**
 * The question a thread's card is still waiting on the user to answer, read
 * from the thread's log. Kept apart from `decisions.ts` so the status poll and
 * Needs you can read it without importing the harness wiring.
 */

import { getEvents } from '../../session-history/repository.js';
import { cachedFold } from './fold-cache.js';
import { INBOX_READ_EVENT, INBOX_WITHDRAWN_EVENT } from '../../types/inbox.js';
import {
  DECISION_ANSWERED_EVENT,
  DECISION_ASKED_EVENT,
  DECISION_DISMISSED_EVENT,
  DECISION_SETTLED_EVENT,
  endsAskingTurn,
  foldDecisions,
  isOpenDecision,
  type DecisionAskedData,
  type DecisionState,
} from '../../types/decisions.js';

export interface OpenDecision {
  asked: DecisionAskedData;
  /** The `decision:asked` event's seq. */
  seq: number;
  /** When the card showed to the user, epoch ms: the end of the turn that asked it (`placeDecisionsAtTurnEnd`). */
  shownAt: number;
}

const DECISION_FOLD_TYPES = [DECISION_ASKED_EVENT, DECISION_ANSWERED_EVENT, DECISION_SETTLED_EVENT, DECISION_DISMISSED_EVENT, INBOX_READ_EVENT, INBOX_WITHDRAWN_EVENT];

/** Kept until a decision or inbox event lands: every status poll reads it for each project. */
export function decisionsIn(threadId: string): Map<string, DecisionState> {
  return cachedFold('decisions', threadId, DECISION_FOLD_TYPES, foldDecisions);
}

/**
 * The thread's open question, once its card shows. While the turn that asked
 * it is still running the user cannot see it, so it is not waiting on them yet.
 */
export function openDecision(threadId: string): OpenDecision | null {
  const open = [...decisionsIn(threadId).values()].find(isOpenDecision);
  if (!open) return null;
  const event = getEvents(threadId, { types: [DECISION_ASKED_EVENT] })
    .find((candidate) => (candidate.data as DecisionAskedData | undefined)?.id === open.asked.id);
  if (!event) return null;
  if (open.asked.holdsTurn) return { asked: open.asked, seq: event.seq, shownAt: event.timestamp };
  const end = getEvents(threadId, { fromSeq: event.seq + 1, types: ['turn:end', 'run:end', 'run:error'] }).find(endsAskingTurn);
  return end ? { asked: open.asked, seq: event.seq, shownAt: end.timestamp } : null;
}
