/**
 * Regression cover for the composer showing "Working" on an idle session.
 *
 * The history adapter serves a before-cursor read as `seq < cursor ORDER BY seq
 * DESC`, reversed into ascending order. The route asks for `limit + 1` rows to
 * detect hasMore, so the surplus row is the OLDEST one, at the front. Trimming
 * from the front instead discarded the NEWEST row of every page.
 *
 * That mattered most on cold load. The client backfills with
 * `before=MAX_SAFE_INTEGER`, so the newest row is the `turn:end` that ends the
 * session — dropping it left the client hydrated one event short, deriving
 * `streaming` from a log that is actually idle, and rendering a finished
 * session as still working with a Stop button.
 *
 * Forward reads (`afterSeq`) are already ascending out of SQLite, so their
 * surplus row genuinely is at the back. Both directions are pinned here.
 */

import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { deriveStatus } from '@liggi/agent-ui-harness/protocol';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { createHarnessRoutes } from '../../src/harness/routes.js';

function event(seq: number, type: SessionEvent['type']): SessionEvent {
  return {
    sessionId: 'conv-cold-load',
    runId: 'run-1',
    seq,
    timestamp: seq,
    type,
    data: {},
  };
}

const persisted = [
  ...Array.from({ length: 199 }, (_, index) => event(index + 1, 'content')),
  event(200, 'codex:threadStatus'),
  event(201, 'turn:end'),
];

function appWithStorage(log: SessionEvent[] = persisted) {
  // Mirror SqliteEventStorageAdapter.read(): a before-cursor read selects the
  // newest matching rows and returns them ascending; a forward read selects the
  // oldest rows after the cursor, also ascending.
  const readFromStorage = vi.fn((
    _sessionId: string,
    opts?: { afterSeq?: number; beforeSeq?: number; limit?: number },
  ) => {
    const limit = opts?.limit ?? 10000;
    if (opts?.beforeSeq !== undefined) {
      return log.filter(item => item.seq < opts.beforeSeq!).slice(-limit);
    }
    return log.filter(item => item.seq > (opts?.afterSeq ?? 0)).slice(0, limit);
  });

  const sessionManager = {
    getLog: () => null,
    countInStorage: () => log.length,
    inspect: () => null,
    readFromStorage,
  } as unknown as SessionManager;

  const app = express();
  app.use('/api/harness', createHarnessRoutes(sessionManager, {
    resolveResumeSessionId: id => id,
    resolveProvider: () => 'codex',
    resolveWorkingDirectory: () => '/tmp',
  }));
  return app;
}

describe('harness history cold-load status boundary', () => {
  it('keeps the newest turn:end so an idle session does not derive as streaming', async () => {
    const response = await request(appWithStorage())
      .get(`/api/harness/conv-cold-load/history?before=${Number.MAX_SAFE_INTEGER}&limit=200`);

    expect(response.status).toBe(200);
    expect(response.body.hasMore).toBe(true);
    expect(response.body.events).toHaveLength(200);

    // The page ends at the true tail of the log, not one short of it.
    expect(response.body.events.at(-1)).toMatchObject({ seq: 201, type: 'turn:end' });

    // The whole point: the served page agrees with the full log about status.
    expect(deriveStatus(persisted)).toBe('idle');
    expect(deriveStatus(response.body.events as SessionEvent[])).toBe('idle');
  });

  it('drops the surplus row from the older end of a before-cursor page', async () => {
    const response = await request(appWithStorage())
      .get(`/api/harness/conv-cold-load/history?before=${Number.MAX_SAFE_INTEGER}&limit=200`);

    // 201 rows were read to detect hasMore; the one dropped is the oldest,
    // so the window is [2..201] rather than [1..200].
    expect(response.body.events[0]).toMatchObject({ seq: 2 });
    expect(response.body.events.at(-1)).toMatchObject({ seq: 201 });
  });

  it('drops the surplus row from the newer end of a forward page', async () => {
    const response = await request(appWithStorage())
      .get('/api/harness/conv-cold-load/history?limit=50');

    expect(response.status).toBe(200);
    expect(response.body.hasMore).toBe(true);
    expect(response.body.events).toHaveLength(50);
    expect(response.body.events[0]).toMatchObject({ seq: 1 });
    expect(response.body.events.at(-1)).toMatchObject({ seq: 50 });
  });

  it('returns the whole log untrimmed when it fits inside the limit', async () => {
    const shortLog = [event(1, 'content'), event(2, 'content'), event(3, 'turn:end')];

    const response = await request(appWithStorage(shortLog))
      .get(`/api/harness/conv-cold-load/history?before=${Number.MAX_SAFE_INTEGER}&limit=200`);

    expect(response.body.hasMore).toBe(false);
    expect(response.body.events).toHaveLength(3);
    expect(response.body.events.at(-1)).toMatchObject({ seq: 3, type: 'turn:end' });
    expect(deriveStatus(response.body.events as SessionEvent[])).toBe('idle');
  });
});
