/**
 * SessionActivityWatcher takes a transcript change only as a trigger. The
 * actions it emits come from the conversation's harness event log, so a
 * transcript past a gigabyte (2026-09-27: 2302 failed 1.1 GB reads in a day,
 * one per write) costs nothing to watch.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteEventStorageAdapter } from '../../src/harness/sqlite-event-storage.js';
import { SessionActivityWatcher } from '../../src/services/sessions/session-activity-watcher.js';
import { readSeedActivityMessages } from '../../src/services/sessions/recent-activity-messages.js';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { runSessionInfoSchemaBootstrap } from '../../src/services/sessions/session-info-migrations.js';
import { createLogger } from '../../src/services/infrastructure/logger.js';

const PROVIDER_SESSION_ID = 'b0000000-0000-4000-8000-000000000001';
const CONVERSATION_ID = 'conv-watched';

beforeAll(() => {
  // The watcher builds an InsightsEngine, which prepares statements against
  // the session DB. Give it a migrated in-memory one.
  DatabaseProvider.resetInstance();
  runSessionInfoSchemaBootstrap(
    DatabaseProvider.getInstance(':memory:').getDb(),
    createLogger('SessionActivityWatcherTest'),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

function storageWithTools(names: string[]): { db: Database.Database; storage: SqliteEventStorageAdapter } {
  const db = new Database(':memory:');
  const storage = new SqliteEventStorageAdapter(db);
  const insert = db.prepare(`
    INSERT INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `);
  names.forEach((name, index) => {
    const id = `msg-${index}`;
    insert.run(CONVERSATION_ID, index + 1, 'run-1', 1_000 + index, 'content',
      JSON.stringify({ messageId: id, blocks: [{ type: 'tool_use', id, name, input: {} }] }));
  });
  return { db, storage };
}

describe('SessionActivityWatcher', () => {
  it('emits the conversation\'s newest actions from its event log, under its conv-* ID', () => {
    const { db, storage } = storageWithTools(['Read', 'Edit', 'Bash']);
    try {
      const watcher = new SessionActivityWatcher({
        resolveConversationId: (id) => (id === PROVIDER_SESSION_ID ? CONVERSATION_ID : null),
        readRecentMessages: (id) => readSeedActivityMessages(storage, id),
      });
      const updates: Array<{ sessionId: string; recentActions: Array<{ tool: string }> }> = [];
      watcher.on('activity', (update) => updates.push(update));

      watcher.extractAndEmit(PROVIDER_SESSION_ID);

      expect(updates).toHaveLength(1);
      expect(updates[0].sessionId).toBe(CONVERSATION_ID);
      expect(updates[0].recentActions.map((action) => action.tool)).toEqual(['Read', 'Edit', 'Bash']);
    } finally {
      db.close();
    }
  });

  it('reads nothing for a session Lattice did not start', () => {
    const readRecentMessages = vi.fn(() => []);
    const watcher = new SessionActivityWatcher({ resolveConversationId: () => null, readRecentMessages });
    const updates: unknown[] = [];
    watcher.on('activity', (update) => updates.push(update));

    watcher.extractAndEmit(PROVIDER_SESSION_ID);

    expect(readRecentMessages).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('reads once for a burst of writes to one transcript', () => {
    vi.useFakeTimers();
    const readRecentMessages = vi.fn(() => []);
    const watcher = new SessionActivityWatcher({ resolveConversationId: () => CONVERSATION_ID, readRecentMessages });
    const onFileChange = (watcher as unknown as { handleFileChange(filename: string): void }).handleFileChange.bind(watcher);

    for (let i = 0; i < 5; i++) onFileChange(`${PROVIDER_SESSION_ID}.jsonl`);
    vi.runAllTimers();

    expect(readRecentMessages).toHaveBeenCalledTimes(1);
  });
});
