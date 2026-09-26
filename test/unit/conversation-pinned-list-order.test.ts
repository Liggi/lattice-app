import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';

describe('conversation list pinned selection', () => {
  beforeEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  afterEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  it('selects an old pinned conversation before a newer unpinned one', async () => {
    const sessionInfo = new SessionInfoService(':memory:');
    await sessionInfo.initialize();
    const conversations = ConversationService.getInstance();

    const pinned = conversations.createConversation({
      provider: 'claude',
      providerSessionId: 'provider-pinned',
      workingDirectory: '/tmp/pinned',
    });
    const recent = conversations.createConversation({
      provider: 'claude',
      providerSessionId: 'provider-recent',
      workingDirectory: '/tmp/recent',
    });
    await sessionInfo.updateSessionInfo(pinned.conversationId, { archived: false, pinned: true });
    await sessionInfo.updateSessionInfo(recent.conversationId, { archived: false, pinned: false });

    const db = DatabaseProvider.getInstance().getDb();
    db.prepare('UPDATE conversations SET updated_at = ? WHERE conversation_id = ?')
      .run('2026-01-01T00:00:00.000Z', pinned.conversationId);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE conversation_id = ?')
      .run('2026-07-22T00:00:00.000Z', recent.conversationId);

    const listed = conversations.listConversations({ archived: false, limit: 1 });
    expect(listed.conversations.map(conversation => conversation.conversationId)).toEqual([
      pinned.conversationId,
    ]);
  });
});
