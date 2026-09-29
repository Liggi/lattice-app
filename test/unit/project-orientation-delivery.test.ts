/**
 * The project record has to actually reach the turn. `project-orientation.ts`
 * decides what the block says and when it is due; this checks that the two
 * routes which hand a project session its input put it there — an ordinary
 * message from the user and a worker's report drained from the inbox both go
 * through `/send`, and a process that died comes back through `/resume`.
 *
 * Before this, a project session saw its own record only after a compaction
 * or when the previous turn had left something unaccounted for. An ordinary
 * turn ran on whatever its context still held, and a resumed one on nothing
 * at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import type { RawEvent } from '../../src/session-history/types.js';

let storedEvents = new Map<string, RawEvent[]>();
let nextSeq = 1000;

/** Swapped per test: the resume route spawns through whatever this returns. */
let harnessManager: unknown = { inspect: () => null };
vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => harnessManager,
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_manager: unknown, sessionId: string, type: string, data: unknown) => {
    nextSeq += 1;
    const event = { conversationId: sessionId, seq: nextSeq, runId: 'run-1', timestamp: nextSeq, type, data, meta: null } as RawEvent;
    storedEvents.set(sessionId, [...(storedEvents.get(sessionId) ?? []), event]);
    return { seq: nextSeq, type, data };
  },
}));
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: { getInstance: () => ({ getConfig: () => ({ server: { host: '127.0.0.1', port: 3999, systemPrompt: '' } }) }) },
}));
vi.mock('../../src/session-history/repository.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import('./fake-event-reads.js')).fakeEventReads((conversationId) => storedEvents.get(conversationId) ?? []),
}));

const { createHarnessRoutes } = await import('../../src/harness/routes.js');
const { DatabaseProvider } = await import('../../src/services/infrastructure/database-provider.js');
const { SessionInfoService } = await import('../../src/services/sessions/session-info-service.js');
const { ConversationService } = await import('../../src/services/sessions/conversation-service.js');
const { appendProjectNote } = await import('../../src/services/sessions/project-state.js');
const { PROJECT_ORIENTED_EVENT } = await import('../../src/services/sessions/project-orientation.js');
const { stripContextRestore } = await import('../../src/types/worker-events.js');
const { tryAdmitTurn } = await import('../../src/services/sessions/turn-admission.js');
const { createUnifiedConversationRoutes } = await import('../../src/routes/conversation/unified-conversation.routes.js');

const OUTCOME = 'one durable project session that holds the whole picture';

let sessionInfo: InstanceType<typeof SessionInfoService>;

beforeEach(async () => {
  storedEvents = new Map();
  nextSeq = 1000;
  harnessManager = { inspect: () => null };
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  sessionInfo = new SessionInfoService(':memory:');
  await sessionInfo.initialize();
  ConversationService.getInstance().initialize(DatabaseProvider.getInstance().getDb());
});
afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

/** A project session with something on the record to be oriented from. */
function projectSession(provider: 'claude' | 'codex' = 'claude'): string {
  const { conversationId } = ConversationService.getInstance().createConversation({
    workingDirectory: '/tmp/project',
    provider,
    providerSessionId: 'provider-session-1',
    model: provider === 'codex' ? 'gpt-6-astra' : 'claude-opus-5',
    coordinator: true,
  });
  appendProjectNote(conversationId, { kind: 'outcome', text: OUTCOME, by: 'coordinator' });
  return conversationId;
}

function ordinarySession(): string {
  return ConversationService.getInstance().createConversation({
    workingDirectory: '/tmp/project',
    provider: 'claude',
    providerSessionId: 'provider-session-2',
    model: 'claude-opus-5',
  }).conversationId;
}

function build() {
  const start = vi.fn(async () => ({ runId: 'run-1', processId: 'process-1' }));
  const send = vi.fn(async () => {});
  const sessionManager = {
    start,
    send,
    compact: vi.fn(async () => {}),
    getLog: () => null,
    countInStorage: () => 0,
    inspect: () => null,
    readFromStorage: () => [],
  } as unknown as SessionManager;

  const app = express();
  app.use(express.json());
  app.use('/api/harness', createHarnessRoutes(sessionManager, {
    resolveResumeSessionId: () => 'provider-session-1',
    resolveProvider: () => 'claude',
    resolveWorkingDirectory: () => '/tmp/project',
  }));
  return { app, start, send };
}

