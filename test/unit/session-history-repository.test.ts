/**
 * The `lattice session` read path against a real (in-memory) SQLite DB.
 *
 * What these pin down is that "when was this session last used" comes from the
 * event log. `conversations.updated_at` is a write clock that only the legacy
 * /resume route and segment changes touch — on the live DB it still equals
 * `created_at` for 1458 of 1997 conversations, so listing or date-filtering by
 * it shows creation time and buries sessions worked on this morning.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '@/services/infrastructure/database-provider.js';
import {
  conversationExists,
  getLastActivityAt,
  getLatestModel,
  getStatusWindow,
  listSessions,
  searchSessions,
} from '@/session-history/repository.js';
import { displayStatusFor } from '@/cli/session-commands.js';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

interface Seed {
  id: string;
  /** ISO written to both created_at and updated_at — the stale write clock. */
  rowTime: string;
  archived?: boolean;
  initialPrompt?: string;
  events?: Array<{ type: string; data?: unknown; timestamp?: number }>;
  summary?: {
    project?: string;
    title?: string;
    summary?: string;
    notable?: string;
    tags?: string[];
  };
}

function seed(sessions: Seed[]): void {
  const db = DatabaseProvider.getInstance(':memory:').getDb();
  db.exec(`
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      working_directory TEXT NOT NULL DEFAULT '/tmp',
      workspace TEXT NOT NULL DEFAULT 'main',
      latest_provider TEXT,
      latest_segment_id TEXT,
      initial_prompt TEXT,
      picked_up_from TEXT,
      coordinator INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      custom_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      workspace TEXT NOT NULL DEFAULT 'main',
      conversation_id TEXT
    );
    CREATE TABLE session_summaries (
      session_id TEXT PRIMARY KEY,
      project TEXT, title TEXT, summary TEXT, notable TEXT,
      tags TEXT, files_touched TEXT, event_count INTEGER,
      started_at TEXT, ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'complete',
      generator_version TEXT, generator_model TEXT, generated_at TEXT
    );
    CREATE TABLE harness_events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      meta TEXT,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE session_insights (
      session_id TEXT PRIMARY KEY,
      theme TEXT, categories TEXT, computed_at TEXT NOT NULL DEFAULT '',
      stale INTEGER NOT NULL DEFAULT 0
    );
  `);

  for (const s of sessions) {
    db.prepare(
      `INSERT INTO conversations (conversation_id, created_at, updated_at, initial_prompt) VALUES (?, ?, ?, ?)`,
    ).run(s.id, s.rowTime, s.rowTime, s.initialPrompt ?? null);
    db.prepare(
      `INSERT INTO sessions (session_id, created_at, updated_at, archived, conversation_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(s.id, s.rowTime, s.rowTime, s.archived ? 1 : 0, s.id);

    let seq = 1;
    for (const e of s.events ?? []) {
      db.prepare(
        `INSERT INTO harness_events (session_id, seq, run_id, timestamp, type, data)
         VALUES (?, ?, 'run-1', ?, ?, ?)`,
      ).run(s.id, seq++, e.timestamp ?? NOW, e.type, JSON.stringify(e.data ?? {}));
    }

    if (s.summary) {
      db.prepare(
        `INSERT INTO session_summaries (session_id, project, title, summary, notable, tags, files_touched)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.id,
        s.summary.project ?? null,
        s.summary.title ?? null,
        s.summary.summary ?? null,
        s.summary.notable ?? null,
        JSON.stringify(s.summary.tags ?? []),
        JSON.stringify([]),
      );
    }
  }
}

beforeEach(() => {
  DatabaseProvider.resetInstance();
});

describe('last activity', () => {
  it('comes from the newest event, not from the write clock', () => {
    seed([
      {
        id: 'conv-old-row',
        rowTime: '2026-01-01T09:00:00.000Z',
        events: [{ type: 'turn:end', timestamp: NOW }],
      },
    ]);
    expect(getLastActivityAt('conv-old-row')).toBe(new Date(NOW).toISOString());
  });

  it('is null for a conversation that never produced an event', () => {
    seed([{ id: 'conv-empty', rowTime: '2026-08-17T09:00:00.000Z' }]);
    expect(getLastActivityAt('conv-empty')).toBeNull();
  });

  it('orders the list by it, so a January conversation used today sorts first', () => {
    seed([
      {
        id: 'conv-january-row',
        rowTime: '2026-01-01T09:00:00.000Z',
        events: [{ type: 'turn:end', timestamp: NOW }],
      },
      { id: 'conv-yesterday-row', rowTime: '2026-08-17T09:00:00.000Z' },
    ]);
    const items = listSessions({ limit: 10 });
    expect(items.map((i) => i.conversationId)).toEqual(['conv-january-row', 'conv-yesterday-row']);
    // The stale clock is still reported, so nothing silently rewrites history.
    expect(items[0].updatedAt).toBe('2026-01-01T09:00:00.000Z');
    expect(items[0].lastActivityAt).toBe(new Date(NOW).toISOString());
  });
});

