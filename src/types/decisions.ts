/**
 * A decision an agent puts to the user (`lattice ask`), shown as a card in the
 * agent's own thread and answered with a tap.
 *
 * Three events in that thread's log:
 *
 *   `decision:asked    { id, question, options }`   the card
 *   `decision:answered { id, answer, inboxId }`      the user's answer, shown
 *                                                    as the user's message and
 *                                                    delivered to the agent as
 *                                                    one attributed line
 *   `decision:settled  { id }`                       the user wrote to the
 *                                                    thread instead of tapping;
 *                                                    their message is the answer
 *   `decision:dismissed { id }`                      the user dismissed the
 *                                                    question without answering
 *                                                    it, or the project thread
 *                                                    it was about
 *
 * A coordinator's card may name the project thread it is about
 * (`lattice ask --thread`), which is what lets that dismissal close it.
 *
 * A thread has at most one open question: asking again replaces an unanswered
 * one. An answer the agent has not read yet can be taken back and replaced; one
 * it has read is corrected with a second answer, which says so.
 *
 * Also here: the id prefix of a Claude AskUserQuestion held as a pending
 * question, which the client uses to answer it on its own tool card.
 */

import { INBOX_READ_EVENT, INBOX_WITHDRAWN_EVENT } from './inbox.js';
import { EXPLAIN_ASKED_EVENT } from './explain.js';

export const DECISION_ASKED_EVENT = 'decision:asked';
export const DECISION_ANSWERED_EVENT = 'decision:answered';
export const DECISION_SETTLED_EVENT = 'decision:settled';
export const DECISION_DISMISSED_EVENT = 'decision:dismissed';

export const DECISION_MIN_OPTIONS = 2;
export const DECISION_MAX_OPTIONS = 4;

/** Pending questions from Claude's AskUserQuestion, answered through the SDK permission bridge. */
export const CLAUDE_QUESTION_ID_PREFIX = 'claude-question-';

export interface DecisionOptionData {
  label: string;
  /** What choosing it sets in motion. */
  consequence: string;
  recommended?: boolean;
}

export interface DecisionAskedData {
  id: string;
  question: string;
  options: DecisionOptionData[];
  /** The coordinator's project thread this question is about, when it named one. */
  thread?: number;
  /**
   * The asking turn stays open until the user answers (Codex's
   * request_user_input_async), so the card shows at once rather than at the
   * turn's end.
   */
  holdsTurn?: boolean;
}

export interface DecisionAnsweredData {
  id: string;
  /** An option's label, or the user's own words. */
  answer: string;
  /** The inbox row that carries it to the agent. */
  inboxId: string;
}

export interface DecisionState {
  asked: DecisionAskedData;
  /** The latest answer, if any. */
  answer: string | null;
  /** Whether the agent has read the latest answer. */
  read: boolean;
  /** A later question replaced this one before it was answered. */
  replaced: boolean;
  /** The user wrote to the thread while it was open: their message answers it, not a tap. */
  settled: boolean;
  /** The thread's most recent question: the only one whose answer can still change. */
  latest: boolean;
  /** The user dismissed it, or the project thread it was about, so it is no longer asked. */
  dismissed: boolean;
}

/** A log event as both the server's store and the page's stream give it. */
export interface DecisionEventLike {
  type: string;
  data: unknown;
}

/** What a thread's page needs to show its questions and the answers to them. */
export interface ThreadDecisions {
  byId: ReadonlyMap<string, DecisionState>;
  /** Inbox ids of answers taken back unread, whose messages are not shown. */
  withdrawnAnswers: ReadonlySet<string>;
}

/** Still waiting on the user: the thread's latest question, with no answer, not replaced and not settled by a message. */
export function isOpenDecision(decision: DecisionState): boolean {
  return decision.latest && decision.answer === null && !decision.replaced && !decision.settled && !decision.dismissed;
}

