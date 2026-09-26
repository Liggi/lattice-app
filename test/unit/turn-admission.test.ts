/**
 * Turn admission and the interrupting send: one owner of a session's next
 * turn, and a correction that cancels the running turn is admitted before
 * the drain that fires at the turn end — the race observed 2026-09-20
 * (stop ~5ms, backlog drain ~11ms, interrupt polling at 100ms lost).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { createHarnessRoutes } from '../../src/harness/routes.js';
import {
  __resetTurnAdmissionForTests,
  admitTurn,
  inspectAdmission,
  isAdmissionToken,
  tryAdmitTurn,
  withTurnAdmission,
} from '../../src/services/sessions/turn-admission.js';
import { interruptTurn } from '../../src/services/sessions/turn-interrupt.js';

interface FakeEvent { seq: number; type: string; data: unknown; timestamp: number }

/** An in-memory stand-in for the harness: a log, a derived status, and a stop() that behaves like the CLI. */
function fakeHarness(opts: { onStop?: (append: (type: string, data?: unknown) => FakeEvent) => void } = {}) {
  const events: FakeEvent[] = [];
  const subscribers = new Set<(event: FakeEvent) => void>();
  let seq = 0;
  const append = (type: string, data: unknown = {}): FakeEvent => {
    const event = { seq: ++seq, type, data, timestamp: Date.now() };
    events.push(event);
    for (const cb of [...subscribers]) cb(event);
    return event;
  };
  const status = (): string => {
    for (let i = events.length - 1; i >= 0; i--) {
      switch (events[i].type) {
        case 'turn:end': case 'run:end': case 'run:error': return 'idle';
        case 'stop:requested': return 'stopping';
        case 'content': case 'input:sent': return 'streaming';
        default: break;
      }
    }
    return 'idle';
  };
  const send = vi.fn(async (_id: string, input: string) => { append('input:sent', { text: input }); });
  const manager = {
    start: vi.fn(async () => ({ runId: 'run-1', processId: 'p-1' })),
    send,
    stop: vi.fn(async () => {
      if (status() !== 'streaming') return;
      append('stop:requested');
      opts.onStop?.(append);
    }),
    getLog: () => ({
      latest: () => events[events.length - 1] ?? null,
      all: () => events,
      subscribe: (cb: (event: FakeEvent) => void) => { subscribers.add(cb); return () => subscribers.delete(cb); },
    }),
    countInStorage: () => 0,
    inspect: () => ({ processAlive: true, status: status(), resumeId: null }),
    readFromStorage: () => [],
  } as unknown as SessionManager;
  return { manager, append, events, send, status };
}

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => current?.manager ?? null,
}));
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  // Immediate delivery off: these cases cover admission on the path that waits for the turn.
  ConfigService: { getInstance: () => ({ getConfig: () => ({ server: { host: '0.0.0.0', port: 3999 }, messaging: { immediateDelivery: false } }) }) },
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_manager: unknown, _sessionId: string, type: string, data: unknown) => current?.append(type, data) ?? null,
}));

let current: ReturnType<typeof fakeHarness> | null = null;
const inbox = await import('../../src/services/sessions/session-inbox.js');

beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  __resetTurnAdmissionForTests();
  current = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('turn admission', () => {
  it('hands the boundary to waiters in order and forgets a session once nobody holds it', async () => {
    const order: string[] = [];
    const first = await admitTurn('conv-a', 'interrupt');
    expect(inspectAdmission('conv-a')).toMatchObject({ holder: 'interrupt', waiting: 0 });
    const second = admitTurn('conv-a', 'drain').then((a) => { order.push('drain'); return a; });
    const third = admitTurn('conv-a', 'send').then((a) => { order.push('send'); return a; });
    expect(inspectAdmission('conv-a')?.waiting).toBe(2);
    expect(tryAdmitTurn('conv-a', 'auto-compact')).toBeNull();
    first.release();
    first.release();
    (await second).release();
    (await third).release();
    expect(order).toEqual(['drain', 'send']);
    expect(inspectAdmission('conv-a')).toBeNull();
    expect(tryAdmitTurn('conv-a', 'auto-compact')).not.toBeNull();
  });

  it('keeps sessions independent and recognises only the live admission id', async () => {
    const a = await admitTurn('conv-a', 'send');
    const b = await admitTurn('conv-b', 'send');
    expect(isAdmissionToken('conv-a', a.id)).toBe(true);
    expect(isAdmissionToken('conv-b', a.id)).toBe(false);
    a.release();
    expect(isAdmissionToken('conv-a', a.id)).toBe(false);
    b.release();
  });

  it('releases when the held function throws', async () => {
    await expect(withTurnAdmission('conv-a', 'drain', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(inspectAdmission('conv-a')).toBeNull();
  });
});

describe('interruptTurn', () => {
  it('waits for the end of the turn it cancelled, not for a status', async () => {
    const harness = fakeHarness({
      onStop: (append) => { setTimeout(() => append('turn:end'), 5); },
    });
    harness.append('input:sent', { text: 'go' });
    harness.append('content', {});
    const outcome = await interruptTurn(harness.manager, 'conv-a', 500);
    expect(outcome).toMatchObject({ ended: true, via: 'turn:end', stopSeq: 3 });
  });

  it('ignores a turn:end from before the stop and reports a process exit as such', async () => {
    const harness = fakeHarness({
      onStop: (append) => { setTimeout(() => append('run:end', { reason: 'stopped' }), 5); },
    });
    harness.append('input:sent', { text: 'one' });
    harness.append('turn:end');
    harness.append('input:sent', { text: 'two' });
    const outcome = await interruptTurn(harness.manager, 'conv-a', 500);
    expect(outcome).toMatchObject({ ended: true, via: 'process-exit', stopSeq: 4 });
  });

  it('says so when nothing ends the turn inside the wait', async () => {
    const harness = fakeHarness();
    harness.append('input:sent', { text: 'go' });
    const outcome = await interruptTurn(harness.manager, 'conv-a', 30);
    expect(outcome).toEqual({ ended: false, stopSeq: 2 });
  });

  it('returns at once when there is no live turn', async () => {
    const harness = fakeHarness();
    harness.append('input:sent', { text: 'go' });
    harness.append('turn:end');
    const outcome = await interruptTurn(harness.manager, 'conv-a', 500);
    expect(outcome).toMatchObject({ ended: true, stopSeq: null });
    expect(harness.events.some((e) => e.type === 'stop:requested')).toBe(false);
  });
});

describe('/send --interrupt under the admission', () => {
  function build(harness: ReturnType<typeof fakeHarness>, provider: 'claude' | 'codex' = 'claude', interruptWaitMs?: number) {
    current = harness;
    const app = express();
    app.use(express.json());
    app.use('/api/harness', createHarnessRoutes(harness.manager, {
      resolveResumeSessionId: () => 'p-1',
      resolveProvider: () => provider,
      resolveWorkingDirectory: () => '/tmp',
      interruptWaitMs,
    }));
    // The drain's loopback: route the fetch back into this app.
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      const path = new URL(url).pathname;
      const res = await request(app).post(path).set('content-type', 'application/json').send(init.body);
      return new Response(JSON.stringify(res.body), { status: res.status });
    });
    return app;
  }

  it('admits the correction with the backlog in one batch, ahead of the drain the turn end fires', async () => {
    const drainsFired: Promise<void>[] = [];
    const harness = fakeHarness({
      onStop: (append) => {
        // The CLI answers SIGINT ~5ms later; the turn:end side effect drains at once.
        setTimeout(() => {
          append('turn:end');
          drainsFired.push(inbox.drainInbox('conv-a'));
        }, 5);
      },
    });
    const app = build(harness);
    harness.append('input:sent', { text: 'long task' });
    harness.append('content', {});
    const backlog = inbox.enqueueInboxItem({ sessionId: 'conv-a', source: 'worker-report', text: 'worker done', worker: 'conv-w' });

    const res = await request(app).post('/api/harness/conv-a/send').send({ input: 'stop, use PEACH', interrupt: true });
    await Promise.all(drainsFired);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivery: 'now', interrupted: true, items: 2 });
    expect(harness.send).toHaveBeenCalledTimes(1);
    const batch = harness.send.mock.calls[0][1] as string;
    expect(batch.indexOf('worker done')).toBeGreaterThan(-1);
    expect(batch.indexOf('worker done')).toBeLessThan(batch.indexOf('stop, use PEACH'));
    expect(inbox.getInboxItem(backlog)?.read_at).not.toBeNull();
    expect(inbox.getInboxItem(res.body.inboxId as string)?.read_at).not.toBeNull();
    expect(inbox.hasUnreadInboxItems('conv-a')).toBe(false);
    // The correction is durable before anything is cancelled.
    expect(harness.events.map((e) => e.type)).toEqual([
      'input:sent', 'content', 'input:queued', 'input:queued', 'stop:requested', 'turn:end', 'input:sent', 'input:read',
    ]);
  });

  it('keeps the message when the turn will not end, and says it was saved rather than sent', async () => {
    const harness = fakeHarness();
    const app = build(harness, 'claude', 30);
    harness.append('input:sent', { text: 'stuck' });
    harness.append('content', {});
    const res = await request(app).post('/api/harness/conv-a/send').send({ input: 'correction', interrupt: true });
    expect(res.body).toMatchObject({ ok: true, delivery: 'saved', interrupted: false });
    expect(res.body.note).toContain('not delivered now');
    expect(inbox.getInboxItem(res.body.inboxId as string)).toMatchObject({ text: 'correction', read_at: null });
    expect(harness.send).not.toHaveBeenCalled();
    expect(inspectAdmission('conv-a')).toBeNull();
  });

  it('serialises two concurrent arrivals: the second waits and is not lost', async () => {
    const harness = fakeHarness({
      onStop: (append) => { setTimeout(() => append('turn:end'), 5); },
    });
    const app = build(harness);
    harness.append('input:sent', { text: 'long task' });
    harness.append('content', {});
    const [first, second] = await Promise.all([
      request(app).post('/api/harness/conv-a/send').send({ input: 'first correction', interrupt: true }),
      request(app).post('/api/harness/conv-a/send').send({ input: 'second, from an agent', from: 'conv-z' }),
    ]);
    expect(first.body).toMatchObject({ ok: true, delivery: 'now', interrupted: true });
    // The interrupt's batch opened a turn, so the agent's message waits for it.
    expect(second.body).toMatchObject({ ok: true, delivery: 'after-turn' });
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(inbox.unreadInboxItems('conv-a').map((r) => r.text)).toEqual(['second, from an agent']);
    expect(inspectAdmission('conv-a')).toBeNull();
  });
});

