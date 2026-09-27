/**
 * The question a thread's card is still waiting on the user to answer, read
 * from the thread's log. Kept apart from `decisions.ts` so the status poll and
 * Needs you can read it without importing the harness wiring.
 */

import { getEvents } from '../../session-history/repository.js';
import { INBOX_READ_EVENT, INBOX_WITHDRAWN_EVENT } from '../../types/inbox.js';
import {
  DECISION_ANSWERED_EVENT,
  DECISION_ASKED_EVENT,
  DECISION_DISMISSED_EVENT,
  DECISION_SETTLED_EVENT,
  foldDecisions,
  isOpenDecision,
  type DecisionAskedData,
  type DecisionState,
} from '../../types/decisions.js';

export interface OpenDecision {
  asked: DecisionAskedData;
  /** The `decision:asked` event's seq and time, epoch ms. */
  seq: number;
  askedAt: number;
}

export function decisionsIn(threadId: string): Map<string, DecisionState> {
  return foldDecisions(getEvents(threadId, {
    types: [DECISION_ASKED_EVENT, DECISION_ANSWERED_EVENT, DECISION_SETTLED_EVENT, DECISION_DISMISSED_EVENT, INBOX_READ_EVENT, INBOX_WITHDRAWN_EVENT],
  }));
}

export function openDecision(threadId: string): OpenDecision | null {
  const open = [...decisionsIn(threadId).values()].find(isOpenDecision);
  if (!open) return null;
  const event = getEvents(threadId, { types: [DECISION_ASKED_EVENT] })
    .find((candidate) => (candidate.data as DecisionAskedData | undefined)?.id === open.asked.id);
  return event ? { asked: open.asked, seq: event.seq, askedAt: event.timestamp } : null;
}
