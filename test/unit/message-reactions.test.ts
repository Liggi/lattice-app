/**
 * The user's emoji reactions reach the agent the message is for, as one
 * attributed line through the inbox. A reaction taken off before any turn
 * read it is withdrawn unheard; one taken off after is announced.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { foldInbox } from '../../src/types/inbox.js';
import { foldAgentReactions, foldReactions, isSingleEmoji } from '../../src/types/message-reactions.js';

const log: Array<{ sessionId: string; seq: number; type: string; data: unknown }> = [];
const handOverNow = vi.fn(async (_sessionId: string, _inboxId: string) => {});

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({ inspect: () => null }),
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_manager: unknown, sessionId: string, type: string, data: unknown) => {
    log.push({ sessionId, seq: log.length + 1, type, data });
    return { seq: log.length, type, data };
  },
}));
vi.mock('../../src/session-history/repository.js', () => ({
  getEvents: (sessionId: string, opts: { types?: string[] } = {}) =>
    log.filter((event) => event.sessionId === sessionId && (!opts.types || opts.types.includes(event.type))),
}));
vi.mock('../../src/services/sessions/immediate-delivery.js', () => ({
  handOverNow: (sessionId: string, inboxId: string) => handOverNow(sessionId, inboxId),
}));

const inbox = await import('../../src/services/sessions/session-inbox.js');
const { agentReact, reactToMessage } = await import('../../src/services/sessions/message-reactions.js');

beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  log.length = 0;
  handOverNow.mockClear();
});

const base = { threadId: 'conv-front', messageId: 'h-12', emoji: '👍', excerpt: 'Release 906 is live.' } as const;
const typesIn = (sessionId: string) => log.filter((event) => event.sessionId === sessionId).map((event) => event.type);

describe('reactToMessage', () => {
  it('tells the thread\'s agent about a reaction on its own message, and hands it over now', async () => {
    expect(await reactToMessage({ ...base, action: 'add' })).toEqual({ status: 'added', recipient: 'conv-front' });
    const [row] = inbox.unreadInboxItems('conv-front');
    expect(row).toMatchObject({ source: 'reaction', text: 'The user reacted 👍 to your message "Release 906 is live."' });
    expect(handOverNow).toHaveBeenCalledWith('conv-front', row.id);
    expect(typesIn('conv-front')).toEqual(['input:queued', 'reaction:added']);
  });

  it('gives a reaction on a worker\'s report to the coordinator, naming the worker', async () => {
    await reactToMessage({ ...base, action: 'add', emoji: '✅', worker: 'conv-w1', excerpt: 'Fixture report' });
    expect(inbox.unreadInboxItems('conv-front')[0].text).toBe('The user reacted ✅ to conv-w1\'s report "Fixture report"');
  });

  it('gives a reaction on another agent\'s message to that agent, saying where it sent it', async () => {
    const outcome = await reactToMessage({ ...base, action: 'add', sender: 'conv-w1', excerpt: 'Wrong thread, ignore it.' });
    expect(outcome).toEqual({ status: 'added', recipient: 'conv-w1' });
    expect(inbox.unreadInboxItems('conv-front')).toEqual([]);
    expect(inbox.unreadInboxItems('conv-w1')[0].text).toBe('The user reacted 👍 to the message you sent conv-front, "Wrong thread, ignore it."');
    // The reaction is shown in the thread it was made in.
    expect(foldReactions(log.filter((event) => event.sessionId === 'conv-front')).get('h-12')).toEqual([
      { emoji: '👍', inboxId: inbox.unreadInboxItems('conv-w1')[0].id },
    ]);
  });

  it('sends nothing for a reaction already on the message, or a removal of one that is not', async () => {
    await reactToMessage({ ...base, action: 'add' });
    expect(await reactToMessage({ ...base, action: 'add' })).toEqual({ status: 'unchanged' });
    expect(await reactToMessage({ ...base, action: 'remove', emoji: '👀' })).toEqual({ status: 'unchanged' });
    expect(inbox.unreadInboxItems('conv-front')).toHaveLength(1);
    expect(handOverNow).toHaveBeenCalledTimes(1);
  });

  it('withdraws a reaction removed before any turn read it; the agent hears of neither', async () => {
    await reactToMessage({ ...base, action: 'add' });
    const added = inbox.unreadInboxItems('conv-front')[0];
    expect(await reactToMessage({ ...base, action: 'remove' })).toEqual({ status: 'removed', recipient: 'conv-front', withdrawn: true });
    expect(inbox.getInboxItem(added.id)).toBeUndefined();
    expect(inbox.unreadInboxItems('conv-front')).toEqual([]);
    expect(handOverNow).toHaveBeenCalledTimes(1);
    expect(typesIn('conv-front')).toEqual(['input:queued', 'reaction:added', 'input:withdrawn', 'reaction:removed']);
    expect(foldReactions(log).get('h-12')).toBeUndefined();
  });

  it('announces a removal once the reaction has been delivered', async () => {
    await reactToMessage({ ...base, action: 'add' });
    inbox.markInboxItemsRead([inbox.unreadInboxItems('conv-front')[0].id], 40);
    expect(await reactToMessage({ ...base, action: 'remove' })).toEqual({ status: 'removed', recipient: 'conv-front', withdrawn: false });
    const [row] = inbox.unreadInboxItems('conv-front');
    expect(row.text).toBe('The user removed the 👍 reaction from your message "Release 906 is live."');
    expect(handOverNow).toHaveBeenLastCalledWith('conv-front', row.id);
  });

  it('announces a removal while a delivery holds the reaction, since the model may have it', async () => {
    await reactToMessage({ ...base, action: 'add' });
    inbox.reserveInboxItems([inbox.unreadInboxItems('conv-front')[0].id], 'batch-1');
    expect(await reactToMessage({ ...base, action: 'remove' })).toMatchObject({ withdrawn: false });
  });
});

describe('reactions in the inbox and the thread', () => {
  it('renders a reaction as its own line, with the time when batched', () => {
    const row = (id: string, source: 'user' | 'reaction', text: string) => ({
      id, session_id: 'conv-front', source, text, worker: null, worker_model: null,
      attachments_json: null, model: null, reasoning_effort: null, created_at: '2026-09-23T21:04:00.000Z', attempts: 0,
      last_error: null, read_at: null, read_seq: null, sender: null, passed_on: 0,
      source_seq: null, delivery_id: null, reserved_by: null, reserved_at: null, reservation_state: null,
      after_turn: 0,
    }) as inbox.InboxRow;
    const line = 'The user reacted 👍 to your message "Release 906 is live."';
    expect(inbox.composeInboxInput([row('r1', 'reaction', line)], 'lattice')).toBe(line);
    const batch = inbox.composeInboxInput([row('u1', 'user', 'carry on'), row('r1', 'reaction', line)], 'lattice');
    expect(batch).toContain(`${line} · ${new Date('2026-09-23T21:04:00.000Z').toTimeString().slice(0, 5)}`);
  });

  it('drops a withdrawn item from the fold, and keeps one a turn already read', () => {
    const event = (seq: number, type: string, data: unknown) =>
      ({ sessionId: 'conv-front', seq, runId: 'r', timestamp: seq, type, data }) as SessionEvent;
    const fold = foldInbox([
      event(1, 'input:queued', { id: 'a', source: 'reaction', text: 'x' }),
      event(2, 'input:queued', { id: 'b', source: 'reaction', text: 'y' }),
      event(3, 'input:sent', { text: 'y' }),
      event(4, 'input:read', { ids: ['b'] }),
      event(5, 'input:withdrawn', { ids: ['a', 'b'] }),
    ]);
    expect(fold.items.map((item) => item.id)).toEqual(['b']);
  });
});

describe('agentReact', () => {
  /** An event in conv-front's log, as the harness would have written it. */
  const write = (type: string, data: unknown) => {
    log.push({ sessionId: 'conv-front', seq: log.length + 1, type, data });
    return log.length;
  };
  const userTyped = (text: string) => write('input:sent', { text });
  const userQueued = (id: string, text: string) => write('input:queued', { id, source: 'user', text });
  const readBy = (ids: string[]) => {
    const sentSeq = write('input:sent', { text: '[Server note] batch' });
    write('input:read', { ids, sentSeq });
  };
  const shown = () => foldAgentReactions(log.filter((event) => event.sessionId === 'conv-front'));

  it('reacts to the latest of the user\'s messages the agent has read, not one still waiting', () => {
    userTyped('Start on the composer.');
    const read = userQueued('row-1', 'Link is going to the user.');
    readBy(['row-1']);
    userQueued('row-2', 'Not read yet.');

    expect(agentReact({ threadId: 'conv-front', emoji: '👀', action: 'add' }))
      .toEqual({ status: 'added', messageId: `h-${read}`, text: 'Link is going to the user.' });
    expect(shown().get(`h-${read}`)).toEqual(['👀']);
    // Nothing is delivered to anyone.
    expect(inbox.unreadInboxItems('conv-front')).toEqual([]);
    expect(handOverNow).not.toHaveBeenCalled();
  });

  it('skips worker reports, other agents\' messages and the batches that carried queued ones', () => {
    const typed = userTyped('Build it.');
    write('input:sent', { text: '[Report from worker conv-w1]\nDone.' });
    write('input:queued', { id: 'row-a', source: 'agent', sender: 'conv-w1', text: 'From a colleague' });
    readBy(['row-a']);

    expect(agentReact({ threadId: 'conv-front', emoji: '✅', action: 'add' })).toMatchObject({ status: 'added', messageId: `h-${typed}` });
  });

  it('reacts to the user\'s answer to its question when that is the latest, and skips one taken back', () => {
    userTyped('this is way too much');
    write('input:queued', { id: 'row-d1', source: 'decision', text: '[Answer] Merge' });
    const answered = write('decision:answered', { id: 'd-1', answer: 'Merge and restart', inboxId: 'row-d1' });
    readBy(['row-d1']);
    expect(agentReact({ threadId: 'conv-front', emoji: '👍', action: 'add' }))
      .toMatchObject({ status: 'added', messageId: `h-${answered}`, text: 'Merge and restart' });

    write('input:queued', { id: 'row-d2', source: 'decision', text: '[Answer] Wait' });
    const takenBack = write('decision:answered', { id: 'd-2', answer: 'Wait', inboxId: 'row-d2' });
    write('input:withdrawn', { ids: ['row-d2'] });
    expect(agentReact({ threadId: 'conv-front', emoji: '👍', action: 'add', messageId: `h-${takenBack}` }).status).toBe('no-message');
  });

  it('takes a reaction back, and changes nothing for a repeat', () => {
    const typed = userTyped('Build it.');
    agentReact({ threadId: 'conv-front', emoji: '👍', action: 'add' });
    expect(agentReact({ threadId: 'conv-front', emoji: '👍', action: 'add' })).toMatchObject({ status: 'unchanged' });
    expect(agentReact({ threadId: 'conv-front', emoji: '👍', action: 'remove' })).toMatchObject({ status: 'removed', messageId: `h-${typed}` });
    expect(shown().has(`h-${typed}`)).toBe(false);
    expect(typesIn('conv-front').filter((type) => type === 'reaction:agent')).toHaveLength(2);
  });

  it('reacts to a named message, and refuses one that is not the user\'s', () => {
    const first = userTyped('First.');
    userTyped('Second.');
    expect(agentReact({ threadId: 'conv-front', emoji: '👍', action: 'add', messageId: `h-${first}` })).toMatchObject({ status: 'added', text: 'First.' });
    expect(agentReact({ threadId: 'conv-front', emoji: '👍', action: 'add', messageId: 'h-999' }).status).toBe('no-message');
  });

  it('says so when the user has written nothing it has read', () => {
    userQueued('row-1', 'Waiting.');
    expect(agentReact({ threadId: 'conv-front', emoji: '👍', action: 'add' })).toEqual({
      status: 'no-message',
      reason: 'conv-front has no message from the user that it has read',
    });
  });

  it('accepts one emoji, and refuses shortcodes and words', () => {
    for (const emoji of ['👍', '👍🏽', '❤️', '🇬🇧', '1️⃣', '👨‍👩‍👧']) expect(isSingleEmoji(emoji)).toBe(true);
    for (const text of [':thumbsup:', '+1', 'ok', '👍👍', 'a👍']) expect(isSingleEmoji(text)).toBe(false);
  });
});
