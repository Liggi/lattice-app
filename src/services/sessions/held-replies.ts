/**
 * Replies from the panel's Your calls rows, held for a few seconds before
 * they go so that Undo means the agent never got them (2026-10-09, thread
 * 35804). See `types/held-replies.ts` for the events.
 *
 * A held reply is in the coordinator's log from the moment it is made, so
 * the card in the chat and the row in the panel show it alike, on every
 * device. The timer that sends it lives in this process; a restart picks up
 * whatever was still held (`resumeHeldReplies`) and sends what is due.
 * Sending again after a restart that cut in between sending and recording
 * it does not repeat it: an answer the card already has is a no-op, and a
 * thread message carries the reply's id as its inbox delivery key.
 */

import { randomUUID } from 'node:crypto';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { createLogger } from '../infrastructure/logger.js';
import { DECISION_ANSWERED_EVENT, DECISION_ASKED_EVENT, DECISION_SETTLED_EVENT, isAwaitingDecision } from '../../types/decisions.js';
import {
  REPLY_HELD_EVENT,
  REPLY_HOLD_MS,
  REPLY_SENT_EVENT,
  REPLY_UNDONE_EVENT,
  foldHeldReplies,
  repliedAt,
  type HeldReply,
  type ReplyHeldData,
  type ReplyTarget,
} from '../../types/held-replies.js';
import { withoutThreadRefs } from '../../types/project-state.js';
import { answerDecision, dismissDecision } from './decisions.js';
import { decisionsIn } from './open-decision.js';
import { readProjectState } from './project-state.js';
import { enqueueInboxItem } from './session-inbox.js';
import { handOverNow } from './immediate-delivery.js';
import { noteUserSent } from './project-needs-you.js';

const logger = createLogger('HeldReplies');

export class HeldReplyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Replies being sent now: too late to undo. */
const sending = new Set<string>();

function repliesIn(coordinator: string): Map<string, HeldReply> {
  return foldHeldReplies(getEvents(coordinator, { types: [REPLY_HELD_EVENT, REPLY_UNDONE_EVENT, REPLY_SENT_EVENT] }));
}

function append(coordinator: string, type: string, data: unknown): void {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  if (!appendCustomHarnessEvent(manager, coordinator, type, data)) throw new Error(`Could not write ${type} to ${coordinator}`);
}

/** Checks the reply can go, and says which project thread it is about. */
function check(coordinator: string, target: ReplyTarget, text: string): number | undefined {
  if (target.kind === 'thread') {
    if (!text) throw new HeldReplyError('The message is empty.', 400);
    const thread = readProjectState(coordinator).open.find((candidate) => candidate.seq === target.thread);
    if (!thread || thread.parked) throw new HeldReplyError(`Thread ${target.thread} is not an open thread of this project.`, 404);
    return thread.seq;
  }
  if (target.kind === 'answer' && !text) throw new HeldReplyError('The answer is empty.', 400);
  const decision = decisionsIn(coordinator).get(target.decision);
  if (!decision) throw new HeldReplyError('That question is not in this thread.', 404);
  if (decision.held) throw new HeldReplyError('An answer to that question is already on its way.', 409);
  if (!isAwaitingDecision(decision)) throw new HeldReplyError('That question is no longer waiting on an answer.', 409);
  return decision.asked.thread;
}

/** Records the reply and starts its timer. */
export function holdReply(coordinator: string, target: ReplyTarget, rawText: string): { id: string; until: number } {
  const text = rawText.trim();
  const thread = check(coordinator, target, text);
  const data: ReplyHeldData = { id: randomUUID(), target, text, until: Date.now() + REPLY_HOLD_MS, ...(thread !== undefined ? { thread } : {}) };
  append(coordinator, REPLY_HELD_EVENT, data);
  schedule(coordinator, data.id, data.until);
  return { id: data.id, until: data.until };
}

/** Takes a reply back before it goes. */
export function undoReply(coordinator: string, id: string): void {
  const reply = repliesIn(coordinator).get(id);
  if (!reply) throw new HeldReplyError('No such reply.', 404);
  if (reply.state !== 'held' || sending.has(id)) throw new HeldReplyError('It has already gone.', 409);
  clearTimeout(timers.get(id));
  timers.delete(id);
  append(coordinator, REPLY_UNDONE_EVENT, { id });
}

function schedule(coordinator: string, id: string, until: number): void {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => void send(coordinator, id), Math.max(0, until - Date.now())));
}

/** The thread message: the user's words, with what they are about so the coordinator can place them. */
export function threadReplyText(name: string, seq: number, text: string): string {
  return `About "${name}" [${seq}]: ${text}`;
}

async function deliver(coordinator: string, reply: HeldReply): Promise<void> {
  const target = reply.target;
  if (target.kind === 'answer') {
    await answerDecision(coordinator, target.decision, reply.text);
    return;
  }
  if (target.kind === 'dismiss') {
    const decision = decisionsIn(coordinator).get(target.decision);
    // Already dismissed: a restart cut in after the dismissal and before it was recorded.
    if (decision?.dismissed) return;
    await dismissDecision(coordinator, target.decision);
    return;
  }
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  const thread = readProjectState(coordinator).open.find((candidate) => candidate.seq === target.thread);
  const name = withoutThreadRefs(thread?.name ?? thread?.label ?? thread?.text ?? `thread ${target.thread}`);
  const inboxId = enqueueInboxItem({ sessionId: coordinator, source: 'user', text: threadReplyText(name, target.thread, reply.text), deliveryId: `reply-${reply.id}` });
  noteUserSent(manager, coordinator);
  await handOverNow(coordinator, inboxId);
}

async function send(coordinator: string, id: string): Promise<void> {
  timers.delete(id);
  const reply = repliesIn(coordinator).get(id);
  if (!reply || reply.state !== 'held' || sending.has(id)) return;
  sending.add(id);
  try {
    await deliver(coordinator, reply);
    append(coordinator, REPLY_SENT_EVENT, { id });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn('A held reply could not be sent', { coordinator, id, error });
    try {
      append(coordinator, REPLY_UNDONE_EVENT, { id, error });
    } catch (writeErr) {
      logger.error('Recording a failed reply failed too', { coordinator, id, error: writeErr instanceof Error ? writeErr.message : String(writeErr) });
    }
  } finally {
    sending.delete(id);
  }
}

/** At boot: replies the last process held and never sent go when they are due. */
export function resumeHeldReplies(): number {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT DISTINCT session_id FROM harness_events WHERE type = ? AND timestamp >= ?`,
  ).all(REPLY_HELD_EVENT, since) as Array<{ session_id: string }>;
  let resumed = 0;
  for (const { session_id: coordinator } of rows) {
    for (const reply of repliesIn(coordinator).values()) {
      if (reply.state !== 'held' || timers.has(reply.id)) continue;
      schedule(coordinator, reply.id, reply.until);
      resumed += 1;
    }
  }
  return resumed;
}

/** When the user last replied about each thread and card, for the panel (`repliedAt`): read whole, past what the page has loaded. */
export function repliesOf(coordinator: string): Map<string, number> {
  return repliedAt(getEvents(coordinator, { types: [DECISION_ASKED_EVENT, DECISION_ANSWERED_EVENT, DECISION_SETTLED_EVENT, REPLY_HELD_EVENT, REPLY_SENT_EVENT] }));
}
