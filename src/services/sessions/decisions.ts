/**
 * `lattice ask`: an agent's question to the user, as a card in its own thread,
 * and the user's answer, delivered back to it.
 *
 * The card is a `decision:asked` event in the thread's log; the agent ends its
 * turn as usual. The answer is a `decision:answered` event, which the thread
 * shows as the user's message, and an inbox row (`source: 'decision'`) handed
 * over at once, as a reaction is (`message-reactions.ts`). See
 * `types/decisions.ts` for the events and the fold.
 */

import { randomUUID } from 'node:crypto';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import {
  DECISION_ANSWERED_EVENT,
  DECISION_ASKED_EVENT,
  DECISION_MAX_OPTIONS,
  DECISION_MIN_OPTIONS,
  DECISION_DISMISSED_EVENT,
  DECISION_SETTLED_EVENT,
  isOpenDecision,
  type DecisionAnsweredData,
  type DecisionAskedData,
  type DecisionOptionData,
} from '../../types/decisions.js';
import { ConversationService } from './conversation-service.js';
import { readWorkerStates } from './worker-events.js';
import { enqueueInboxItem, withdrawInboxItem } from './session-inbox.js';
import { handOverNow } from './immediate-delivery.js';
import { UserName } from '../user-profile.js';
import { noteUserSent } from './project-needs-you.js';
import { noteStatusChanged } from './session-status-changes.js';
import { decisionsIn, openDecision } from './open-decision.js';
import { readProjectState } from './project-state.js';
import type { SessionManager } from '@liggi/agent-ui-harness/server';

export class DecisionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function isWorker(conversationId: string): boolean {
  const coordinator = ConversationService.getInstance().getConversation(conversationId)?.pickedUpFrom;
  return Boolean(coordinator && readWorkerStates(coordinator).some((worker) => worker.worker === conversationId));
}

export const WORKER_ASK_REFUSAL = 'Workers do not ask the user directly: nobody reads a worker\'s thread for questions. End your turn with "Question for front:" and your coordinator will decide or ask the user.';

/** Refuses what the card cannot show well: the reason is written for the agent that asked. */
function checkQuestion(question: string, options: DecisionOptionData[]): void {
  if (!question.trim()) throw new DecisionError('The question is empty.', 400);
  if (options.length < DECISION_MIN_OPTIONS || options.length > DECISION_MAX_OPTIONS) {
    throw new DecisionError(`A decision has ${DECISION_MIN_OPTIONS} to ${DECISION_MAX_OPTIONS} options; this has ${options.length}. The user can always answer in their own words, so there is no need for an "other" option.`, 400);
  }
  const labels = new Set<string>();
  for (const option of options) {
    if (!option.label.trim()) throw new DecisionError('An option has no label.', 400);
    if (!option.consequence.trim()) throw new DecisionError(`Option "${option.label}" has no consequence. Say in one line what choosing it sets in motion (--because).`, 400);
    if (labels.has(option.label)) throw new DecisionError(`Two options are both "${option.label}".`, 400);
    labels.add(option.label);
  }
  if (options.filter((option) => option.recommended).length > 1) throw new DecisionError('Recommend one option at most.', 400);
}

/** Puts the card in the agent's thread. A question still unanswered there is replaced by it. */
export function askDecision(threadId: string, question: string, options: DecisionOptionData[], projectThread?: number): { id: string; replaced: string | null } {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  if (!ConversationService.getInstance().getConversation(threadId)) throw new DecisionError(`No conversation ${threadId}`, 404);
  if (isWorker(threadId)) throw new DecisionError(WORKER_ASK_REFUSAL, 409);
  checkQuestion(question, options);
  if (projectThread !== undefined && !readProjectState(threadId).open.some((thread) => thread.seq === projectThread && !thread.parked)) {
    throw new DecisionError(`--thread names one of this project's open threads; ${projectThread} is not one.`, 400);
  }

  const open = [...decisionsIn(threadId).values()].find(isOpenDecision);
  const data: DecisionAskedData = {
    id: randomUUID(),
    question: question.trim(),
    options: options.map((option) => ({
      label: option.label.trim(),
      consequence: option.consequence.trim(),
      ...(option.recommended ? { recommended: true } : {}),
    })),
    ...(projectThread !== undefined ? { thread: projectThread } : {}),
  };
  if (!appendCustomHarnessEvent(manager, threadId, DECISION_ASKED_EVENT, data)) {
    throw new Error(`The question could not be written to ${threadId}`);
  }
  return { id: data.id, replaced: open?.asked.id ?? null };
}

