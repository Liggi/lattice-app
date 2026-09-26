import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { reopenArchivedWorker, setArchived } from '../../src/session-history/repository.js';

/**
 * Archiving a worker is the coordinator saying it is done with it, and the
 * Workers panel drops an archived card entirely. A coordinator that archives a
 * worker and later gives it more work would otherwise leave it running where
 * neither the user nor the roster can see it.
 *
 * What `archived` alone cannot say is whether a session was ever meant to be
 * seen: a fixture created `--archived` and a worker archived once it reported
 * are the same row. `created_hidden` is that record, written when the row is
 * first inserted and never inferred afterwards.
 */
describe('a worker its coordinator sends more work to', () => {
  let sessionInfo: SessionInfoService;
  let conversations: ConversationService;
  let coordinator: string;

  beforeEach(async () => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
    sessionInfo = new SessionInfoService(':memory:');
    await sessionInfo.initialize();
    conversations = ConversationService.getInstance();
    coordinator = conversations.createConversation({
      provider: 'codex',
      providerSessionId: 'provider-coordinator',
      workingDirectory: '/tmp/project',
      coordinator: true,
    }).conversationId;
  });

  afterEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  const visible = (conversationId: string): boolean =>
    conversations.listConversations({ archived: false, limit: 50 })
      .conversations.some(conversation => conversation.conversationId === conversationId);

  const createdHidden = (conversationId: string): number | null => {
    const row = DatabaseProvider.getInstance().getDb()
      .prepare('SELECT created_hidden FROM sessions WHERE session_id = ?')
      .get(conversationId) as { created_hidden: number | null } | undefined;
    return row?.created_hidden ?? null;
  };

  /** An ordinary worker: created in the open, archived once it had reported. */
  async function ordinaryWorker(seed: string): Promise<string> {
    const worker = conversations.createConversation({
      provider: 'claude', providerSessionId: seed, workingDirectory: '/tmp/project', pickedUpFrom: coordinator,
    }).conversationId;
    await sessionInfo.updateSessionInfo(worker, { archived: false });
    return worker;
  }

  it('comes back into the project list when it was created in the open', async () => {
    const worker = await ordinaryWorker('provider-worker');
    expect(createdHidden(worker)).toBe(0);
    expect(setArchived(worker, true)).toBe(true);
    expect(visible(worker)).toBe(false);

    expect(reopenArchivedWorker(worker)).toBe(true);
    expect(visible(worker)).toBe(true);
  });

  it('writes nothing when the worker is not archived, so an ordinary answer is free', async () => {
    const worker = await ordinaryWorker('provider-worker-2');
    expect(reopenArchivedWorker(worker)).toBe(false);
  });

  it('stays hidden when it is a fixture created --from a coordinator and --archived', () => {
    const fixture = conversations.createConversation({
      provider: 'claude', providerSessionId: 'provider-fixture-worker', workingDirectory: '/tmp/project',
      pickedUpFrom: coordinator, archived: true,
    }).conversationId;
    expect(createdHidden(fixture)).toBe(1);

    // The send route's guard passes — this really is its coordinator — and the
    // recorded intent is the only thing keeping it out of the user's list.
    expect(conversations.getConversation(fixture)?.pickedUpFrom).toBe(coordinator);
    expect(reopenArchivedWorker(fixture)).toBe(false);
    expect(visible(fixture)).toBe(false);
  });

  it('stays hidden when it is a fixture coordinator, which has nobody to send to it', () => {
    const fixture = conversations.createConversation({
      provider: 'codex', providerSessionId: 'provider-fixture-coordinator', workingDirectory: '/tmp/fixture',
      coordinator: true, archived: true,
    }).conversationId;
    expect(createdHidden(fixture)).toBe(1);
    expect(reopenArchivedWorker(fixture)).toBe(false);
    expect(visible(fixture)).toBe(false);
  });

  it('is left alone when nobody recorded what it was, until an unarchive says', async () => {
    const legacy = await ordinaryWorker('provider-legacy');
    setArchived(legacy, true);
    // The state every row had before this column existed.
    DatabaseProvider.getInstance().getDb()
      .prepare('UPDATE sessions SET created_hidden = NULL WHERE session_id = ?').run(legacy);
    expect(createdHidden(legacy)).toBeNull();

    expect(reopenArchivedWorker(legacy)).toBe(false);
    expect(visible(legacy)).toBe(false);

    // Asking to see it is the statement that it was not meant to stay hidden.
    expect(setArchived(legacy, false)).toBe(true);
    expect(createdHidden(legacy)).toBe(0);
    expect(visible(legacy)).toBe(true);

    // From here it behaves like any ordinary worker.
    setArchived(legacy, true);
    expect(reopenArchivedWorker(legacy)).toBe(true);
  });

  it('does not let archiving a fixture for tidiness turn it into an ordinary session', () => {
    const fixture = conversations.createConversation({
      provider: 'claude', providerSessionId: 'provider-fixture-rearchived', workingDirectory: '/tmp/project',
      pickedUpFrom: coordinator, archived: true,
    }).conversationId;
    setArchived(fixture, true);
    expect(createdHidden(fixture)).toBe(1);
    expect(reopenArchivedWorker(fixture)).toBe(false);
  });
});
