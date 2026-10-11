/**
 * The coordinator panel's Your calls list (2026-10-09, thread 35804): the
 * open decision points that are the user's, as a rolling log. Each row leads
 * with what the thing is called, so it is recognised at a glance, with the
 * ask under it, and fades with age as sessions and projects do, so a call
 * the user blew past drops away instead of nagging.
 *
 *   fresh    under an hour: the amber cube, dimming over the hour as the
 *            sidebar's Needs you does
 *   recent   1 to 8 hours: a grey cube, the text quieter
 *   fading   8 to 24 hours: the name alone
 *   gone     after 24 hours, unless a live worker is still on the thread:
 *            a call that holds work up never drops off
 *
 * Age runs from when the thread started waiting on the user, or from the
 * card about it if that is later, so a new ask makes a row fresh again. A
 * call answered since then (from the row, the card, or a message that
 * settled the card) is done with: it shows as sent for a moment, then goes.
 */

import { isOpenDecision, type ShownDecision } from './decisions.js';
import type { HeldReply } from './held-replies.js';
import { withoutThreadRefs, type ProjectOpenThread } from './project-state.js';
import type { PlayItem } from './state-of-play.js';
import type { DecisionOptionData } from './decisions.js';

export type CallStage = 'fresh' | 'recent' | 'fading';

const HOUR = 60 * 60 * 1000;

/** How long a sent row stays, saying so, before it folds away. */
export const CALL_LEAVE_MS = 2_500;

/** The stage for a call that has waited `ms`; null once it is off the list. */
export function callStage(ms: number): CallStage | null {
  if (ms < HOUR) return 'fresh';
  if (ms < 8 * HOUR) return 'recent';
  if (ms < 24 * HOUR) return 'fading';
  return null;
}

/**
 * What "What was this?" opens: what the thread already says about itself,
 * never written for the occasion. Its evidence pointers are left out: they
 * are commits, paths and report numbers written for agents.
 */
export interface CallBrief {
  summary: string | null;
  next: string | null;
}

export interface Call {
  /** `t:<thread>` for a project thread, `d:<decision id>` for a card about none. */
  key: string;
  name: string;
  ask: string | null;
  /** When it started waiting on the user, epoch ms. */
  since: number;
  stage: CallStage;
  thread: ProjectOpenThread | null;
  /** Live workers on the thread: what dismissing it stops. */
  workers: number;
  /** The card's id and options when the row is a card. */
  decision: { id: string; options: DecisionOptionData[]; messageId: string } | null;
  /** An answer, message or dismissal from the panel that has not gone yet. */
  held: { id: string; text: string | null } | null;
  /** Answered: what was said and when, while the row is still leaving. */
  sent: { text: string | null; at: number } | null;
  /** Why the last reply from the panel did not go, when it failed since the call began. */
  error: string | null;
  brief: CallBrief | null;
  /** What the user is asked, in full, as the coordinator wrote it for them (`--ask`). */
  askText: string | null;
}

function briefOf(thread: ProjectOpenThread): CallBrief | null {
  const summary = thread.summary ? withoutThreadRefs(thread.summary) : null;
  const next = thread.nextAction ? withoutThreadRefs(thread.nextAction) : null;
  return summary || next ? { summary, next } : null;
}

/** The thread's ask when no card stands for it: its label, else what the decision waits on, else its next step. */
function threadAsk(thread: ProjectOpenThread): string | null {
  const ask = thread.label
    ?? (thread.waitingOn?.kind === 'decision' ? `Waiting on ${thread.waitingOn.text}` : null)
    ?? thread.nextAction;
  return ask ? withoutThreadRefs(ask) : null;
}