/**
 * A question Codex asked with `request_user_input_async`, which cannot be
 * refused with an error: the tool has already returned and Codex keeps its
 * turn open waiting for the reply. So it is not checked like `lattice ask`,
 * and a worker, which gets no card, is told why in its running turn instead.
 */
export async function recordCodexQuestion(threadId: string, data: DecisionAskedData): Promise<void> {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  if (!isWorker(threadId)) {
    appendCustomHarnessEvent(manager, threadId, DECISION_ASKED_EVENT, data);
    return;
  }
  const inboxId = enqueueInboxItem({ sessionId: threadId, source: 'decision', text: `Your question "${data.question}" was not shown to anyone. ${WORKER_ASK_REFUSAL}` });
  await handOverNow(threadId, inboxId);
}

/** The line the agent reads. */
function answerLine(question: string, answer: string, ownWords: boolean, correction: boolean): string {
  if (correction) return `${UserName()} changed their answer to your question "${question}". It is now: ${answer}`;
  return ownWords
    ? `${UserName()} answered your question "${question}" in their own words: ${answer}`
    : `${UserName()} answered your question "${question}": ${answer}`;
}

/**
 * Records the user's answer and hands it to the agent. Answering again is a
 * change of mind: an answer the agent has not read yet is taken back and
 * replaced; one it has read is followed by a correction.
 */
export async function answerDecision(threadId: string, decisionId: string, rawAnswer: string): Promise<{ delivered: 'answer' | 'replacement' | 'correction' }> {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  const answer = rawAnswer.trim();
  if (!answer) throw new DecisionError('The answer is empty.', 400);
  const decision = decisionsIn(threadId).get(decisionId);
  if (!decision) throw new DecisionError('That question is not in this thread.', 404);
  if (decision.replaced) throw new DecisionError('A later question replaced this one.', 409);
  if (decision.settled) throw new DecisionError('This question was answered in the chat.', 409);
  if (decision.answer !== null && !decision.latest) throw new DecisionError('Only the latest question can have its answer changed.', 409);
  if (decision.answer === answer) return { delivered: 'answer' };

  let correction = false;
  let replacement = false;
  if (decision.answer !== null) {
    const previous = getEvents(threadId, { types: [DECISION_ANSWERED_EVENT] })
      .map((event) => event.data as DecisionAnsweredData)
      .filter((data) => data.id === decisionId)
      .at(-1);
    replacement = Boolean(previous && withdrawInboxItem(previous.inboxId));
    correction = !replacement;
  }

  const ownWords = !decision.asked.options.some((option) => option.label === answer);
  const inboxId = enqueueInboxItem({ sessionId: threadId, source: 'decision', text: answerLine(decision.asked.question, answer, ownWords, correction) });
  appendCustomHarnessEvent(manager, threadId, DECISION_ANSWERED_EVENT, { id: decisionId, answer, inboxId } satisfies DecisionAnsweredData);
  // An answer is the user replying, so it clears Needs you as a typed message does.
  noteUserSent(manager, threadId);
  await handOverNow(threadId, inboxId);
  return { delivered: correction ? 'correction' : replacement ? 'replacement' : 'answer' };
}

/**
 * The user declines to answer an open question: the card closes as dismissed
 * and the agent is told so in one line. Unlike dismissing the project thread
 * it is about (`thread-dismissal.ts`), the thread stays open and its workers
 * carry on; only the question is gone.
 */
export async function dismissDecision(threadId: string, decisionId: string): Promise<void> {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  const decision = decisionsIn(threadId).get(decisionId);
  if (!decision) throw new DecisionError('That question is not in this thread.', 404);
  if (!isOpenDecision(decision)) throw new DecisionError('That question is no longer waiting on an answer.', 409);
  if (!appendCustomHarnessEvent(manager, threadId, DECISION_DISMISSED_EVENT, { id: decisionId })) {
    throw new Error(`The dismissal could not be written to ${threadId}`);
  }
  noteStatusChanged(threadId);
  const inboxId = enqueueInboxItem({ sessionId: threadId, source: 'decision', text: `${UserName()} dismissed your question "${decision.asked.question}" without answering.` });
  await handOverNow(threadId, inboxId);
}

/**
 * The user wrote to the thread while its card was open: their message is the
 * answer, so the card closes as answered and no tap is expected. Called on a
 * composer send, before the message is written, so the card sits above it.
 * A card whose turn is still running has not been seen, so it stays open.
 */
export function settleOpenDecision(manager: SessionManager, threadId: string): void {
  const open = openDecision(threadId);
  if (open) appendCustomHarnessEvent(manager, threadId, DECISION_SETTLED_EVENT, { id: open.asked.id });
}