describe('--since / --today filtering', () => {
  const fixtures: Seed[] = [
    {
      // Created in January, worked on today: --today must keep it.
      id: 'conv-active-today',
      rowTime: '2026-01-01T09:00:00.000Z',
      events: [{ type: 'turn:end', timestamp: NOW }],
    },
    {
      // Row written today, but nothing has happened since last year.
      id: 'conv-stale-but-new-row',
      rowTime: '2026-08-18T09:00:00.000Z',
      events: [{ type: 'turn:end', timestamp: NOW - 300 * DAY }],
    },
    {
      id: 'conv-archived-today',
      rowTime: '2026-08-18T09:00:00.000Z',
      archived: true,
      events: [{ type: 'turn:end', timestamp: NOW }],
    },
  ];

  it('filters on activity, not on the row timestamps', () => {
    seed(fixtures);
    const ids = listSessions({ limit: 10, sinceMs: NOW - DAY }).map((i) => i.conversationId);
    expect(ids).toContain('conv-active-today');
    expect(ids).not.toContain('conv-stale-but-new-row');
  });

  it('drops archived sessions by default', () => {
    seed(fixtures);
    const ids = listSessions({ limit: 10, sinceMs: NOW - DAY }).map((i) => i.conversationId);
    expect(ids).not.toContain('conv-archived-today');
  });

  it('composes with --all so archived-today is not lost', () => {
    seed(fixtures);
    const ids = listSessions({ limit: 10, sinceMs: NOW - DAY, includeArchived: true }).map(
      (i) => i.conversationId,
    );
    expect(ids).toContain('conv-archived-today');
    expect(ids).toContain('conv-active-today');
  });

  it('composes with --project', () => {
    seed([
      ...fixtures,
      {
        id: 'conv-other-project',
        rowTime: '2026-08-18T09:00:00.000Z',
        events: [{ type: 'turn:end', timestamp: NOW }],
        summary: { project: 'lattice' },
      },
    ]);
    const ids = listSessions({ limit: 10, sinceMs: NOW - DAY, project: 'lattice' }).map(
      (i) => i.conversationId,
    );
    expect(ids).toEqual(['conv-other-project']);
  });
});

describe('model', () => {
  it('reads the model off run:ready', () => {
    seed([
      {
        id: 'conv-m',
        rowTime: '2026-08-18T09:00:00.000Z',
        events: [{ type: 'run:ready', data: { resumeId: 'r', model: 'claude-opus-5' } }],
      },
    ]);
    expect(getLatestModel('conv-m')).toBe('claude-opus-5');
    expect(listSessions({ limit: 5 })[0].model).toBe('claude-opus-5');
  });

  it('falls back to content events for sessions recorded before run:ready carried one', () => {
    seed([
      {
        id: 'conv-legacy',
        rowTime: '2026-08-18T09:00:00.000Z',
        events: [
          { type: 'run:ready', data: { resumeId: 'r' } },
          { type: 'content', data: { blocks: [], messageId: 'm', model: 'gpt-5.6-sol' } },
        ],
      },
    ]);
    expect(getLatestModel('conv-legacy')).toBe('gpt-5.6-sol');
  });

  it('is null when no event ever named one', () => {
    seed([
      {
        id: 'conv-nomodel',
        rowTime: '2026-08-18T09:00:00.000Z',
        events: [{ type: 'turn:end' }],
      },
    ]);
    expect(getLatestModel('conv-nomodel')).toBeNull();
  });
});

describe('conversationExists', () => {
  it('is false for an id nobody has ever seen', () => {
    seed([{ id: 'conv-real', rowTime: '2026-08-18T09:00:00.000Z' }]);
    expect(conversationExists('conv-typo')).toBe(false);
  });

  it('is true for a row with no events', () => {
    seed([{ id: 'conv-real', rowTime: '2026-08-18T09:00:00.000Z' }]);
    expect(conversationExists('conv-real')).toBe(true);
  });
});

