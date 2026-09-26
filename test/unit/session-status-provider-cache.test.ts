/**
 * GET /status used to re-read a 200-row event window per live harness session
 * per poll, purely to answer "claude or codex?" — an answer that is fixed for
 * the session's whole life. It is now read once per session.
 */

import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { SqliteEventStorageAdapter } from '../../src/harness/sqlite-event-storage.js';
import { initEventMessageReader } from '../../src/harness/event-message-reader.js';
import {
  createSessionStatusRoutes,
  __resetStatusCachesForTests,
} from '../../src/routes/session/session-status.routes.js';

let db: Database.Database;
let windowReads: string[];

function seedRunStart(sessionId: string, provider: string | null): void {
  db.prepare(`
    INSERT INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta)
    VALUES (?, 1, 'run-1', 1000, 'run:start', ?, NULL)
  `).run(sessionId, JSON.stringify(provider ? { config: { extra: { provider } } } : { config: {} }));
}

function buildApp(sessionIds: string[]) {
  const app = express();
  app.use('/api/sessions', createSessionStatusRoutes({
    activeConversationRegistry: { getAll: () => [], get: () => undefined } as never,
    sessionInfoService: { getSessionInfoSync: () => null } as never,
    harnessSessionManager: {
      hasSession: (id: string) => sessionIds.includes(id),
      getStatus: () => 'idle',
      getSessionIds: () => sessionIds,
    },
  }));
  return app;
}

beforeEach(() => {
  __resetStatusCachesForTests();
  windowReads = [];
  db = new Database(':memory:');
  const storage = new SqliteEventStorageAdapter(db);
  const readStatusWindow = storage.readStatusWindow.bind(storage);
  storage.readStatusWindow = (sessionId: string, limit?: number): SessionEvent[] => {
    windowReads.push(sessionId);
    return readStatusWindow(sessionId, limit);
  };
  initEventMessageReader(storage);
});

afterEach(() => {
  db.close();
});

describe('GET /api/sessions/status provider inference', () => {
  it('reads the event window once per session no matter how often it is polled', async () => {
    seedRunStart('conv-codex', 'codex');
    seedRunStart('conv-claude', null);
    const app = buildApp(['conv-codex', 'conv-claude']);

    const first = await request(app).get('/api/sessions/status').expect(200);
    expect(first.body.sessions['conv-codex'].provider).toBe('codex');
    expect(first.body.sessions['conv-claude'].provider).toBeNull();
    expect(windowReads).toEqual(['conv-codex', 'conv-claude']);

    for (let poll = 0; poll < 5; poll++) {
      const again = await request(app).get('/api/sessions/status').expect(200);
      expect(again.body.sessions['conv-codex'].provider).toBe('codex');
      expect(again.body.sessions['conv-claude'].provider).toBeNull();
    }

    // Still two reads: the five extra polls added none.
    expect(windowReads).toEqual(['conv-codex', 'conv-claude']);
  });

  it('reads once for a session that appears later', async () => {
    seedRunStart('conv-codex', 'codex');
    seedRunStart('conv-late', 'codex');

    await request(buildApp(['conv-codex'])).get('/api/sessions/status').expect(200);
    expect(windowReads).toEqual(['conv-codex']);

    const second = await request(buildApp(['conv-codex', 'conv-late']))
      .get('/api/sessions/status')
      .expect(200);
    expect(second.body.sessions['conv-late'].provider).toBe('codex');
    expect(windowReads).toEqual(['conv-codex', 'conv-late']);
  });
});
