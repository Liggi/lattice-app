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
  it('keeps a background subagent pending after its own output fills the window', () => {
    const db = new Database(':memory:');
    try {
      const storage = new SqliteEventStorageAdapter(db);
      const insert = db.prepare(`
        INSERT INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const add = (seq: number, type: string, data: unknown) =>
        insert.run('conv-sub', seq, 'run-1', seq, type, JSON.stringify(data), null);

      add(1, 'run:start', {});
      add(2, 'run:ready', {});
      add(3, 'content', { blocks: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: {} }], parentToolUseId: null });
      add(4, 'task:started', { taskId: 'a1', toolUseId: 'toolu_a', taskType: 'local_agent' });
      add(5, 'result', { blocks: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Async agent launched' }] });
      add(6, 'content', { blocks: [{ type: 'text', text: 'Waiting on: one lookup' }], parentToolUseId: null });
      add(7, 'turn:end', {});
      for (let seq = 8; seq < 400; seq++) {
        add(seq, 'content', { blocks: [{ type: 'text', text: `step ${seq}` }], parentToolUseId: 'toolu_a' });
      }

      expect(deriveSessionStatusFromEvents(storage.readStatusWindow('conv-sub', 200))).toMatchObject({
        status: 'idle',
        pendingWork: 'subagent',
      });

      add(400, 'task:updated', { taskId: 'a1', patch: { status: 'completed' } });
      expect(deriveSessionStatusFromEvents(storage.readStatusWindow('conv-sub', 200)).pendingWork).toBeNull();
    } finally {
      db.close();
    }
  });
});
