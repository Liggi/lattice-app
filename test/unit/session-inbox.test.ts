/**
 * Session inbox contract: what a session could not read when it arrived is
 * one durable row per item, drained into one turn when the session is idle,
 * and the thread shows each user item once — queued until read, then at the
 * point the turn took it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { CONFIG_DIR_NAME } from '../../src/utils/constants.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { createHarnessRoutes } from '../../src/harness/routes.js';
import { foldInbox } from '../../src/types/inbox.js';
import { placeWaitingMessages } from '../../src/web/chat/hooks/useHarnessSession.js';
import { __resetTurnAdmissionForTests, admitTurn } from '../../src/services/sessions/turn-admission.js';

const inspect = vi.fn<() => { processAlive: boolean; status: string; resumeId: string | null; runId?: string } | null>(() => null);
const appended: Array<{ sessionId: string; type: string; data: unknown }> = [];
let nextSeq = 100;

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({ inspect }),
}));
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  // Immediate delivery off: these cases cover the inbox path a mid-turn message takes without it.
  ConfigService: { getInstance: () => ({ getConfig: () => ({ server: { host: '0.0.0.0', port: 3999 }, messaging: { immediateDelivery: false } }) }) },
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_manager: unknown, sessionId: string, type: string, data: unknown) => {
    appended.push({ sessionId, type, data });
    nextSeq += 1;
    return { seq: nextSeq, type, data };
  },
}));

const inbox = await import('../../src/services/sessions/session-inbox.js');

beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  appended.length = 0;
  inspect.mockReset();
  inspect.mockReturnValue(null);
  __resetTurnAdmissionForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

function row(overrides: Partial<inbox.InboxRow>): inbox.InboxRow {
  return {
    id: 'i1', session_id: 'conv-c', source: 'user', text: 'hello', worker: null, worker_model: null,
    attachments_json: null, model: null, reasoning_effort: null, created_at: '2026-09-20T10:04:00.000Z',
    attempts: 0, last_error: null, read_at: null, read_seq: null, reply: null, reply_pending: 0,
    sender: null, passed_on: 0, source_seq: null, delivery_id: null, answers_id: null,
    reserved_by: null, reserved_at: null, reservation_state: null, ...overrides,
  };
}

describe('enqueue and read', () => {
  it('stores the item unread and marks the thread with a queued event carrying the text', () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    expect(inbox.unreadInboxItems('conv-c').map((r) => r.id)).toEqual([id]);
    expect(inbox.hasUnreadInboxItems('conv-c')).toBe(true);
    expect(appended).toEqual([{ sessionId: 'conv-c', type: 'input:queued', data: { id, source: 'user', text: 'use PEACH' } }]);

    inbox.markInboxItemsRead([id], 42);
    expect(inbox.hasUnreadInboxItems('conv-c')).toBe(false);
    expect(inbox.getInboxItem(id)).toMatchObject({ read_seq: 42 });
    expect(inbox.getInboxItem(id)?.read_at).not.toBeNull();
  });

  it('reports whether each worker\'s latest item has been read', () => {
    const first = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'worker-report', text: 'done', worker: 'conv-w1' });
    inbox.markInboxItemsRead([first]);
    inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'worker-question', text: 'which?', worker: 'conv-w1' });
    inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'worker-report', text: 'done', worker: 'conv-w2' });
    inbox.markInboxItemsRead(inbox.unreadInboxItems('conv-c').filter((r) => r.worker === 'conv-w2').map((r) => r.id));
    expect(inbox.latestWorkerItemReached('conv-c')).toEqual(new Map([['conv-w1', false], ['conv-w2', true]]));
  });
});

describe('composeInboxInput', () => {
  it('sends a single user message as written', () => {
    expect(inbox.composeInboxInput([row({ text: 'just this' })], 'lattice')).toBe('just this');
  });

  it('labels a batch by sender and arrival time, oldest first, under a server note', () => {
    const out = inbox.composeInboxInput([
      row({ id: 'a', text: 'first', created_at: '2026-09-20T10:04:00.000Z' }),
      row({ id: 'b', source: 'worker-report', worker: 'conv-w', worker_model: 'claude-opus-5', text: 'Fixed it.', created_at: '2026-09-20T10:05:00.000Z' }),
      row({ id: 'c', text: 'second', created_at: '2026-09-20T10:06:00.000Z' }),
    ], 'lattice');
    expect(out).toMatch(/^\[From the server: 3 items arrived while you were busy, oldest first\.\]\n\[End of server note\]\n/);
    expect(out.indexOf('[From the user · ')).toBeLessThan(out.indexOf('[Report from worker conv-w · claude-opus-5 · '));
    expect(out.indexOf('Fixed it.')).toBeLessThan(out.indexOf('second'));
    expect(out).not.toContain('may have reached you');
  });

  it('says an item may have been seen when a drain reached a send before', () => {
    expect(inbox.composeInboxInput([row({ attempts: 1 })], 'lattice'))
      .toMatch(/^\[From the server: this message may have reached you before the server restarted; check your last turn/);
    expect(inbox.composeInboxInput([row({ id: 'a' }), row({ id: 'b', attempts: 1 })], 'lattice'))
      .toContain('Some may have reached you before the server restarted');
  });
});

describe('drainInbox', () => {
  function stubSend(reply: { status: number; body: unknown }) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    });
    return calls;
  }

  it('sends every unread item in one turn and marks them read at the seq the route reports', async () => {
    const calls = stubSend({ status: 200, body: { ok: true, delivery: 'now', readSeq: 77 } });
    const a = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'one', model: 'gpt-5.5' });
    const b = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'worker-report', text: 'done', worker: 'conv-w' });

    await inbox.drainInbox('conv-c');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:3999/api/harness/conv-c/send');
    expect(calls[0].body.inboxIds).toEqual([a, b]);
    expect(calls[0].body.model).toBe('gpt-5.5');
    expect(calls[0].body.input).toContain('2 items arrived');
    expect(inbox.hasUnreadInboxItems('conv-c')).toBe(false);
    expect(inbox.getInboxItem(a)).toMatchObject({ read_seq: 77, attempts: 1 });
  });

  it('waits while the session is mid-turn', async () => {
    const calls = stubSend({ status: 200, body: { ok: true } });
    inspect.mockReturnValue({ processAlive: true, status: 'streaming', resumeId: null });
    inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'one' });
    await inbox.drainInbox('conv-c');
    expect(calls).toHaveLength(0);
    expect(inbox.hasUnreadInboxItems('conv-c')).toBe(true);
  });

  it('leaves items unread and says so when the route refuses; the attempt does not count', async () => {
    stubSend({ status: 409, body: { error: 'transcript pruned' } });
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'one' });
    await inbox.drainInbox('conv-c');
    expect(inbox.getInboxItem(id)).toMatchObject({ read_at: null, attempts: 0 });
    expect(inbox.getInboxItem(id)?.last_error).toContain('409');
    expect(appended.at(-1)).toMatchObject({ type: 'input:undeliverable', data: { ids: [id] } });
  });

  it('keeps the attempt counted when the request itself failed, so the next drain flags it', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('socket hang up'); });
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'one' });
    await inbox.drainInbox('conv-c');
    expect(inbox.getInboxItem(id)).toMatchObject({ read_at: null, attempts: 1 });
    expect(inbox.composeInboxInput(inbox.unreadInboxItems('conv-c'), 'lattice')).toContain('may have reached you');
  });
});

describe('/send inbox branch', () => {
  function build(opts: { provider: 'claude' | 'codex'; status?: string }) {
    const send = vi.fn(async () => {});
    const sessionManager = {
      start: vi.fn(async () => ({ runId: 'run-1', processId: 'p-1' })),
      send,
      getLog: () => null,
      countInStorage: () => 0,
      inspect: () => ({ processAlive: true, status: opts.status ?? 'idle', resumeId: null }),
      readFromStorage: () => [],
    } as unknown as SessionManager;
    const app = express();
    app.use(express.json());
    app.use('/api/harness', createHarnessRoutes(sessionManager, {
      resolveResumeSessionId: () => 'p-1',
      resolveProvider: () => opts.provider,
      resolveWorkingDirectory: () => '/tmp',
    }));
    return { app, send };
  }

  it('parks a mid-turn Codex message in the inbox instead of the process', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
    const { app, send } = build({ provider: 'codex', status: 'streaming' });
    const res = await request(app).post('/api/harness/conv-c/send').send({ input: 'use PEACH' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivery: 'after-turn' });
    expect(send).not.toHaveBeenCalled();
    expect(inbox.getInboxItem(res.body.inboxId as string)).toMatchObject({ source: 'user', text: 'use PEACH' });
  });

  it('writes a mid-turn Claude message to the process as before', async () => {
    const { app, send } = build({ provider: 'claude', status: 'streaming' });
    const res = await request(app).post('/api/harness/conv-c/send').send({ input: 'carry on' });
    expect(res.status).toBe(200);
    expect(res.body.delivery).toBe('after-turn');
    expect(send).toHaveBeenCalled();
    expect(inbox.hasUnreadInboxItems('conv-c')).toBe(false);
  });

  it('queues behind unread items so nothing overtakes what is already waiting', async () => {
    // The drain the route kicks off sees the session as mid-turn, so the rows stay to be inspected.
    inspect.mockReturnValue({ processAlive: true, status: 'streaming', resumeId: null });
    inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'worker-report', text: 'done', worker: 'conv-w' });
    const { app, send } = build({ provider: 'claude', status: 'idle' });
    const res = await request(app).post('/api/harness/conv-c/send').send({ input: 'and this' });
    expect(res.body.delivery).toBe('after-turn');
    expect(send).not.toHaveBeenCalled();
    expect(inbox.unreadInboxItems('conv-c').map((r) => r.text)).toEqual(['done', 'and this']);
  });

  it('refuses a drain while the session is mid-turn', async () => {
    const admission = await admitTurn('conv-c', 'drain');
    const { app, send } = build({ provider: 'codex', status: 'streaming' });
    const res = await request(app).post('/api/harness/conv-c/send').send({ input: 'batch', inboxIds: ['x'], admission: admission.id });
    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
    admission.release();
  });

  it('refuses an inbox batch from anything that does not hold the turn admission', async () => {
    const { app, send } = build({ provider: 'codex', status: 'idle' });
    const bare = await request(app).post('/api/harness/conv-c/send').send({ input: 'batch', inboxIds: ['x'] });
    expect(bare.status).toBe(409);
    const stale = await request(app).post('/api/harness/conv-c/send').send({ input: 'batch', inboxIds: ['x'], admission: 'not-a-live-admission' });
    expect(stale.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it('marks a drained batch read right after the input it produced', async () => {
    const admission = await admitTurn('conv-c', 'drain');
    const { app, send } = build({ provider: 'codex', status: 'idle' });
    const res = await request(app).post('/api/harness/conv-c/send').send({ input: 'batch', inboxIds: ['x', 'y'], admission: admission.id });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith('conv-c', 'batch', undefined);
    expect(appended).toEqual([{ sessionId: 'conv-c', type: 'input:read', data: { ids: ['x', 'y'] } }]);
    expect(res.body.readSeq).toBe(nextSeq);
    admission.release();
  });
});

describe('foldInbox', () => {
  let seq = 0;
  const ev = (type: string, data: unknown): SessionEvent => {
    seq += 1;
    return { seq, type, data, runId: 'run-1', timestamp: seq, sessionId: 'conv-c' } as unknown as SessionEvent;
  };
  beforeEach(() => { seq = 0; });

  it('shows a user item as queued until a turn reads it, then hides the batch input', () => {
    const queued = ev('input:queued', { id: 'a', source: 'user', text: 'one' });
    const waiting = foldInbox([queued]);
    expect(waiting.items).toMatchObject([{ id: 'a', source: 'user', readBySeq: null, legacy: false, event: queued }]);

    const events = [queued, ev('input:queued', { id: 'b', source: 'worker-report', text: 'done', worker: 'conv-w' })];
    const batch = ev('input:sent', { text: '[From the server: 2 items…' });
    events.push(batch, ev('input:read', { ids: ['a', 'b'] }));
    const read = foldInbox(events);
    expect(read.items.map((i) => [i.id, i.readBySeq])).toEqual([['a', batch.seq], ['b', batch.seq]]);
    expect([...read.hiddenInputSeqs]).toEqual([batch.seq]);
  });

  it('floats a message sent into the running turn once, then places it where the session read it', () => {
    const queued = ev('input:queued', { id: 'a', source: 'user', text: 'use PEACH' });
    const carried = ev('input:sent', { text: '[From the server: One message, delivered into the turn…]\nuse PEACH' });
    const delivered = ev('input:delivered', { inboxId: 'a', reservationId: 'r', items: 1, sentSeq: carried.seq, status: 'delivered' });
    const events = [queued, carried, delivered];

    const fold = foldInbox(events);
    expect([...fold.hiddenInputSeqs]).toEqual([carried.seq]);
    const waiting = placeWaitingMessages(events, fold);
    expect(waiting.pending.map((p) => p.inputEvent.seq)).toEqual([queued.seq]);
    expect(waiting.consumed).toEqual([]);

    // Claude takes it in only when its tool finishes, so it enters the thread
    // at the receipt, after the tool result, not at the batch that carried it.
    events.push(ev('result', { blocks: [] }));
    const read = ev('input:read', { ids: ['a'], sentSeq: carried.seq });
    events.push(read);
    const placed = placeWaitingMessages(events, foldInbox(events));
    expect(placed.pending).toEqual([]);
    expect(placed.consumed.map((c) => [c.inputEvent.seq, c.consumedByEvent.seq])).toEqual([[queued.seq, read.seq]]);
  });

  it('hides the carrying input of a delivery recorded before it named one', () => {
    const queued = ev('input:queued', { id: 'a', source: 'user', text: 'one' });
    const carried = ev('input:sent', { text: 'one' });
    const events = [queued, carried, ev('input:delivered', { inboxId: 'a', reservationId: 'r', items: 1, status: 'delivered' })];
    const fold = foldInbox(events);
    expect([...fold.hiddenInputSeqs]).toEqual([carried.seq]);
    expect(placeWaitingMessages(events, fold).pending.map((p) => p.inputEvent.seq)).toEqual([queued.seq]);
  });

  it('carries an undeliverable note until the next read clears it', () => {
    const events = [
      ev('input:queued', { id: 'a', source: 'user', text: 'one' }),
      ev('input:undeliverable', { ids: ['a'], error: '409 pruned' }),
    ];
    expect(foldInbox(events).items[0].undeliverable).toBe('409 pruned');
    events.push(ev('input:sent', { text: 'one' }), ev('input:read', { ids: ['a'] }));
    expect(foldInbox(events).items[0].undeliverable).toBeNull();
  });

  it('hides a drain batch even when its items are outside the loaded window', () => {
    const batch = ev('input:sent', { text: 'batch' });
    const fold = foldInbox([batch, ev('input:read', { ids: ['gone'] })]);
    expect([...fold.hiddenInputSeqs]).toEqual([batch.seq]);
  });

  it('keeps pre-inbox logs readable: queued pairs with its input, a restart copy is hidden', () => {
    const sent = ev('input:sent', { text: 'old style' });
    const events = [sent, ev('input:queued', { id: 'legacy-1' })];
    expect(foldInbox(events).items).toMatchObject([{ id: 'legacy-1', legacy: true, text: 'old style', event: sent }]);

    const copy = ev('input:sent', { text: 'old style' });
    events.push(copy, ev('input:resent', { id: 'legacy-1' }));
    expect([...foldInbox(events).hiddenInputSeqs]).toEqual([copy.seq]);
  });

  it('ignores command inputs when pairing', () => {
    const queued = ev('input:queued', { id: 'a', source: 'user', text: 'one' });
    const batch = ev('input:sent', { text: 'one' });
    const events = [queued, batch, ev('input:sent', { text: '/status', source: 'command' }), ev('input:read', { ids: ['a'] })];
    expect(foldInbox(events).items[0].readBySeq).toBe(batch.seq);
  });
});

describe('migration from the two old queues', () => {
  it('copies unread rows into session_inbox, strips the worker header, and drops the old tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-mig-'));
    const path = join(dir, CONFIG_DIR_NAME, 'session-info.db');
    try {
      mkdirSync(join(dir, CONFIG_DIR_NAME));
      const raw = new Database(path);
      raw.exec(`
        CREATE TABLE queued_user_messages (id TEXT PRIMARY KEY, session_id TEXT, provider TEXT, display_content TEXT,
          attachments_json TEXT, model TEXT, reasoning_effort TEXT, created_at TEXT, status TEXT, last_error TEXT);
        INSERT INTO queued_user_messages VALUES
          ('q1', 'conv-c', 'codex', 'still waiting', NULL, 'gpt-5.5', NULL, '2026-09-20T09:00:00.000Z', 'pending', NULL),
          ('q2', 'conv-c', 'codex', 'was mid-send', NULL, NULL, NULL, '2026-09-20T09:01:00.000Z', 'supplying', NULL),
          ('q3', 'conv-c', 'codex', 'already surfaced', NULL, NULL, NULL, '2026-09-20T09:02:00.000Z', 'failed', 'x'),
          ('q4', 'conv-d', 'claude', 'claude stdin', NULL, NULL, NULL, '2026-09-20T09:03:00.000Z', 'pending', NULL);
        CREATE TABLE worker_deliveries (id TEXT PRIMARY KEY, coordinator TEXT, worker TEXT, kind TEXT, input TEXT,
          created_at TEXT, status TEXT, last_error TEXT, sent_at TEXT);
        INSERT INTO worker_deliveries VALUES
          ('w1', 'conv-c', 'conv-w', 'report', '[Worker report from conv-w. The user has not read this]' || char(10) || char(10) || 'Fixed it.',
           '2026-09-20T09:04:00.000Z', 'pending', NULL, NULL),
          ('w2', 'conv-c', 'conv-w', 'question', '[Worker question from conv-w]' || char(10) || char(10) || 'Which?',
           '2026-09-20T09:05:00.000Z', 'sent', NULL, '2026-09-20T09:06:00.000Z');
      `);
      raw.close();

      DatabaseProvider.resetInstance();
      await new SessionInfoService(dir).initialize();
      const db = DatabaseProvider.getInstance().getDb();
      const rows = db.prepare('SELECT id, session_id, source, text, worker, attempts, read_at FROM session_inbox ORDER BY created_at').all();
      expect(rows).toEqual([
        { id: 'q1', session_id: 'conv-c', source: 'user', text: 'still waiting', worker: null, attempts: 0, read_at: null },
        { id: 'q2', session_id: 'conv-c', source: 'user', text: 'was mid-send', worker: null, attempts: 1, read_at: null },
        { id: 'w1', session_id: 'conv-c', source: 'worker-report', text: 'Fixed it.', worker: 'conv-w', attempts: 0, read_at: null },
        { id: 'w2', session_id: 'conv-c', source: 'worker-question', text: 'Which?', worker: 'conv-w', attempts: 0, read_at: '2026-09-20T09:06:00.000Z' },
      ]);
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('queued_user_messages', 'worker_deliveries')`).all();
      expect(tables).toEqual([]);
    } finally {
      DatabaseProvider.resetInstance();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
