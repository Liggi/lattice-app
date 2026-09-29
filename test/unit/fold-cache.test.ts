import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SqliteEventStorageAdapter } from '../../src/harness/sqlite-event-storage.js';
import { cachedFold, clearFoldCache } from '../../src/services/sessions/fold-cache.js';

/**
 * The workers panel's folds are reused until an event of their types is
 * added or removed, and never across conversations or through a caller's
 * mutation of the result.
 */

const TYPES = ['worker:started', 'worker:reported'];
let seq = 0;

function insert(session: string, type: string): void {
  const db = DatabaseProvider.getInstance().getDb();
  seq += 1;
  db.prepare(
    `INSERT INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta) VALUES (?, ?, 'run', ?, ?, '{}', NULL)`,
  ).run(session, seq, seq, type);
}

beforeEach(() => {
  new SqliteEventStorageAdapter(DatabaseProvider.getInstance(':memory:').getDb());
  clearFoldCache();
  seq = 0;
});

afterEach(() => {
  DatabaseProvider.resetInstance();
});

describe('cachedFold', () => {
  it('folds again only when an event of its types arrives', () => {
    let folds = 0;
    const count = (events: unknown[]) => { folds += 1; return { n: events.length }; };
    insert('conv-a', 'worker:started');

    expect(cachedFold('n', 'conv-a', TYPES, count)).toEqual({ n: 1 });
    expect(cachedFold('n', 'conv-a', TYPES, count)).toEqual({ n: 1 });
    expect(folds).toBe(1);

    insert('conv-a', 'content');
    expect(cachedFold('n', 'conv-a', TYPES, count)).toEqual({ n: 1 });
    expect(folds).toBe(1);

    insert('conv-a', 'worker:reported');
    expect(cachedFold('n', 'conv-a', TYPES, count)).toEqual({ n: 2 });
    expect(folds).toBe(2);
  });

  it('notices an event of its types being removed', () => {
    const count = (events: unknown[]) => events.length;
    insert('conv-a', 'worker:started');
    insert('conv-a', 'worker:started');
    expect(cachedFold('n', 'conv-a', TYPES, count)).toBe(2);
    DatabaseProvider.getInstance().getDb().prepare(`DELETE FROM harness_events WHERE seq = 1`).run();
    expect(cachedFold('n', 'conv-a', TYPES, count)).toBe(1);
  });

  it('keeps conversations apart and hands each caller its own copy', () => {
    const list = (events: Array<{ seq: number }>) => events.map((event) => event.seq);
    insert('conv-a', 'worker:started');
    insert('conv-b', 'worker:started');

    const first = cachedFold('seqs', 'conv-a', TYPES, list);
    first.push(99);
    expect(cachedFold('seqs', 'conv-a', TYPES, list)).toEqual([1]);
    expect(cachedFold('seqs', 'conv-b', TYPES, list)).toEqual([2]);
  });
});
