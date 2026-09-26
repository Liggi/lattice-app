/**
 * What the quick-answer card is allowed to say about delivery.
 *
 * The user could not tell whether the main agent ever sees a quick answer
 * (2026-09-21), so the card now says. The only thing it may say it from is the
 * inbox's own receipt: `input:read` names the rows a turn was handed. Anything
 * else — the session having written something since, a turn having ended —
 * would be a guess, and a guess in this direction reads as "it has your
 * correction" when it may not.
 */

import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { eventsToMessages } from '../../src/web/chat/hooks/useHarnessSession.js';

const noProviders = new Map<number, 'claude' | 'codex'>();

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { sessionId: 'conv-c', seq, runId: 'run-1', timestamp: 1_700_000_000_000 + seq, type, data } as SessionEvent;
}
const queued = (seq: number, id: string, text: string) => event(seq, 'input:queued', { id, source: 'user', text });
const answered = (seq: number, inboxId: string) =>
  event(seq, 'coordinator:replied', { inboxId, text: 'Front gets this when its turn ends.', model: 'claude-sonnet-5', responder: 'fast' });
/** A drain: the batch the turn was sent, then the receipt naming what it carried. */
const drained = (seq: number, ids: string[]) => [
  event(seq, 'input:sent', { text: '[Server note] …' }),
  event(seq + 1, 'input:read', { ids }),
];
const card = (events: SessionEvent[], windowComplete = true) =>
  eventsToMessages(events, noProviders, windowComplete).find((message) => message.responder === 'fast');

describe('quick answer delivery state', () => {
  it('waits while no turn has been handed the message', () => {
    const answer = card([queued(10, 'row-1', 'is this seen?'), answered(11, 'row-1')]);
    expect(answer?.responderDelivery).toBe('waiting');
  });

  it('says seen once an input:read names the row', () => {
    const answer = card([queued(10, 'row-1', 'is this seen?'), answered(11, 'row-1'), ...drained(12, ['row-1'])]);
    expect(answer?.responderDelivery).toBe('seen');
  });

  it('is not flipped by a drain of somebody else\'s row', () => {
    const answer = card([
      queued(10, 'row-1', 'is this seen?'),
      queued(11, 'row-2', 'and this one'),
      answered(12, 'row-1'),
      ...drained(13, ['row-2']),
    ]);
    expect(answer?.responderDelivery).toBe('waiting');
  });

  it('is not flipped by the session simply carrying on', () => {
    const answer = card([
      queued(10, 'row-1', 'is this seen?'),
      answered(11, 'row-1'),
      event(12, 'content', { blocks: [{ type: 'text', text: 'still working on the other thing' }] }),
      event(13, 'turn:end', {}),
    ]);
    expect(answer?.responderDelivery).toBe('waiting');
  });

  it('claims nothing for an answer whose row it cannot name', () => {
    const answer = card([event(10, 'coordinator:replied', { text: 'orphaned', model: 'claude-sonnet-5', responder: 'fast' })]);
    expect(answer?.responderDelivery).toBe('unknown');
  });

  // Pagination. The thread loads a window off the end of the log, so a card
  // can render while the `input:queued` that created its inbox row sits before
  // the start of that window. There the missing receipt is not evidence of
  // anything, and saying "waiting" would read as "it has not got your message"
  // when it may well have.
  it('says unknown when the window starts after the message\'s own inbox row', () => {
    const answer = card([
      answered(11, 'row-1'),
      event(12, 'content', { blocks: [{ type: 'text', text: 'carrying on' }] }),
    ]);
    expect(answer?.responderDelivery).toBe('unknown');
  });

  it('stays unknown when a receipt is loaded but the row it names is not', () => {
    // `foldInbox` builds items from `input:queued`, so a receipt naming a row
    // that scrolled out of the window is dropped with it. The card understates
    // rather than guesses: it will not say "seen" off an unattributable
    // receipt, and it will not say "waiting" either.
    const answer = card([answered(11, 'row-1'), ...drained(12, ['row-1'])]);
    expect(answer?.responderDelivery).toBe('unknown');
  });

  it('says unknown, not waiting, while the window is still being assembled', () => {
    const answer = card([queued(10, 'row-1', 'is this seen?'), answered(11, 'row-1')], false);
    expect(answer?.responderDelivery).toBe('unknown');
  });

  it('says seen during hydration when the receipt is already loaded', () => {
    const answer = card(
      [queued(10, 'row-1', 'is this seen?'), answered(11, 'row-1'), ...drained(12, ['row-1'])],
      false,
    );
    expect(answer?.responderDelivery).toBe('seen');
  });
});
