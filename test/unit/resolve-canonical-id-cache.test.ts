/**
 * resolveCanonicalId compiled the same SELECT on every call, and it runs on
 * hot list and insight paths. The statement is now cached per db handle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { resolveCanonicalId } from '../../src/services/sessions/resolve-canonical-id.js';

let db: Database.Database;

function makeDb(): Database.Database {
  const handle = new Database(':memory:');
  handle.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, conversation_id TEXT)');
  handle.prepare('INSERT INTO sessions (session_id, conversation_id) VALUES (?, ?)')
    .run('session-uuid-1', 'conv-one');
  handle.prepare('INSERT INTO sessions (session_id, conversation_id) VALUES (?, ?)')
    .run('session-uuid-2', null);
  return handle;
}

describe('resolveCanonicalId', () => {
  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('resolves a legacy session id to its conversation id', () => {
    expect(resolveCanonicalId(db, 'session-uuid-1')).toBe('conv-one');
  });

  it('returns the input unchanged when there is no mapping', () => {
    expect(resolveCanonicalId(db, 'session-uuid-2')).toBe('session-uuid-2');
    expect(resolveCanonicalId(db, 'session-unknown')).toBe('session-unknown');
    expect(resolveCanonicalId(db, 'conv-already')).toBe('conv-already');
    expect(resolveCanonicalId(db, '')).toBe('');
  });

  it('compiles the lookup once per database handle', () => {
    // Warm the cache before spying so the spy only sees repeat calls.
    resolveCanonicalId(db, 'session-uuid-1');

    const prepareSpy = vi.spyOn(db, 'prepare');
    for (let i = 0; i < 25; i++) {
      expect(resolveCanonicalId(db, 'session-uuid-1')).toBe('conv-one');
    }
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('compiles separately for a different handle', () => {
    resolveCanonicalId(db, 'session-uuid-1');

    const other = makeDb();
    try {
      const prepareSpy = vi.spyOn(other, 'prepare');
      expect(resolveCanonicalId(other, 'session-uuid-1')).toBe('conv-one');
      expect(prepareSpy).toHaveBeenCalledTimes(1);
    } finally {
      other.close();
    }
  });
});