export function deriveCalls(input: {
  needsYou: readonly PlayItem[];
  /** The project's open threads: what a card about a thread that is not the user's names. */
  open?: readonly ProjectOpenThread[];
  latestDecision: ShownDecision | null;
  heldReplies: ReadonlyMap<string, HeldReply>;
  repliedAt: ReadonlyMap<string, number>;
  now: number;
}): Call[] {
  const { needsYou, open = [], latestDecision, heldReplies, repliedAt, now } = input;
  const card = latestDecision?.state ?? null;
  const cardRow = card && (isOpenDecision(card) || card.held || card.answer !== null) ? card : null;
  const cardThread = cardRow?.asked.thread !== undefined && needsYou.some((item) => item.thread.seq === cardRow.asked.thread)
    ? cardRow.asked.thread
    : null;

  const heldFor = (match: (reply: HeldReply) => boolean): Call['held'] => {
    for (const reply of heldReplies.values()) if (reply.state === 'held' && match(reply)) return { id: reply.id, text: reply.target.kind === 'dismiss' ? null : reply.text };
    return null;
  };
  const errorFor = (match: (reply: HeldReply) => boolean, since: number): string | null => {
    let error: string | null = null;
    for (const reply of heldReplies.values()) if (reply.error && (reply.at ?? 0) >= since && match(reply)) error = reply.error;
    return error;
  };
  const sentText = (match: (reply: HeldReply) => boolean): string | null => {
    let text: string | null = null;
    for (const reply of heldReplies.values()) if (reply.state === 'sent' && match(reply)) text = reply.text;
    return text;
  };

  const calls: Call[] = [];
  const add = (call: Omit<Call, 'stage'>, keepWhileWorked: boolean) => {
    if (call.sent && now - call.sent.at > CALL_LEAVE_MS) return;
    const stage = callStage(now - call.since) ?? (keepWhileWorked ? 'fading' : null);
    if (stage) calls.push({ ...call, stage });
  };

  const onCard = (reply: HeldReply) => Boolean(cardRow) && reply.target.kind !== 'thread' && reply.target.decision === cardRow!.asked.id;
  const cardDecision = cardRow ? { id: cardRow.asked.id, options: cardRow.asked.options, messageId: latestDecision!.messageId } : null;
  const cardHeld = cardRow?.held ? { id: cardRow.held.id, text: cardRow.held.answer } : null;

  if (cardRow && cardThread === null) {
    const since = latestDecision!.askedAt ?? now;
    const replied = repliedAt.get(`d:${cardRow.asked.id}`);
    // A card about an open thread that is not the user's (the coordinator
    // owns it) is still known by the thread's name and briefing; its row
    // stands for the card alone, so Dismiss closes the card, not the thread.
    const about = open.find((thread) => thread.seq === cardRow.asked.thread && !thread.parked) ?? null;
    if (!(cardRow.dismissed || (cardRow.answer !== null && replied === undefined))) {
      add({
        key: `d:${cardRow.asked.id}`,
        name: about ? withoutThreadRefs(about.name ?? about.text) : cardRow.asked.question,
        ask: about ? cardRow.asked.question : null,
        since,
        thread: null,
        workers: 0,
        decision: cardDecision,
        held: cardHeld,
        sent: cardRow.answer !== null && replied !== undefined ? { text: cardRow.answer, at: replied } : null,
        error: errorFor(onCard, since),
        brief: (about && briefOf(about)) ?? (cardRow.asked.detail ? { summary: cardRow.asked.detail, next: null } : null),
        askText: null,
      }, false);
    }
  }

  for (const item of needsYou) {
    const thread = item.thread;
    const withCard = cardThread === thread.seq ? cardRow : null;
    const since = Math.max(thread.waitingSince, withCard ? latestDecision!.askedAt ?? 0 : 0);
    const onThread = (reply: HeldReply) => (reply.target.kind === 'thread' && reply.target.thread === thread.seq) || (withCard !== null && onCard(reply));
    const replied = repliedAt.get(`t:${thread.seq}`);
    const answered = replied !== undefined && replied >= since;
    add({
      key: `t:${thread.seq}`,
      name: withoutThreadRefs(thread.name ?? thread.text),
      ask: withCard ? withCard.asked.question : threadAsk(thread),
      since,
      thread,
      workers: item.workers.length,
      decision: withCard ? cardDecision : null,
      held: withCard ? cardHeld ?? heldFor(onThread) : heldFor(onThread),
      sent: answered ? { text: withCard?.answer ?? sentText(onThread), at: replied! } : null,
      error: errorFor(onThread, since),
      brief: briefOf(thread),
      // A card carries its own question and options.
      askText: withCard ? null : thread.ask ?? null,
    }, item.workers.length > 0);
  }

  return calls.sort((a, b) => b.since - a.since);
}