/** What the route actually handed the process on `/send`. */
const sent = (send: ReturnType<typeof vi.fn>, call = 0): string => String(send.mock.calls[call]?.[1] ?? '');

describe('an ordinary message to a project session', () => {
  it('carries the project record in front of it, and the user still reads their own words', async () => {
    const { app, send } = build();
    const conversationId = projectSession();

    const res = await request(app).post(`/api/harness/${conversationId}/send`).send({ input: 'what next?' });

    expect(res.status).toBe(200);
    expect(sent(send)).toContain(OUTCOME);
    expect(sent(send).endsWith('what next?')).toBe(true);
    expect(stripContextRestore(sent(send))).toBe('what next?');
  });

  it('is not repeated on the next message while nothing has moved', async () => {
    const { app, send } = build();
    const conversationId = projectSession();

    await request(app).post(`/api/harness/${conversationId}/send`).send({ input: 'what next?' });
    await request(app).post(`/api/harness/${conversationId}/send`).send({ input: 'and after that?' });

    expect(sent(send, 1)).toBe('and after that?');
  });

  it('is not built for a session that is not a project session', async () => {
    const { app, send } = build();
    const conversationId = ordinarySession();

    await request(app).post(`/api/harness/${conversationId}/send`).send({ input: 'hello' });

    expect(sent(send)).toBe('hello');
  });
});

describe("a worker's report drained into a project session", () => {
  it('arrives with the same record in front of it, because it is the same path', async () => {
    const { app, send } = build();
    const conversationId = projectSession();
    // The report is a worker event, so the record has moved; the turn that
    // reads it is oriented by the state that now includes it.
    nextSeq += 1;
    storedEvents.set(conversationId, [
      ...(storedEvents.get(conversationId) ?? []),
      { conversationId, seq: nextSeq, runId: 'run-1', timestamp: nextSeq, type: 'worker:reported', data: { worker: 'conv-w', model: null, text: 'Done.' }, meta: null } as RawEvent,
    ]);

    // The drain holds the session's turn admission and proves it to the
    // route; a batch from anything else is refused, so the test takes one.
    const admission = tryAdmitTurn(conversationId, 'drain');
    expect(admission).not.toBeNull();
    const res = await request(app)
      .post(`/api/harness/${conversationId}/send`)
      .send({ input: '[report from conv-w] Done.', inboxIds: ['row-1'], admission: admission?.id });
    admission?.release();

    expect(res.status).toBe(200);
    expect(sent(send)).toContain(OUTCOME);
    expect(stripContextRestore(sent(send))).toBe('[report from conv-w] Done.');
  });
});

describe('a project session coming back cold', () => {
  it('gets the record on the resume path, which used to carry none', async () => {
    const conversationId = projectSession('codex');
    const start = vi.fn(async () => ({ runId: 'run-1', processId: 'process-1' }));
    const sessionManager = {
      start,
      send: vi.fn(async () => {}),
      compact: vi.fn(async () => {}),
      getLog: () => null,
      countInStorage: () => 0,
      inspect: () => null,
      readFromStorage: () => [],
    } as unknown as SessionManager;
    harnessManager = sessionManager;

    const conv = express();
    conv.use(express.json());
    conv.use('/api/conv', createUnifiedConversationRoutes({
      historyReader: { getFirstUserPrompt: () => null } as never,
      activeConversationRegistry: {
        get: () => undefined,
        register: () => {},
        allocateRunVersion: () => 1,
      } as never,
      sessionInfoService: sessionInfo,
      permissionTracker: {} as never,
    }));

    const res = await request(conv).post(`/api/conv/${conversationId}/resume`).send({ message: 'carry on' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const prompt = String((start.mock.calls[0]?.[1] as { prompt?: string })?.prompt ?? '');
    expect(prompt).toContain(OUTCOME);
    expect(stripContextRestore(prompt)).toBe('carry on');
    expect((storedEvents.get(conversationId) ?? []).filter((event) => event.type === PROJECT_ORIENTED_EVENT)).toHaveLength(1);
  });
});
