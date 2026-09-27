/**
 * The activity-stream connect seed reads a bounded tail of each conversation's
 * harness event log instead of its whole history.
 *
 * What is being pinned here:
 *   - the read is bounded, and bounded by *status-bearing* events, so a codex
 *     session's dense codex:rateLimits tail cannot crowd the messages out;
 *   - the window grows when a tail of streamed text deltas merges into too few
 *     messages, and stops at a ceiling;
 *   - the assembled messages still carry tool names in the shape
 *     InsightsEngine.extractRecentActions reads them from.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { SqliteEventStorageAdapter } from '../../src/harness/sqlite-event-storage.js';
import { readSeedActivityMessages } from '../../src/services/sessions/recent-activity-messages.js';

const SESSION = 'conv-seed';

function insertEvents(db: Database.Database, events: Array<{ type: string; data: unknown }>): void {
  const insert = db.prepare(`
    INSERT INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  events.forEach((event, index) => {
    insert.run(SESSION, index + 1, 'run-1', 1_000 + index, event.type, JSON.stringify(event.data), null);
  });
}

function toolUse(name: string, id: string) {
  return { type: 'content', data: { messageId: id, blocks: [{ type: 'tool_use', id, name, input: {} }] } };
}

function toolNames(messages: ReturnType<typeof readSeedActivityMessages>): string[] {
  const names: string[] = [];
  for (const message of messages) {
    const content = message.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === 'object' && block && 'type' in block && block.type === 'tool_use' && 'name' in block) {
        names.push(String(block.name));
      }
    }
  }
  return names;
}

/** Counts every readStatusWindow call and the limit each asked for. */
function countingStorage(storage: SqliteEventStorageAdapter) {
  const limits: number[] = [];
  return {
    limits,
    readStatusWindow: (sessionId: string, limit: number) => {
      limits.push(limit);
      return storage.readStatusWindow(sessionId, limit);
    },
  };
}

describe('readSeedActivityMessages', () => {
  it('reads only the newest window, not the whole log', () => {
    const db = new Database(':memory:');
    try {
      const storage = new SqliteEventStorageAdapter(db);
      const events: Array<{ type: string; data: unknown }> = [];
      for (let i = 0; i < 2_000; i++) {
        events.push(toolUse(`Tool${i}`, `msg-${i}`));
      }
      insertEvents(db, events);

      const counting = countingStorage(storage);
      const messages = readSeedActivityMessages(counting, SESSION, { minWindow: 50, messageTarget: 10 });

      expect(counting.limits).toEqual([50]);
      expect(messages).toHaveLength(50);
      // Newest end of the log, not the oldest.
      expect(toolNames(messages).at(-1)).toBe('Tool1999');
      expect(toolNames(messages)[0]).toBe('Tool1950');
    } finally {
      db.close();
    }
  });

  it('ignores non-status events, so a noisy codex tail cannot empty the seed', () => {
    const db = new Database(':memory:');
    try {
      const storage = new SqliteEventStorageAdapter(db);
      const events: Array<{ type: string; data: unknown }> = [
        toolUse('Bash', 'msg-a'),
        toolUse('Read', 'msg-b'),
      ];
      // The shape that broke a raw readTail: hundreds of rate-limit events
      // sitting between the newest message and the end of the log.
      for (let i = 0; i < 500; i++) {
        events.push({ type: 'codex:rateLimits', data: { i } });
      }
      insertEvents(db, events);

      const messages = readSeedActivityMessages(storage, SESSION, { minWindow: 100 });
      expect(toolNames(messages)).toEqual(['Bash', 'Read']);
    } finally {
      db.close();
    }
  });

  it('grows the window when streamed deltas merge into too few messages', () => {
    const db = new Database(':memory:');
    try {
      const storage = new SqliteEventStorageAdapter(db);
      const events: Array<{ type: string; data: unknown }> = [];
      // 40 real tool calls, then one long streamed reply: 300 content events
      // that all share a messageId and merge down to a single message.
      for (let i = 0; i < 40; i++) events.push(toolUse(`Tool${i}`, `msg-${i}`));
      for (let i = 0; i < 300; i++) {
        events.push({ type: 'content', data: { messageId: 'streamed', blocks: [{ type: 'text', text: 'x' }] } });
      }
      insertEvents(db, events);

      const counting = countingStorage(storage);
      const messages = readSeedActivityMessages(counting, SESSION, {
        minWindow: 100,
        maxWindow: 4_000,
        messageTarget: 20,
      });

      // A single 100-event read would have returned one merged message.
      expect(counting.limits).toEqual([100, 400]);
      expect(messages.length).toBeGreaterThanOrEqual(20);
      expect(toolNames(messages).at(-1)).toBe('Tool39');
    } finally {
      db.close();
    }
  });

  it('stops growing at the ceiling rather than reading the whole log', () => {
    const db = new Database(':memory:');
    try {
      const storage = new SqliteEventStorageAdapter(db);
      const events: Array<{ type: string; data: unknown }> = [];
      for (let i = 0; i < 5_000; i++) {
        events.push({ type: 'content', data: { messageId: 'streamed', blocks: [{ type: 'text', text: 'x' }] } });
      }
      insertEvents(db, events);

      const counting = countingStorage(storage);
      const messages = readSeedActivityMessages(counting, SESSION, {
        minWindow: 100,
        maxWindow: 1_600,
        messageTarget: 40,
      });

      expect(counting.limits).toEqual([100, 400, 1_600]);
      expect(counting.limits.at(-1)).toBeLessThan(5_000);
      // Target never reachable here — everything merges into one message.
      expect(messages).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('stops early when the window already covers the whole session', () => {
    const db = new Database(':memory:');
    try {
      const storage = new SqliteEventStorageAdapter(db);
      insertEvents(db, [toolUse('Bash', 'msg-a')]);

      const counting = countingStorage(storage);
      const messages = readSeedActivityMessages(counting, SESSION, { minWindow: 100, messageTarget: 40 });

      expect(counting.limits).toEqual([100]);
      expect(toolNames(messages)).toEqual(['Bash']);
    } finally {
      db.close();
    }
  });

  it('returns nothing for a conversation with no events', () => {
    const db = new Database(':memory:');
    try {
      const storage = new SqliteEventStorageAdapter(db);
      expect(readSeedActivityMessages(storage, 'conv-empty')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('maps user input and tool results into the shape recent-action extraction reads', () => {
    const db = new Database(':memory:');
    try {
      const storage = new SqliteEventStorageAdapter(db);
      insertEvents(db, [
        { type: 'input:sent', data: { text: 'run the tests' } },
        toolUse('Bash', 'msg-a'),
        { type: 'result', data: { blocks: [{ type: 'tool_result', tool_use_id: 'msg-a', content: 'ok' }] } },
        { type: 'content', data: { messageId: 'msg-b', blocks: [{ type: 'text', text: 'all green' }] } },
      ]);

      const messages = readSeedActivityMessages(storage, SESSION);
      expect(messages.map((m) => m.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(toolNames(messages)).toEqual(['Bash']);
      // tool_result is flattened to text, matching the reader path this replaced.
      const resultContent = messages[2].message.content as Array<Record<string, unknown>>;
      expect(resultContent).toEqual([{ type: 'text', text: 'ok' }]);
    } finally {
      db.close();
    }
  });
});

// Guard against the type drifting away from what the route passes in.
export type _SeedEvent = SessionEvent;
