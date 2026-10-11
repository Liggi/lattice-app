/**
 * What the user does from a row of the coordinator panel's Your calls list
 * (2026-10-09, thread 35804): answer a card, dismiss it, or reply about a
 * project thread in their own words. Each is held for `REPLY_HOLD_MS` before
 * it goes, so Undo means the agent never got it.
 *
 * Three events in the coordinator's log:
 *
 *   `reply:held   { id, target, text, until }`  the reply, waiting to go
 *   `reply:undone { id, error? }`               taken back with Undo, or it
 *                                               failed to go (with why)
 *   `reply:sent   { id }`                       it went: the answer, the
 *                                               dismissal or the message is
 *                                               in the thread as usual
 *
 * A card answered from the row is the same answer the card's own buttons
 * give (`decision:answered`), so the card and the row show one state.
 */

import { DECISION_ANSWERED_EVENT, DECISION_ASKED_EVENT, DECISION_SETTLED_EVENT } from './decisions.js';

export const REPLY_HELD_EVENT = 'reply:held';
export const REPLY_UNDONE_EVENT = 'reply:undone';
export const REPLY_SENT_EVENT = 'reply:sent';

/** How long a reply waits before it goes, while Undo is offered. */
export const REPLY_HOLD_MS = 6_000;

export type ReplyTarget =
  /** An answer to the open card: an option's label or the user's own words. */
  | { kind: 'answer'; decision: string }
  /** Dismissing the open card without answering it. */
  | { kind: 'dismiss'; decision: string }
  /** The user's own words about a project thread, which go as their message. */
  | { kind: 'thread'; thread: number };

export interface ReplyHeldData {
  id: string;
  target: ReplyTarget;
  /** The answer or message; empty for a dismissal. */
  text: string;
  /** When it goes, epoch ms. */
  until: number;
  /** The project thread it is about, when there is one: what the row stood for. */
  thread?: number;
}

export interface ReplyUndoneData {
  id: string;
  /** Set when it could not be sent, rather than taken back. */
  error?: string;
}

export interface HeldReply extends ReplyHeldData {
  state: 'held' | 'undone' | 'sent';
  error: string | null;
  /** When it reached its state, epoch ms (the event's timestamp), when known. */
  at: number | null;
}

/** Every reply in a coordinator's log with where it got to, by id. */
export function foldHeldReplies(events: readonly { type: string; data?: unknown; timestamp?: number }[]): Map<string, HeldReply> {
  const replies = new Map<string, HeldReply>();
  for (const event of events) {
    if (event.type === REPLY_HELD_EVENT) {
      const data = event.data as ReplyHeldData | undefined;
      if (data?.id && data.target) replies.set(data.id, { ...data, state: 'held', error: null, at: event.timestamp ?? null });
      continue;
    }
    if (event.type !== REPLY_UNDONE_EVENT && event.type !== REPLY_SENT_EVENT) continue;
    const reply = replies.get((event.data as { id?: string } | undefined)?.id ?? '');
    if (!reply || reply.state !== 'held') continue;
    reply.state = event.type === REPLY_SENT_EVENT ? 'sent' : 'undone';
    reply.error = event.type === REPLY_UNDONE_EVENT ? (event.data as ReplyUndoneData).error ?? null : null;
    reply.at = event.timestamp ?? null;
  }
  return replies;
}

/**
 * When the user last replied about each project thread and each card, epoch
 * ms, keyed `t:<thread>` and `d:<decision id>`: an answer to a card (from the
 * card, the row or a message that settled it) or a thread reply that went.
 * A Your calls row answered since it started waiting is done with, until a
 * new ask makes it fresh. A dismissed card does not count for its thread.
 */
export function repliedAt(events: readonly { type: string; data?: unknown; timestamp?: number }[]): Map<string, number> {
  const at = new Map<string, number>();
  const threadOf = new Map<string, number>();
  const held = new Map<string, ReplyHeldData>();
  const mark = (key: string, time: number | undefined) => {
    if (time !== undefined) at.set(key, Math.max(at.get(key) ?? 0, time));
  };
  for (const event of events) {
    const data = event.data as { id?: string; thread?: number } | undefined;
    if (!data?.id) continue;
    if (event.type === DECISION_ASKED_EVENT && typeof data.thread === 'number') threadOf.set(data.id, data.thread);
    else if (event.type === DECISION_ANSWERED_EVENT || event.type === DECISION_SETTLED_EVENT) {
      mark(`d:${data.id}`, event.timestamp);
      const thread = threadOf.get(data.id);
      if (thread !== undefined) mark(`t:${thread}`, event.timestamp);
    } else if (event.type === REPLY_HELD_EVENT) held.set(data.id, event.data as ReplyHeldData);
    else if (event.type === REPLY_SENT_EVENT) {
      const reply = held.get(data.id);
      if (reply?.target.kind === 'thread') mark(`t:${reply.target.thread}`, event.timestamp);
    }
  }
  return at;
}
