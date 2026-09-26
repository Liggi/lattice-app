import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSessionStatusFromEvents } from '../../src/harness/derive-session-status.js';
import { SqliteEventStorageAdapter } from '../../src/harness/sqlite-event-storage.js';

describe('SqliteEventStorageAdapter.readStatusWindow', () => {
  it('finds lifecycle status events without parsing noisy custom-event tails', () => {
    const db = new Database(':memory:');
    try {
      const storage = new SqliteEventStorageAdapter(db);
      const insert = db.prepare(`
        INSERT INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run('conv-noisy', 1, 'run-1', 1, 'run:start', JSON.stringify({}), null);
      insert.run('conv-noisy', 2, 'run-1', 2, 'content', JSON.stringify({ blocks: [{ type: 'text', text: 'done' }] }), null);
      insert.run('conv-noisy', 3, 'run-1', 3, 'turn:end', JSON.stringify({}), null);

      for (let seq = 4; seq <= 1_000; seq++) {
        insert.run(
          'conv-noisy',
          seq,
          'run-1',
          seq,
          seq % 2 === 0 ? 'codex:rateLimits' : 'codex:mcpStatus',
          JSON.stringify({ seq }),
          null,
        );
      }

      const statusEvents = storage.readStatusWindow('conv-noisy', 20);
      expect(statusEvents.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(deriveSessionStatusFromEvents(statusEvents)).toMatchObject({
        status: 'idle',
        processAlive: true,
        harnessStatus: 'idle',
      });
    } finally {
      db.close();
    }
  });

  it('uses the latest lifecycle events for sessions larger than the default read cap', () => {
    const db = new Database(':memory:');
    try {
      const storage = new SqliteEventStorageAdapter(db);
      const insert = db.prepare(`
        INSERT INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run('conv-large', 1, 'run-1', 1, 'run:start', JSON.stringify({}), null);
      for (let seq = 2; seq <= 10_001; seq++) {
        insert.run(
          'conv-large',
          seq,
          'run-1',
          seq,
          'content',
          JSON.stringify({ blocks: [{ type: 'text', text: `chunk-${seq}` }] }),
          null,
        );
      }
      insert.run('conv-large', 10_002, 'run-1', 10_002, 'run:end', JSON.stringify({ reason: 'server_restart' }), null);

      const statusEvents = storage.readStatusWindow('conv-large', 20);
      expect(statusEvents.at(-1)?.seq).toBe(10_002);
      expect(deriveSessionStatusFromEvents(statusEvents)).toMatchObject({
        status: 'completed',
        processAlive: false,
        harnessStatus: 'idle',
      });
    } finally {
      db.close();
    }
  });
});
