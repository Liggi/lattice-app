/**
 * A side chat added to the thread is context, not a request: its inbox item
 * never starts a turn or counts as work waiting, and it goes in with whatever
 * the session reads next.
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
const { firstQuestionPrompt, parseShortAnswers } = await import('../../src/services/side-questions/side-questions.js');
const { stripContextRestore } = await import('../../src/types/worker-events.js');

const SESSION = 'conv-main';

beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
});
afterEach(() => {
  vi.unstubAllGlobals();
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('side question in the inbox', () => {
  it('is not work waiting, except to the send route, which batches a message with it', () => {
    inbox.enqueueInboxItem({ sessionId: SESSION, source: 'side-question', text: 'context' });
    expect(inbox.hasUnreadInboxItems(SESSION)).toBe(false);
    expect(inbox.hasUnreadInboxItems(SESSION, { includeRideAlong: true })).toBe(true);
    expect(inbox.sessionsWithUnreadInbox()).toEqual([]);
    expect(inbox.unreadInboxSummaries([SESSION], 'conv-front').get(SESSION)).toBeUndefined();
  });

  it('never drains on its own, and goes in with the next message', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ readSeq: 7 }), { status: 200 }));
    vi.stubGlobal('fetch', send);
    inbox.enqueueInboxItem({ sessionId: SESSION, source: 'side-question', text: 'side chat context' });

    await inbox.drainInbox(SESSION);
    expect(send).not.toHaveBeenCalled();

    inbox.enqueueInboxItem({ sessionId: SESSION, source: 'user', text: 'carry on' });
    await inbox.drainInbox(SESSION);
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse((send.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { input: string; inboxIds: string[] };
    expect(body.inboxIds).toHaveLength(2);
    expect(body.input).toContain('side chat context');
    expect(body.input).toContain('carry on');
  });
});

describe('parseShortAnswers', () => {
  it('takes one answer per question', () => {
    expect(parseShortAnswers('{"answers": ["Yes.", "No."]}', 2)).toEqual(['Yes.', 'No.']);
  });

  it('refuses a count that does not match rather than guessing', () => {
    expect(() => parseShortAnswers('{"answers": ["Yes."]}', 2)).toThrow();
  });
});

describe('side chat session', () => {
  it('shows only the question in its thread; the passage travels in a server note', () => {
    const prompt = firstQuestionPrompt('A drain delivers the unread rows', 'Which function is it?');
    expect(prompt).toContain('> A drain delivers the unread rows');
    expect(stripContextRestore(prompt)).toBe('Which function is it?');
  });

  it('is created hidden, so it is in neither the sidebar nor the archive', () => {
    const conversations = ConversationService.getInstance();
    conversations.createConversation({ workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'psid-side', archived: true });
    expect(conversations.listConversations({ archived: true, limit: 50, offset: 0 }).conversations).toEqual([]);
    expect(conversations.listConversations({ archived: false, limit: 50, offset: 0 }).conversations).toEqual([]);
  });
});
