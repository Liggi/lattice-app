import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';

/**
 * The Archived list used to be "archived rows among the most recently active
 * conversations", re-sorted by creation time, so a session archived a moment
 * ago could sit far down it. It is ordered by when each was archived now.
 */
describe('archived conversation list', () => {
  beforeEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  afterEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  async function setup() {
    const sessionInfo = new SessionInfoService(':memory:');
    await sessionInfo.initialize();
    const conversations = ConversationService.getInstance();
    const make = async (name: string) => {
      const { conversationId } = conversations.createConversation({
        provider: 'claude',
        providerSessionId: `provider-${name}`,
        workingDirectory: `/tmp/${name}`,
      });
      await sessionInfo.updateSessionInfo(conversationId, { archived: false });
      return conversationId;
    };
    return { sessionInfo, conversations, make, db: DatabaseProvider.getInstance().getDb() };
  }

  it('puts the session archived last first, whatever its age, and says when', async () => {
    const { sessionInfo, conversations, make, db } = await setup();
    const old = await make('old');
    const recent = await make('recent');
    const live = await make('live');
    db.prepare('UPDATE conversations SET created_at = ?, updated_at = ? WHERE conversation_id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', old);

    await sessionInfo.updateSessionInfo(recent, { archived: true });
    db.prepare(`UPDATE sessions SET archived_at = '2026-09-01T00:00:00.000Z' WHERE session_id = ?`).run(recent);
    await sessionInfo.updateSessionInfo(old, { archived: true });

    const listed = conversations.listConversations({ archived: true }).conversations;
    expect(listed.map((c) => c.conversationId)).toEqual([old, recent]);
    expect(listed.map((c) => c.conversationId)).not.toContain(live);
    expect(Date.now() - Date.parse(listed[0].archivedAt ?? '')).toBeLessThan(60_000);
  });

  it('clears the archive time on unarchive and stamps it again on the next archive', async () => {
    const { sessionInfo, make, db } = await setup();
    const id = await make('flip');
    const archivedAt = () =>
      (db.prepare('SELECT archived_at FROM sessions WHERE session_id = ?').get(id) as { archived_at: string | null }).archived_at;

    await sessionInfo.updateSessionInfo(id, { archived: true });
    expect(archivedAt()).not.toBeNull();
    await sessionInfo.updateSessionInfo(id, { archived: false });
    expect(archivedAt()).toBeNull();
    await sessionInfo.updateSessionInfo(id, { archived: true });
    expect(archivedAt()).not.toBeNull();
  });

  it('keeps the first archive time when an archived session is written again', async () => {
    const { sessionInfo, make, db } = await setup();
    const id = await make('rename');
    await sessionInfo.updateSessionInfo(id, { archived: true });
    db.prepare(`UPDATE sessions SET archived_at = '2026-09-01T00:00:00.000Z' WHERE session_id = ?`).run(id);
    await sessionInfo.updateSessionInfo(id, { custom_name: 'renamed' });
    expect((db.prepare('SELECT archived_at FROM sessions WHERE session_id = ?').get(id) as { archived_at: string }).archived_at)
      .toBe('2026-09-01T00:00:00.000Z');
  });
});