describe('/send provenance', () => {
  function build(harness: ReturnType<typeof fakeHarness>) {
    current = harness;
    const app = express();
    app.use(express.json());
    app.use('/api/harness', createHarnessRoutes(harness.manager, {
      resolveResumeSessionId: () => 'p-1',
      resolveProvider: () => 'claude',
      resolveWorkingDirectory: () => '/tmp',
    }));
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      const path = new URL(url).pathname;
      const res = await request(app).post(path).set('content-type', 'application/json').send(init.body);
      return new Response(JSON.stringify(res.body), { status: res.status });
    });
    return app;
  }

  it('labels a declared sender for the reader instead of presenting the text as the user\'s', async () => {
    const harness = fakeHarness();
    const app = build(harness);
    const res = await request(app).post('/api/harness/conv-a/send').send({ input: 'audit result', from: 'conv-b', passedOn: true });
    expect(res.body).toMatchObject({ ok: true, delivery: 'now' });
    expect(harness.send).toHaveBeenCalledTimes(1);
    const text = harness.send.mock.calls[0][1] as string;
    expect(text).toMatch(/^\[From conv-b, relaying the user's decision · \d\d:\d\d\]\naudit result$/);
    expect(inbox.getInboxItem(res.body.inboxId as string)).toMatchObject({ source: 'agent', sender: 'conv-b', passed_on: 1, text: 'audit result' });
    expect(harness.events.find((e) => e.type === 'input:queued')?.data).toMatchObject({ source: 'agent', sender: 'conv-b', passedOn: true });
  });

  it('says the sender is unidentified for a CLI send with no --from', async () => {
    const harness = fakeHarness();
    const app = build(harness);
    await request(app).post('/api/harness/conv-a/send').send({ input: 'who knows', origin: 'cli' });
    const text = harness.send.mock.calls[0][1] as string;
    expect(text).toContain('[From an unidentified sender');
    expect(text).not.toContain('the user');
  });

  it('leaves the composer\'s message as written, with no row', async () => {
    const harness = fakeHarness();
    const app = build(harness);
    const res = await request(app).post('/api/harness/conv-a/send').send({ input: 'plain' });
    expect(res.body).toMatchObject({ ok: true, delivery: 'now' });
    expect(harness.send).toHaveBeenCalledWith('conv-a', 'plain', undefined);
    expect(inbox.hasUnreadInboxItems('conv-a')).toBe(false);
  });

  it('queues an agent message behind a running turn with its provenance intact', async () => {
    const harness = fakeHarness();
    const app = build(harness);
    harness.append('input:sent', { text: 'busy' });
    harness.append('content', {});
    const res = await request(app).post('/api/harness/conv-a/send').send({ input: 'later', from: 'conv-b' });
    expect(res.body).toMatchObject({ ok: true, delivery: 'after-turn' });
    expect(harness.send).not.toHaveBeenCalled();
    const rows = inbox.unreadInboxItems('conv-a');
    expect(rows).toHaveLength(1);
    expect(inbox.composeInboxInput(rows, 'lattice')).toMatch(/^\[From conv-b · \d\d:\d\d\]\nlater$/);
  });
});

