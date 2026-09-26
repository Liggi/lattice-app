import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';

/**
 * A coordinator is a project in the user's sidebar from the moment its row exists
 * and is not archived, so a verification fixture has to be created archived
 * rather than archived afterwards. Archiving after the fact leaves it visible
 * for the gap between the two writes.
 */
describe('creating a conversation already archived', () => {
  beforeEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  afterEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  it('keeps a fixture coordinator out of the project list from the first write', async () => {
    const sessionInfo = new SessionInfoService(':memory:');
    await sessionInfo.initialize();
    const conversations = ConversationService.getInstance();

    const fixture = conversations.createConversation({
      provider: 'codex',
      providerSessionId: 'provider-fixture',
      workingDirectory: '/tmp/fixture',
      coordinator: true,
      archived: true,
    });

    // The state the sidebar reads, checked with no further writes in between:
    // the archived flag is part of the same transaction as the conversation.
    const db = DatabaseProvider.getInstance().getDb();
    const row = db.prepare('SELECT archived FROM sessions WHERE session_id = ?')
      .get(fixture.conversationId) as { archived: number } | undefined;
    expect(row?.archived).toBe(1);

    const listed = conversations.listConversations({ archived: false, limit: 50 });
    expect(listed.conversations.map(conversation => conversation.conversationId))
      .not.toContain(fixture.conversationId);
  });

  it('leaves an ordinary coordinator visible', async () => {
    const sessionInfo = new SessionInfoService(':memory:');
    await sessionInfo.initialize();
    const conversations = ConversationService.getInstance();

    const project = conversations.createConversation({
      provider: 'codex',
      providerSessionId: 'provider-project',
      workingDirectory: '/tmp/project',
      coordinator: true,
    });
    await sessionInfo.updateSessionInfo(project.conversationId, { archived: false });

    const listed = conversations.listConversations({ archived: false, limit: 50 });
    expect(listed.conversations.map(conversation => conversation.conversationId))
      .toContain(project.conversationId);
  });
});
