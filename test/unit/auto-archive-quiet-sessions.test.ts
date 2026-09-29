/**
 * The auto-archive sweep's candidate query, exercised against a real SQLite DB.
 *
 * The trap this pins down: quiet-ness has to be measured on the newest harness
 * event, not on `conversations.updated_at`. `updated_at` only moves on the
 * legacy /resume route and on segment changes, so a session worked in this
 * morning can carry an `updated_at` from months ago — cutting on it archives
 * live sessions by creation date.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  AUTO_ARCHIVE_AFTER_MS,
  AUTO_ARCHIVE_CANDIDATE_SQL,
} from '@/services/sessions/auto-archive-service.js';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
  id: string;
  /** Days before NOW that `conversations.updated_at` claims. */
  updatedDaysAgo: number;
  /** Days before NOW of the newest harness event, or null for no events. */
  lastEventDaysAgo: number | null;
  pinned?: boolean;
  archived?: boolean;
}

function seed(fixtures: Fixture[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE harness_events (
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
  `);

  for (const f of fixtures) {
    db.prepare('INSERT INTO conversations VALUES (?, ?)').run(
      f.id,
      new Date(NOW - f.updatedDaysAgo * DAY).toISOString().replace('T', ' ').replace('Z', ''),
    );
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
      f.id,
      f.pinned ? 1 : 0,
      f.archived ? 1 : 0,
    );
    if (f.lastEventDaysAgo !== null) {
      db.prepare('INSERT INTO harness_events VALUES (?, ?)').run(
        f.id,
        NOW - f.lastEventDaysAgo * DAY,
      );
    }
  }
  return db;
}

function candidates(fixtures: Fixture[]): string[] {
  const db = seed(fixtures);
  const rows = db.prepare(AUTO_ARCHIVE_CANDIDATE_SQL).all({ cutoff_ms: NOW - AUTO_ARCHIVE_AFTER_MS }) as Array<{
    session_id: string;
  }>;
  db.close();
  return rows.map(r => r.session_id);
}

describe('auto-archive candidate selection', () => {
  it('archives after seven quiet days', () => {
    expect(candidates([
      { id: 'conv-quiet', updatedDaysAgo: 30, lastEventDaysAgo: 8 },
      { id: 'conv-recent', updatedDaysAgo: 30, lastEventDaysAgo: 6 },
    ])).toEqual(['conv-quiet']);
  });

  // The week counts from falling asleep, which is 3 quiet hours in.
  it('archives a week after the session fell asleep, not a week after it went quiet', () => {
    const HOUR = 60 * 60 * 1000;
    expect(candidates([
      { id: 'conv-asleep-6d23h', updatedDaysAgo: 30, lastEventDaysAgo: 7 + 2 * HOUR / DAY },
      { id: 'conv-asleep-7d', updatedDaysAgo: 30, lastEventDaysAgo: 7 + 4 * HOUR / DAY },
    ])).toEqual(['conv-asleep-7d']);
  });

  // The bug the COALESCE/MAX exists to prevent: updated_at says months, the
  // event log says this morning. The event log wins.
  it('spares a session whose updated_at is stale but whose event log is fresh', () => {
    expect(candidates([
      { id: 'conv-worked-today', updatedDaysAgo: 90, lastEventDaysAgo: 0 },
    ])).toEqual([]);
  });

  it('falls back to updated_at when a conversation has no events at all', () => {
    expect(candidates([
      { id: 'conv-no-events-old', updatedDaysAgo: 90, lastEventDaysAgo: null },
      { id: 'conv-no-events-new', updatedDaysAgo: 2, lastEventDaysAgo: null },
    ])).toEqual(['conv-no-events-old']);
  });

  it('never archives a pinned session', () => {
    expect(candidates([
      { id: 'conv-pinned', updatedDaysAgo: 90, lastEventDaysAgo: 90, pinned: true },
    ])).toEqual([]);
  });

  it('skips sessions already archived', () => {
    expect(candidates([
      { id: 'conv-done', updatedDaysAgo: 90, lastEventDaysAgo: 90, archived: true },
    ])).toEqual([]);
  });

  it('returns the quietest session first', () => {
    expect(candidates([
      { id: 'conv-8d', updatedDaysAgo: 8, lastEventDaysAgo: 8 },
      { id: 'conv-40d', updatedDaysAgo: 40, lastEventDaysAgo: 40 },
      { id: 'conv-12d', updatedDaysAgo: 12, lastEventDaysAgo: 12 },
    ])).toEqual(['conv-40d', 'conv-12d', 'conv-8d']);
  });
});