describe('derived status', () => {
  function statusOf(events: Array<{ type: string; data?: unknown }>): string {
    seed([{ id: 'conv-s', rowTime: '2026-08-18T09:00:00.000Z', events }]);
    return displayStatusFor('conv-s');
  }

  it('reads mid-turn output as running', () => {
    expect(
      statusOf([
        { type: 'run:start', data: { config: {} } },
        { type: 'run:ready', data: { resumeId: 'r' } },
        { type: 'input:sent', data: { text: 'go' } },
        { type: 'content', data: { blocks: [{ type: 'text', text: 'working' }] } },
      ]),
    ).toBe('running');
  });

  it('reads a finished turn on a live process as idle', () => {
    expect(
      statusOf([
        { type: 'run:start', data: { config: {} } },
        { type: 'run:ready', data: { resumeId: 'r' } },
        { type: 'input:sent', data: { text: 'go' } },
        { type: 'turn:end', data: {} },
      ]),
    ).toBe('idle');
  });

  it('reads an exited process as done', () => {
    expect(
      statusOf([
        { type: 'run:start', data: { config: {} } },
        { type: 'run:ready', data: { resumeId: 'r' } },
        { type: 'turn:end', data: {} },
        { type: 'run:end', data: { reason: 'completed' } },
      ]),
    ).toBe('done');
  });

  it('reads a stop request as stopping', () => {
    expect(
      statusOf([
        { type: 'run:ready', data: { resumeId: 'r' } },
        { type: 'input:sent', data: { text: 'go' } },
        { type: 'stop:requested', data: {} },
      ]),
    ).toBe('stopping');
  });

  it('reads a session with no events at all as done', () => {
    seed([{ id: 'conv-s', rowTime: '2026-08-18T09:00:00.000Z' }]);
    expect(displayStatusFor('conv-s')).toBe('done');
  });

  it('reads only status-bearing events, the same window the status endpoint uses', () => {
    seed([
      {
        id: 'conv-s',
        rowTime: '2026-08-18T09:00:00.000Z',
        events: [
          { type: 'turn:end', data: {} },
          { type: 'codex:rateLimits', data: {} },
        ],
      },
    ]);
    expect(getStatusWindow('conv-s').map((e) => e.type)).toEqual(['turn:end']);
  });
});

describe('search', () => {
  const corpus: Seed[] = [
    {
      id: 'conv-title-hit',
      rowTime: '2026-08-18T09:00:00.000Z',
      events: [{ type: 'turn:end', timestamp: NOW }],
      summary: { project: 'lattice', title: 'Rework the session CLI', summary: 'Nothing here.' },
    },
    {
      id: 'conv-body-hit',
      rowTime: '2026-08-17T09:00:00.000Z',
      events: [{ type: 'turn:end', timestamp: NOW - DAY }],
      summary: { project: 'ash', title: 'Unrelated', summary: 'Fixed the daemon reaper timeout.' },
    },
    {
      id: 'conv-tag-hit',
      rowTime: '2026-08-16T09:00:00.000Z',
      archived: true,
      events: [{ type: 'turn:end', timestamp: NOW - 2 * DAY }],
      summary: { title: 'Archived work', tags: ['concern:timeout'] },
    },
    {
      id: 'conv-unsummarized',
      rowTime: '2026-08-15T09:00:00.000Z',
      events: [{ type: 'turn:end', timestamp: NOW - 3 * DAY }],
    },
  ];

  it('matches titles and says which field hit', () => {
    seed(corpus);
    const hits = searchSessions('session cli');
    expect(hits.map((h) => h.item.conversationId)).toEqual(['conv-title-hit']);
    expect(hits[0].field).toBe('title');
    expect(hits[0].excerpt).toContain('Rework the session CLI');
  });

  it('matches summary bodies, quoting the text around the match', () => {
    seed(corpus);
    const hits = searchSessions('reaper');
    expect(hits[0].item.conversationId).toBe('conv-body-hit');
    expect(hits[0].field).toBe('summary');
    expect(hits[0].excerpt).toContain('reaper');
  });

  it('matches tags and includes archived sessions', () => {
    seed(corpus);
    const hits = searchSessions('concern:timeout');
    expect(hits.map((h) => h.item.conversationId)).toEqual(['conv-tag-hit']);
    expect(hits[0].item.archived).toBe(true);
  });

  it('is case-insensitive', () => {
    seed(corpus);
    expect(searchSessions('REAPER')).toHaveLength(1);
  });

  it('returns hits newest-activity first and honours the limit', () => {
    seed(corpus);
    const hits = searchSessions('e', { limit: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0].item.conversationId).toBe('conv-title-hit');
  });

  it('finds a session with no summary by its first message', () => {
    seed(corpus.map((s) =>
      s.id === 'conv-unsummarized' ? { ...s, initialPrompt: 'Add Slack-style emoji reactions to messages' } : s));
    const hits = searchSessions('emoji');
    expect(hits.map((h) => h.item.conversationId)).toEqual(['conv-unsummarized']);
    expect(hits[0].field).toBe('prompt');
    expect(hits[0].excerpt).toContain('emoji reactions');
    expect(searchSessions('reaper').map((h) => h.item.conversationId)).toEqual(['conv-body-hit']);
  });

  it('returns nothing for an empty query instead of everything', () => {
    seed(corpus);
    expect(searchSessions('   ')).toEqual([]);
  });
});
