/**
 * What a coordinator can see about its own undelivered instructions: for each
 * worker, how many messages are queued, how many of them it sent itself, and
 * how old the oldest is. Queued and read are the only two states — a read
 * item is one a turn was handed, not one the worker acted on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';

vi.mock('../../src/harness/setup.js', () => ({ getHarnessSessionManager: () => null }));
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: { getInstance: () => ({ getConfig: () => ({ server: { host: '0.0.0.0', port: 3999 } }) }) },
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: () => ({ seq: 1 }),
}));

const inbox = await import('../../src/services/sessions/session-inbox.js');

const FRONT = 'conv-front';
const WORKER = 'conv-w1';
const OTHER = 'conv-w2';

beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
});
afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('unreadInboxSummaries', () => {
  it('says nothing about a worker with nothing queued', () => {
    expect(inbox.unreadInboxSummaries([WORKER], FRONT).get(WORKER)).toBeUndefined();
  });

  it('counts what is queued and separates the coordinator\'s own messages from everyone else\'s', () => {
    inbox.enqueueInboxItem({ sessionId: WORKER, source: 'agent', text: 'proceed with the RPC', sender: FRONT });
    inbox.enqueueInboxItem({ sessionId: WORKER, source: 'agent', text: 'context boundary facts', sender: 'conv-peer' });
    inbox.enqueueInboxItem({ sessionId: WORKER, source: 'user', text: 'from the user' });

    expect(inbox.unreadInboxSummaries([WORKER], FRONT).get(WORKER))
      .toMatchObject({ count: 3, fromYou: 1 });
  });

  it('drops a message from the count once a turn has read it', () => {
    const first = inbox.enqueueInboxItem({ sessionId: WORKER, source: 'agent', text: 'one', sender: FRONT });
    const second = inbox.enqueueInboxItem({ sessionId: WORKER, source: 'agent', text: 'two', sender: FRONT });
    expect(inbox.unreadInboxSummaries([WORKER], FRONT).get(WORKER)).toMatchObject({ count: 2, fromYou: 2 });

    inbox.markInboxItemsRead([first], 91);
    expect(inbox.unreadInboxSummaries([WORKER], FRONT).get(WORKER)).toMatchObject({ count: 1, fromYou: 1 });

    inbox.markInboxItemsRead([second], 92);
    expect(inbox.unreadInboxSummaries([WORKER], FRONT).get(WORKER)).toBeUndefined();
  });

  it('dates the wait from the oldest unread message, not the newest', () => {
    const old = inbox.enqueueInboxItem({ sessionId: WORKER, source: 'agent', text: 'first', sender: FRONT });
    inbox.enqueueInboxItem({ sessionId: WORKER, source: 'agent', text: 'second', sender: FRONT });
    const at = (id: string) => Date.parse(inbox.getInboxItem(id)!.created_at);

    expect(inbox.unreadInboxSummaries([WORKER], FRONT).get(WORKER)!.oldestAt).toBe(at(old));
  });

  it('keeps each worker separate and asks for all of them at once', () => {
    inbox.enqueueInboxItem({ sessionId: WORKER, source: 'agent', text: 'a', sender: FRONT });
    inbox.enqueueInboxItem({ sessionId: OTHER, source: 'agent', text: 'b', sender: FRONT });
    inbox.enqueueInboxItem({ sessionId: OTHER, source: 'agent', text: 'c', sender: FRONT });

    const summaries = inbox.unreadInboxSummaries([WORKER, OTHER], FRONT);
    expect(summaries.get(WORKER)!.count).toBe(1);
    expect(summaries.get(OTHER)!.count).toBe(2);
  });

  it('counts a worker\'s report waiting at its coordinator the same way', () => {
    inbox.enqueueInboxItem({ sessionId: FRONT, source: 'worker-report', text: 'done', worker: WORKER });
    expect(inbox.unreadInboxSummaries([FRONT], FRONT).get(FRONT)).toMatchObject({ count: 1, fromYou: 0 });
  });

  it('asks nothing of the database when there are no sessions to ask about', () => {
    expect(inbox.unreadInboxSummaries([], FRONT).size).toBe(0);
  });

  // The workers route derives the card's `queued` flag from this map rather
  // than asking per worker, so presence in it has to mean exactly what
  // `hasUnreadInboxItems` meant.
  it('is present for a worker exactly when that worker has something unread', () => {
    const has = () => inbox.unreadInboxSummaries([WORKER], FRONT).has(WORKER);
    expect(has()).toBe(inbox.hasUnreadInboxItems(WORKER));

    const id = inbox.enqueueInboxItem({ sessionId: WORKER, source: 'agent', text: 'proceed', sender: FRONT });
    expect(has()).toBe(true);
    expect(has()).toBe(inbox.hasUnreadInboxItems(WORKER));

    inbox.markInboxItemsRead([id], 91);
    expect(has()).toBe(false);
    expect(has()).toBe(inbox.hasUnreadInboxItems(WORKER));
  });
});
