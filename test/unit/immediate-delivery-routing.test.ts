/**
 * What `/send` does with the user's message when the session is mid-turn.
 *
 * Since 2026-09-22 the message goes in immediately and the model sorts out
 * what to do with it, rather than waiting for the turn to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionManager, SteerOutcome, SteerRequest } from '@liggi/agent-ui-harness/server';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { createHarnessRoutes } from '../../src/harness/routes.js';
import { __resetTurnAdmissionForTests } from '../../src/services/sessions/turn-admission.js';

const appended: Array<{ type: string; data: Record<string, unknown> }> = [];
/** The coordinator every case posts to; created fresh per test. */
let sessionId = '';
let nextSeq = 100;
let immediateDelivery: boolean | undefined = true;

vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: {
    getInstance: () => ({
      getConfig: () => ({ server: { host: '0.0.0.0', port: 3999 }, messaging: { immediateDelivery } }),
    }),
  },
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_m: unknown, _s: string, type: string, data: unknown) => {
    nextSeq += 1;
    appended.push({ type, data: data as Record<string, unknown> });
    return { seq: nextSeq, type, data };
  },
}));

const inbox = await import('../../src/services/sessions/session-inbox.js');

/** Every steer accepts and reports the full stage sequence, unless told otherwise. */
function build(options: { steer?: SessionManager['steer'] } = {}) {
  const send = vi.fn(async () => {});
  const steer = options.steer ?? vi.fn(async (_s: string, req: SteerRequest): Promise<SteerOutcome> => {
    req.onStage?.({ kind: 'handed-over' });
    req.onStage?.({ kind: 'accepted', late: false });
    req.onStage?.({ kind: 'incorporated', where: 'mid-turn', evidence: 'started before result' });
    return { status: 'accepted', sentSeq: 55 };
  });
  const sessionManager = {
    start: vi.fn(async () => ({ runId: 'run-1', processId: 'p-1' })),
    send,
    steer,
    getLog: () => null,
    countInStorage: () => 0,
    inspect: () => ({ processAlive: true, status: 'streaming', resumeId: null }),
    readFromStorage: () => [],
  } as unknown as SessionManager;
  const app = express();
  app.use(express.json());
  app.use('/api/harness', createHarnessRoutes(sessionManager, {
    resolveResumeSessionId: () => 'p-1',
    resolveProvider: () => 'claude',
    resolveWorkingDirectory: () => '/tmp',
  }));
  return { app, send, steer };
}

beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  sessionId = ConversationService.getInstance().createConversation({
    workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-1', coordinator: true,
  }).conversationId;
  appended.length = 0;
  immediateDelivery = true;
  __resetTurnAdmissionForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('a message to a session in a turn', () => {
  it('goes in now, and says only that the provider took it', async () => {
    const { app, steer, send } = build();

    const res = await request(app).post(`/api/harness/${sessionId}/send`).send({ input: 'use PEACH' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivery: 'now', immediate: { status: 'delivered', items: 1 } });
    expect(steer).toHaveBeenCalledTimes(1);
    // Not the ordinary write path: that is what put it behind the turn.
    expect(send).not.toHaveBeenCalled();
    expect(inbox.getInboxItem(res.body.inboxId as string)).toMatchObject({ source: 'user', text: 'use PEACH' });
  });

  it('is written to the inbox before anything is sent, so a failure cannot lose it', async () => {
    const seen: Array<string | null> = [];
    const steer = vi.fn(async (): Promise<SteerOutcome> => {
      // Reserved by the delivery already, so this reads past the reservation:
      // the point is that the row exists at all before anything is sent.
      seen.push(inbox.unreadInboxItemsOfSource(sessionId, 'user')[0]?.text ?? null);
      return { status: 'rejected', reason: 'no running turn' };
    });
    const { app } = build({ steer: steer as unknown as SessionManager['steer'] });

    const res = await request(app).post(`/api/harness/${sessionId}/send`).send({ input: 'use PEACH' });

    expect(seen).toEqual(['use PEACH']);
    expect(res.body).toMatchObject({ delivery: 'after-turn' });
  });

  it('goes in now when the config says nothing about it', async () => {
    immediateDelivery = undefined;
    const { app, steer } = build();

    const res = await request(app).post(`/api/harness/${sessionId}/send`).send({ input: 'use PEACH' });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ ok: true, delivery: 'now' });
  });

  it('takes the path it always took when the switch is off', async () => {
    immediateDelivery = false;
    const { app, steer } = build();

    const res = await request(app).post(`/api/harness/${sessionId}/send`).send({ input: 'use PEACH' });

    expect(steer).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, delivery: 'after-turn' });
    expect(res.body.responder).toBeUndefined();
  });

  it('falls back to the inbox when the provider will not take it, rather than inventing a delivery', async () => {
    const steer = vi.fn(async (): Promise<SteerOutcome> => ({ status: 'rejected', reason: 'compacting' }));
    const { app } = build({ steer: steer as unknown as SessionManager['steer'] });

    const res = await request(app).post(`/api/harness/${sessionId}/send`).send({ input: 'use PEACH' });

    expect(res.body).toMatchObject({ ok: true, delivery: 'after-turn' });
    // In the inbox, not sent: drained at the turn boundary.
    expect(inbox.unreadInboxItemsOfSource(sessionId, 'user')).toHaveLength(1);
  });

  it('says a handover was not acknowledged rather than claiming it landed', async () => {
    const steer = vi.fn(async (_s: string, req: SteerRequest): Promise<SteerOutcome> => {
      req.onStage?.({ kind: 'handed-over' });
      return { status: 'uncertain', reason: 'no acknowledgement' };
    });
    const { app } = build({ steer: steer as unknown as SessionManager['steer'] });

    const res = await request(app).post(`/api/harness/${sessionId}/send`).send({ input: 'use PEACH' });

    expect(res.body).toMatchObject({ delivery: 'saved', immediate: { status: 'uncertain' } });
    expect(res.body.note).toContain('not acknowledged');
  });
});