/** Every question in a thread's log with its current answer, by decision id. */
export function foldDecisions(events: readonly DecisionEventLike[]): Map<string, DecisionState> {
  const decisions = new Map<string, DecisionState>();
  const answerInbox = new Map<string, string>();
  const readInbox = new Set<string>();
  const withdrawn = new Set<string>();
  let latest: DecisionState | null = null;

  for (const event of events) {
    switch (event.type as string) {
      case DECISION_ASKED_EVENT: {
        const data = event.data as DecisionAskedData;
        if (!data?.id) break;
        if (latest && isOpenDecision(latest)) latest.replaced = true;
        if (latest) latest.latest = false;
        latest = { asked: data, answer: null, read: false, replaced: false, settled: false, latest: true, dismissed: false };
        decisions.set(data.id, latest);
        break;
      }
      case DECISION_ANSWERED_EVENT: {
        const data = event.data as DecisionAnsweredData;
        const decision = data?.id ? decisions.get(data.id) : undefined;
        if (!decision) break;
        decision.answer = data.answer;
        decision.read = false;
        answerInbox.set(data.inboxId, data.id);
        break;
      }
      case DECISION_SETTLED_EVENT: {
        const decision = decisions.get((event.data as { id?: string })?.id ?? '');
        if (decision && isOpenDecision(decision)) decision.settled = true;
        break;
      }
      case DECISION_DISMISSED_EVENT: {
        const decision = decisions.get((event.data as { id?: string })?.id ?? '');
        if (decision && isOpenDecision(decision)) decision.dismissed = true;
        break;
      }
      case INBOX_READ_EVENT: {
        for (const id of (event.data as { ids?: string[] }).ids ?? []) readInbox.add(id);
        break;
      }
      case INBOX_WITHDRAWN_EVENT: {
        for (const id of (event.data as { ids?: string[] }).ids ?? []) withdrawn.add(id);
        break;
      }
      default:
        break;
    }
  }

  // Read state belongs to the latest answer only: an earlier one was withdrawn or superseded.
  const latestInbox = new Map<string, string>();
  for (const [inboxId, decisionId] of answerInbox) if (!withdrawn.has(inboxId)) latestInbox.set(decisionId, inboxId);
  for (const [decisionId, inboxId] of latestInbox) {
    const decision = decisions.get(decisionId);
    if (decision) decision.read = readInbox.has(inboxId);
  }
  return decisions;
}

/** Answers that were taken back before the agent read them: not shown as the user's messages. */
export function withdrawnDecisionAnswers(events: readonly DecisionEventLike[]): Set<string> {
  const withdrawn = new Set<string>();
  for (const event of events) {
    if ((event.type as string) === INBOX_WITHDRAWN_EVENT) for (const id of (event.data as { ids?: string[] }).ids ?? []) withdrawn.add(id);
  }
  return withdrawn;
}

/**
 * Whether an event ends the turn a question was asked in, which is when its
 * card shows. A compaction's own `turn:end` falls mid-turn, so it does not.
 */
export function endsAskingTurn(event: { type: string; data?: unknown }): boolean {
  if (event.type === 'run:end' || event.type === 'run:error') return true;
  return event.type === 'turn:end' && !(event.data as { compact?: boolean } | undefined)?.compact;
}

/**
 * The thread's events with each question moved to the end of the turn that
 * asked it. An agent asks from a tool call and writes its message after, so
 * the card goes after the turn's end (`turn:end`, `run:end` or `run:error`),
 * below that message. While the turn is still running the card is not shown
 * at all: shown last, it would appear before the message that explains it
 * has been written (2026-09-29: the user was answering cards without their
 * context). A question that holds its turn open (`holdsTurn`) shows at once,
 * as nothing more comes until it is answered. An answer, or a message that
 * settles a question, also places the card, just above itself. An
 * explain-back card (`lattice explain`) is placed the same way.
 */
export function placeDecisionsAtTurnEnd<E extends { type: string; data?: unknown }>(events: readonly E[]): readonly E[] {
  const heldUntilTurnEnd = (event: E) => event.type === EXPLAIN_ASKED_EVENT
    || (event.type === DECISION_ASKED_EVENT && !(event.data as DecisionAskedData | undefined)?.holdsTurn);
  if (!events.some((event) => event.type === DECISION_ASKED_EVENT || event.type === EXPLAIN_ASKED_EVENT)) return events;
  const placed: E[] = [];
  let held: E[] = [];
  for (const event of events) {
    if (heldUntilTurnEnd(event)) {
      held.push(event);
      continue;
    }
    if (held.length > 0 && (event.type === DECISION_ANSWERED_EVENT || event.type === DECISION_SETTLED_EVENT)) {
      placed.push(...held);
      held = [];
    }
    placed.push(event);
    if (held.length > 0 && endsAskingTurn(event)) {
      placed.push(...held);
      held = [];
    }
  }
  return placed;
}

/** The question the thread shows and still waits on, with the id of its message in the thread. */
export interface ShownOpenDecision {
  asked: DecisionAskedData;
  messageId: string;
}

/**
 * The open question whose card the thread is showing: in the placed events
 * (`placeDecisionsAtTurnEnd`), so not while its turn is still running.
 */
export function shownOpenDecision(
  placed: readonly { type: string; data?: unknown; seq: number }[],
  byId: ReadonlyMap<string, DecisionState>,
): ShownOpenDecision | null {
  for (let i = placed.length - 1; i >= 0; i -= 1) {
    const event = placed[i];
    if (event.type !== DECISION_ASKED_EVENT) continue;
    const decision = byId.get((event.data as DecisionAskedData | undefined)?.id ?? '');
    if (decision && isOpenDecision(decision)) return { asked: decision.asked, messageId: `h-${event.seq}` };
  }
  return null;
}
