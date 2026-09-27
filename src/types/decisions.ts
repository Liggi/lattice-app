/**
 * A decision an agent puts to the user (`lattice ask`), shown as a card in the
 * agent's own thread and answered with a tap.
 *
 * Two events in that thread's log:
 *
 *   `decision:asked    { id, question, options }`   the card
 *   `decision:answered { id, answer, inboxId }`      the user's answer, shown
 *                                                    as the user's message and
 *                                                    delivered to the agent as
 *                                                    one attributed line
 *
 * A thread has at most one open question: asking again replaces an unanswered
 * one. An answer the agent has not read yet can be taken back and replaced; one
 * it has read is corrected with a second answer, which says so.
 *
 * Also here: the id prefix of a Claude AskUserQuestion held as a pending
 * question, which the client uses to answer it on its own tool card.
 */

import { INBOX_READ_EVENT, INBOX_WITHDRAWN_EVENT } from './inbox.js';

export const DECISION_ASKED_EVENT = 'decision:asked';
export const DECISION_ANSWERED_EVENT = 'decision:answered';

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
  /** The thread's most recent question: the only one whose answer can still change. */
  latest: boolean;
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
        if (latest && latest.answer === null) latest.replaced = true;
        if (latest) latest.latest = false;
        latest = { asked: data, answer: null, read: false, replaced: false, latest: true };
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
 * The thread's events with each question moved to the end of the turn that
 * asked it. An agent asks from a tool call and usually writes its message
 * after, so in log order the card would sit above the message that leads up
 * to it. It goes after the turn's `turn:end` (or `run:end`), or last while
 * that turn is still running. A Codex question is answered while its turn is
 * still running, so an answer also places the card, just above itself.
 */
export function placeDecisionsAtTurnEnd<E extends { type: string }>(events: readonly E[]): readonly E[] {
  if (!events.some((event) => event.type === DECISION_ASKED_EVENT)) return events;
  const placed: E[] = [];
  let held: E[] = [];
  for (const event of events) {
    if (event.type === DECISION_ASKED_EVENT) {
      held.push(event);
      continue;
    }
    if (held.length > 0 && event.type === DECISION_ANSWERED_EVENT) {
      placed.push(...held);
      held = [];
    }
    placed.push(event);
    if (held.length > 0 && (event.type === 'turn:end' || event.type === 'run:end')) {
      placed.push(...held);
      held = [];
    }
  }
  return [...placed, ...held];
}