describe('worker item headers', () => {
  it('carry the source event seq so the coordinator can answer or address it by number', () => {
    const question = inbox.formatWorkerQuestion({
      workerConversationId: 'conv-w', model: 'gpt-6-astra', text: 'Question for front: which port?', cli: 'lattice',
      coordinatorConversationId: 'conv-c', seq: 412,
    });
    expect(question.startsWith('[Question from worker conv-w · gpt-6-astra · [412]')).toBe(true);
    expect(question).toContain('session send conv-w --from conv-c --answers 412 --summary');
    expect(question).toContain('A send without `--answers 412`');
    const legacy = inbox.formatWorkerQuestion({
      workerConversationId: 'conv-w', model: null, text: 'q', cli: 'lattice', coordinatorConversationId: 'conv-c', seq: null,
    });
    expect(legacy).not.toContain('[null]');
    expect(legacy).not.toContain('--answers');
    const report = inbox.formatWorkerReport({ workerConversationId: 'conv-w', model: 'claude-opus-5', text: 'done', cli: 'lattice', seq: 77 });
    expect(report.startsWith('[Report from worker conv-w · claude-opus-5 · [77].')).toBe(true);
  });

  it('enqueue with a delivery id is idempotent per session', () => {
    const harness = fakeHarness();
    current = harness;
    const first = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'coordination-review', text: 'r1', deliveryId: 'review-1' });
    const again = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'coordination-review', text: 'r1 again', deliveryId: 'review-1' });
    const other = inbox.enqueueInboxItem({ sessionId: 'conv-d', source: 'coordination-review', text: 'r1', deliveryId: 'review-1' });
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(inbox.unreadInboxItemsOfSource('conv-c', 'coordination-review')).toHaveLength(1);
    expect(harness.events.filter((e) => e.type === 'input:queued')).toHaveLength(2);
  });
});