describe('an agent writing to a worker mid-turn', () => {
  let worker = '';
  beforeEach(() => {
    worker = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-2', pickedUpFrom: sessionId,
    }).conversationId;
  });
  const post = (app: express.Express, body: Record<string, unknown>) =>
    request(app).post(`/api/harness/${worker}/send`).send({ origin: 'cli', ...body });
  const steeredText = (steer: unknown, call = 0) =>
    (vi.mocked(steer as SessionManager['steer']).mock.calls[call]?.[1] as SteerRequest).input;

  it('goes into the running turn, labelled as the coordinator\'s', async () => {
    const { app, steer } = build();

    const res = await post(app, { input: 'wrong table, use sessions_v2', from: sessionId });

    expect(res.body).toMatchObject({ ok: true, delivery: 'now', immediate: { status: 'delivered', items: 1 } });
    expect(steeredText(steer)).toContain(`[From ${sessionId}`);
    expect(steeredText(steer)).toContain('wrong table, use sessions_v2');
    expect(inbox.getInboxItem(res.body.inboxId as string)?.read_at).not.toBeNull();
  });

  it('waits for the turn to end when the coordinator asks it to, and is not swept up by a later immediate send', async () => {
    const { app, steer } = build();

    const deferred = await post(app, { input: 'next task, after this one', from: sessionId, afterTurn: true });
    const now = await post(app, { input: 'stop: wrong branch', from: sessionId });

    expect(deferred.body).toMatchObject({ ok: true, delivery: 'after-turn', afterTurn: true });
    expect(now.body).toMatchObject({ delivery: 'now', immediate: { items: 1 } });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steeredText(steer)).not.toContain('next task, after this one');
    // Still waiting, unreserved, for the drain at the turn boundary.
    const row = inbox.getInboxItem(deferred.body.inboxId as string);
    expect(row).toMatchObject({ after_turn: 1, read_at: null, reserved_by: null });
    expect(inbox.unreadInboxItems(worker).map((r) => r.id)).toEqual([deferred.body.inboxId]);
    expect(inbox.unreadInboxItems(worker, { runningTurn: true })).toHaveLength(0);
  });

  it('leaves a deferred message behind when the user\'s own message goes in', async () => {
    const { app, steer } = build();

    await post(app, { input: 'after this turn', from: sessionId, afterTurn: true });
    const fromUser = await request(app).post(`/api/harness/${worker}/send`).send({ input: 'use PEACH' });

    expect(fromUser.body).toMatchObject({ delivery: 'now', immediate: { items: 1 } });
    expect(steeredText(steer)).not.toContain('after this turn');
  });

  it('delivers messages from different senders in the order they were sent', async () => {
    const { app, steer } = build();
    const peer = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-3',
    }).conversationId;

    await post(app, { input: 'peer: the path is src/x.ts', from: peer });
    await post(app, { input: 'coordinator: correction', from: sessionId });

    expect(steer).toHaveBeenCalledTimes(2);
    expect(steeredText(steer, 0)).toContain('peer: the path is src/x.ts');
    expect(steeredText(steer, 1)).toContain('coordinator: correction');
    expect(steeredText(steer, 1)).not.toContain('peer: the path is src/x.ts');
  });

  it('puts another worker\'s message into the running turn too, labelled as that worker\'s', async () => {
    const { app, steer } = build();
    const peer = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-3',
    }).conversationId;

    const res = await post(app, { input: 'fyi: the signature is f(a, b)', from: peer });

    expect(res.body).toMatchObject({ ok: true, delivery: 'now', immediate: { status: 'delivered', items: 1 } });
    expect(steeredText(steer)).toContain(`[From ${peer}`);
    expect(inbox.getInboxItem(res.body.inboxId as string)?.read_at).not.toBeNull();
  });

  it('holds another worker\'s message for the turn to end only when it asks', async () => {
    const { app, steer } = build();
    const peer = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-3',
    }).conversationId;

    const res = await post(app, { input: 'later', from: peer, afterTurn: true });

    expect(res.body).toMatchObject({ ok: true, delivery: 'after-turn', afterTurn: true });
    expect(steer).not.toHaveBeenCalled();
  });

  it('waits for the turn when the switch is off', async () => {
    immediateDelivery = false;
    const { app, steer } = build();

    const res = await post(app, { input: 'correction', from: sessionId });

    expect(res.body).toMatchObject({ delivery: 'after-turn' });
    expect(steer).not.toHaveBeenCalled();
  });

  it('says so when the provider refuses, and leaves the row for the turn boundary', async () => {
    const steer = vi.fn(async (): Promise<SteerOutcome> => ({ status: 'rejected', reason: 'compacting' }));
    const { app } = build({ steer: steer as unknown as SessionManager['steer'] });

    const res = await post(app, { input: 'correction', from: sessionId });

    expect(res.body).toMatchObject({ delivery: 'after-turn', immediate: { status: 'rejected' } });
    expect(res.body.note).toContain('compacting');
    expect(inbox.unreadInboxItems(worker)).toHaveLength(1);
  });

  it('refuses after-turn together with interrupt, and after-turn from the composer', async () => {
    const { app } = build();

    const both = await post(app, { input: 'x', from: sessionId, afterTurn: true, interrupt: true });
    const composer = await request(app).post(`/api/harness/${worker}/send`).send({ input: 'x', afterTurn: true });

    expect(both.status).toBe(400);
    expect(composer.status).toBe(400);
    expect(inbox.unreadInboxItems(worker)).toHaveLength(0);
  });

  it('refuses a new assignment into the running turn, and saves nothing', async () => {
    // 2026-09-23: a coordinator sent a production bug into a busy worker with
    // --task, which put its half-built feature on hold and renamed its card.
    const { app, steer } = build();

    const res = await post(app, { input: 'fix the Searching ring', from: sessionId, task: 'Fix the Searching ring' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Start a new worker/);
    expect(steer).not.toHaveBeenCalled();
    expect(inbox.unreadInboxItems(worker)).toHaveLength(0);
    expect(appended.filter((e) => e.type === 'worker:reassigned')).toHaveLength(0);
  });
});
