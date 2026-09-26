/**
 * Moving a Codex coordinator to Claude in place (coordinator-switch.ts). The
 * risks these cover: a switch racing a send or a drain, a switch that leaves
 * the segment saying Claude while the harness would still respawn Codex, a
 * handover that silently drops the record or shortens what it quotes, and a
 * failed start that leaves nothing runnable.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import type { RawEvent } from '../../src/session-history/types.js';

let storedEvents = new Map<string, RawEvent[]>();
let nextSeq = 1;

function store(sessionId: string, type: string, data: unknown, runId = 'run-codex'): SessionEvent {
  nextSeq += 1;
  const event = { conversationId: sessionId, sessionId, seq: nextSeq, runId, timestamp: nextSeq, type, data, meta: null };
  storedEvents.set(sessionId, [...(storedEvents.get(sessionId) ?? []), event as unknown as RawEvent]);
  return event as unknown as SessionEvent;
}

/**
 * A harness stand-in with the parts the switch relies on: one event log per
 * session that subscribers see synchronously, `start` recording its config
 * and then playing whatever the test scripted for that run.
 */
class FakeHarness {
  status = 'idle';
  alive = true;
  starts: Array<{ prompt: string; resume?: string; args?: string[]; extra?: Record<string, unknown> }> = [];
  subscribers = new Set<(event: SessionEvent) => void>();
  script: Array<(runId: string) => void> = [];

  constructor(private readonly sessionId: string) {}

  append(type: string, data: unknown, runId: string): void {
    const event = store(this.sessionId, type, data, runId);
    for (const subscriber of [...this.subscribers]) subscriber(event);
  }

  getLog() {
    return {
      all: () => (storedEvents.get(this.sessionId) ?? []) as unknown as SessionEvent[],
      subscribe: (fn: (event: SessionEvent) => void) => {
        this.subscribers.add(fn);
        return () => { this.subscribers.delete(fn); };
      },
    };
  }

  compacts = 0;
  async compact() { this.compacts += 1; }
  hasSession() { return true; }
  recoverFromStorage() { return this.getLog(); }
  inspect() { return { status: this.status, processAlive: this.alive, scheduledWakeup: null, runId: 'run-codex' }; }
  signal() {
    this.alive = false;
    this.append('run:end', { reason: 'process_exit' }, 'run-killed');
    return true;
  }

  async start(_sessionId: string, config: FakeHarness['starts'][number]) {
    this.starts.push(config);
    const runId = `run-${this.starts.length}`;
    this.append('run:start', { config }, runId);
    if (config.prompt) this.append('input:sent', { text: config.prompt }, runId);
    const step = this.script.shift();
    if (step) setTimeout(() => step(runId), 5);
    this.alive = true;
    return { runId, processId: `proc-${this.starts.length}` };
  }
}

let harness: FakeHarness;
vi.mock('../../src/harness/setup.js', () => ({ getHarnessSessionManager: () => harness }));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_manager: unknown, sessionId: string, type: string, data: unknown) => store(sessionId, type, data),
}));
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: { getInstance: () => ({ getConfig: () => ({ server: { host: '127.0.0.1', port: 3999, systemPrompt: '' } }) }) },
}));
vi.mock('../../src/session-history/repository.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEvents: (conversationId: string) => storedEvents.get(conversationId) ?? [],
  iterateEventsNewestFirst: (conversationId: string, types: readonly string[]) =>
    (storedEvents.get(conversationId) ?? []).filter((event) => types.includes(event.type)).reverse(),
}));

const { DatabaseProvider } = await import('../../src/services/infrastructure/database-provider.js');
const { SessionInfoService } = await import('../../src/services/sessions/session-info-service.js');
const { ConversationService } = await import('../../src/services/sessions/conversation-service.js');
const { appendProjectNote } = await import('../../src/services/sessions/project-state.js');
const { appendWorkerEvent } = await import('../../src/services/sessions/worker-events.js');
const { enqueueInboxItem, unreadInboxItems } = await import('../../src/services/sessions/session-inbox.js');
const { createHarnessRoutes } = await import('../../src/harness/routes.js');
const { PROJECT_ORIENTED_EVENT } = await import('../../src/services/sessions/project-orientation.js');
const { maybeAutoCompact, conversationContextTokens } = await import('../../src/services/sessions/context-compaction.js');
const { admitTurn, tryAdmitTurn, __resetTurnAdmissionForTests } = await import('../../src/services/sessions/turn-admission.js');
const { stripContextRestore } = await import('../../src/types/worker-events.js');
const { switchCoordinator, unfinishedSwitchRefusal, COORDINATOR_SWITCH_EVENT } = await import('../../src/services/sessions/coordinator-switch.js');
const { ActiveConversationRegistry } = await import('../../src/services/process/active-conversation-registry.js');

const THREAD_ID = '019e-codex-thread';
const TARGET = { provider: 'claude' as const, model: 'claude-opus-5-5' };
const OUTCOME = 'one durable project session that holds the whole picture';
const DECISION = 'workers keep their own models';
const LONG = `The user's long message ${'with every word kept '.repeat(400)}and its last words`;

let conversationId: string;
let drain: ReturnType<typeof vi.fn>;

function deps() {
  return {
    sessionManager: harness as never,
    conversationService: ConversationService.getInstance(),
    registry: new ActiveConversationRegistry(),
    cli: 'lattice',
    claudeSpawn: () => ({ permissionMode: 'bypassPermissions' }),
    codexResumeConfig: (id: string, segment: { providerSessionId: string; model: string | null }) => ({
      prompt: '',
      resume: segment.providerSessionId,
      args: [`--model=${segment.model}`],
      extra: { sessionId: id, provider: 'codex' },
    }),
    timeoutMs: 500,
    drain,
  };
}

/** The Claude run answering its handover the way a real one does. */
function claudeAnswers() {
  return (runId: string) => {
    harness.append('run:ready', { resumeId: 'claude-session-1', model: TARGET.model }, runId);
    harness.append('content', { messageId: 'm1', model: TARGET.model, blocks: [{ type: 'text', text: `Now running on ${TARGET.model}.` }] }, runId);
    harness.append('turn:end', { usage: {} }, runId);
  };
}

function eventTypes(): string[] {
  return (storedEvents.get(conversationId) ?? []).map((event) => event.type);
}

/** The send route as the server mounts it, reading the provider from the conversation as the real resolver does. */
function sendRoute() {
  const send = vi.fn(async () => {});
  const sessionManager = {
    start: vi.fn(async () => ({ runId: 'run-x', processId: 'proc-x' })),
    send,
    getLog: () => null,
    countInStorage: () => 0,
    inspect: () => null,
    readFromStorage: () => [],
  };
  const app = express();
  app.use(express.json());
  app.use('/api/harness', createHarnessRoutes(sessionManager as never, {
    resolveResumeSessionId: () => THREAD_ID,
    resolveProvider: (id: string) => ConversationService.getInstance().getLatestSegment(id)!.provider,
    resolveWorkingDirectory: () => '/tmp/fixture-switch',
  }));
  return { app, send };
}

/** The server stopping after Claude had started, before the switch was confirmed. */
function interruptedAfterReady(): string {
  const previous = ConversationService.getInstance().getConversation(conversationId)!.segments[0];
  const { segmentId } = ConversationService.getInstance().addSegment(conversationId, {
    provider: 'claude', providerSessionId: 'claude-session-real-id', model: TARGET.model,
  });
  store(conversationId, COORDINATOR_SWITCH_EVENT, {
    phase: 'requested',
    from: { provider: 'codex', model: 'gpt-6-astra', segmentId: previous.segmentId },
    to: { ...TARGET, segmentId },
  });
  return segmentId;
}

function switchEvents(): string[] {
  return (storedEvents.get(conversationId) ?? [])
    .filter((event) => event.type === COORDINATOR_SWITCH_EVENT)
    .map((event) => (event.data as { phase: string }).phase);
}

beforeEach(async () => {
  storedEvents = new Map();
  nextSeq = 1;
  __resetTurnAdmissionForTests();
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  const sessionInfo = new SessionInfoService(':memory:');
  await sessionInfo.initialize();
  ConversationService.getInstance().initialize(DatabaseProvider.getInstance().getDb());
  conversationId = ConversationService.getInstance().createConversation({
    workingDirectory: '/tmp/fixture-switch',
    provider: 'codex',
    providerSessionId: THREAD_ID,
    model: 'gpt-6-astra',
    coordinator: true,
  }).conversationId;
  harness = new FakeHarness(conversationId);
  drain = vi.fn(async () => {});

  store(conversationId, 'input:sent', { text: 'You are `front`: the preamble\n---\nfirst message, too old to quote' });
  store(conversationId, 'content', { messageId: 'a0', blocks: [{ type: 'text', text: 'first reply' }] });
  appendProjectNote(conversationId, { kind: 'outcome', text: OUTCOME, by: 'user' });
  appendProjectNote(conversationId, { kind: 'decision', text: DECISION, by: 'user' });
  appendProjectNote(conversationId, { kind: 'open', text: 'migrate the coordinators', by: 'coordinator' });
  appendWorkerEvent(conversationId, 'worker:started', { worker: 'conv-worker-1', provider: 'claude', model: 'claude-sonnet-5', task: 'check the switch' });
  for (const text of ['second message', LONG, 'fourth message']) {
    store(conversationId, 'input:sent', { text });
    store(conversationId, 'content', { messageId: `a-${text.length}`, blocks: [{ type: 'text', text: `reply to ${text.slice(0, 20)}` }] });
  }
  store(conversationId, 'input:sent', { text: '[Report from worker conv-worker-1]\nfound it' });
  store(conversationId, 'turn:end', { usage: {} });
});

afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('switching a Codex coordinator to Claude', () => {
  it('keeps the conversation and hands the new model the record and the recent exchanges in full', async () => {
    harness.script.push(claudeAnswers());
    const result = await switchCoordinator(conversationId, TARGET, deps());

    expect(result.status).toBe('switched');
    const conversation = ConversationService.getInstance().getConversation(conversationId)!;
    expect(conversation.segments.map((segment) => [segment.provider, segment.model])).toEqual([
      ['codex', 'gpt-6-astra'], ['claude', TARGET.model],
    ]);
    expect(conversation.segments[0].providerSessionId).toBe(THREAD_ID);

    const [start] = harness.starts;
    // A resume here would hand Claude the Codex thread id.
    expect(start.resume).toBeUndefined();
    expect(start.args).toContain(`--model=${TARGET.model}`);
    expect(start.extra?.provider).toBe('claude');

    const handover = start.prompt;
    expect(handover).toContain('You are `front`');
    expect(handover).toContain('conv-worker-1');
    expect(handover).toContain(OUTCOME);
    expect(handover).toContain(DECISION);
    expect(handover).toContain('migrate the coordinators');
    expect(handover).toContain(LONG);
    expect(handover).toContain('[Report from worker conv-worker-1]\nfound it');
    expect(handover).not.toContain('too old to quote');
    // Older history is named as absent, with the commands that reach it.
    expect(handover).toMatch(/Everything before event \d+ is not in this handover/);
    expect(handover).toContain(`lattice session grep ${conversationId} <words>`);
    expect(handover).toContain(`lattice session transcript ${conversationId} --from <seq> --to <seq>`);
    expect(handover).toContain(`lattice session state ${conversationId} --history`);
    // The thread shows none of it as though the user had typed it.
    expect(stripContextRestore(handover)).toBe('');

    expect(switchEvents()).toEqual(['requested', 'completed']);
    // The orientation receipt is written once the new model has read it.
    const types = eventTypes();
    expect(types.indexOf(PROJECT_ORIENTED_EVENT)).toBeGreaterThan(types.lastIndexOf('turn:end'));
    expect(tryAdmitTurn(conversationId, 'send')).not.toBeNull();
  });

  it('holds a send that arrives mid-switch until the switch has finished', async () => {
    harness.script.push(claudeAnswers());
    const switching = switchCoordinator(conversationId, TARGET, deps());
    const send = admitTurn(conversationId, 'send').then((admission) => {
      const seen = `${ConversationService.getInstance().getLatestSegment(conversationId)!.provider} after ${switchEvents().join(',')}`;
      admission.release();
      return seen;
    });
    expect((await switching).status).toBe('switched');
    expect(await send).toBe('claude after requested,completed');
  });

  it('refuses, changing nothing, while anything else holds the next turn or the coordinator is not idle', async () => {
    const held = tryAdmitTurn(conversationId, 'drain')!;
    expect(await switchCoordinator(conversationId, TARGET, deps())).toMatchObject({ status: 'refused', code: 'busy' });
    held.release();

    harness.status = 'streaming';
    expect(await switchCoordinator(conversationId, TARGET, deps())).toMatchObject({ status: 'refused', code: 'not-idle' });
    harness.status = 'idle';

    enqueueInboxItem({ sessionId: conversationId, source: 'worker-report', text: 'a report not yet read' });
    expect(await switchCoordinator(conversationId, TARGET, deps())).toMatchObject({ status: 'refused', code: 'inbox-pending' });

    expect(harness.starts).toHaveLength(0);
    expect(ConversationService.getInstance().getConversation(conversationId)!.segments).toHaveLength(1);
    expect(switchEvents()).toEqual([]);
  });

  it('puts Codex back when Claude never answers, so the next message reaches a runnable session', async () => {
    harness.script.push((runId) => {
      harness.append('run:ready', { resumeId: 'claude-session-1', model: TARGET.model }, runId);
      harness.alive = false;
      harness.append('run:end', { reason: 'process_exit' }, runId);
    });
    const result = await switchCoordinator(conversationId, TARGET, deps());

    expect(result).toMatchObject({ status: 'failed', restored: true });
    const conversation = ConversationService.getInstance().getConversation(conversationId)!;
    expect(conversation.latestProvider).toBe('codex');
    expect(conversation.segments.map((segment) => segment.provider)).toEqual(['codex']);
    // The last run:start the harness recorded is Codex resuming its own thread.
    expect(harness.starts[1]).toMatchObject({ prompt: '', resume: THREAD_ID, extra: { provider: 'codex' } });
    expect(switchEvents()).toEqual(['requested', 'failed']);
    expect(eventTypes()).not.toContain(PROJECT_ORIENTED_EVENT);
    expect(unfinishedSwitchRefusal(conversationId, ConversationService.getInstance(), 'lattice')).toBeNull();
    expect(tryAdmitTurn(conversationId, 'send')).not.toBeNull();
  });

  it('blocks sends after a switch interrupted past run:ready, and undoes it on the next switch call', async () => {
    interruptedAfterReady();
    const { app, send } = sendRoute();

    // Accepted and kept, not refused: the receipt is a success, so the
    // composer does not hand the text back to be sent a second time.
    const res = await request(app).post(`/api/harness/${conversationId}/send`).send({ input: 'are you there?' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivery: 'saved' });
    expect(res.body.note).toContain(`lattice session switch ${conversationId} --provider claude --model ${TARGET.model}`);
    expect(res.body.note).not.toMatch(/transcript/i);
    expect(send).not.toHaveBeenCalled();
    // It goes to whichever provider runs once this is resolved, and until
    // then the waiting message on the thread says why.
    expect(unreadInboxItems(conversationId).map((row) => row.text)).toEqual(['are you there?']);
    expect((storedEvents.get(conversationId) ?? []).filter((event) => event.type === 'input:undeliverable').map((event) => event.data))
      .toEqual([{ ids: [res.body.inboxId], error: res.body.note }]);
    // Nor can anything else that would start a turn on the provider in doubt.
    for (const path of ['start', 'compact']) {
      const other = await request(app).post(`/api/harness/${conversationId}/${path}`).send({ prompt: 'go' });
      expect(other.status, path).toBe(409);
    }
    store(conversationId, 'content', { messageId: 'big', model: TARGET.model, apiUsage: { input_tokens: 900_000 }, blocks: [] });
    vi.stubEnv('LATTICE_AUTO_COMPACT_TOKENS', '1');
    expect(conversationContextTokens(conversationId)).not.toBeNull();
    expect(await maybeAutoCompact(conversationId)).toBe(false);
    expect(harness.compacts).toBe(0);
    vi.unstubAllEnvs();

    // Retrying does not read the Claude segment as a finished switch.
    const undone = await switchCoordinator(conversationId, TARGET, deps());
    expect(undone).toMatchObject({ status: 'rolled-back', provider: 'codex' });
    expect(ConversationService.getInstance().getConversation(conversationId)!.segments.map((segment) => segment.provider)).toEqual(['codex']);
    expect(harness.starts.at(-1)).toMatchObject({ prompt: '', resume: THREAD_ID, extra: { provider: 'codex' } });
    expect(unfinishedSwitchRefusal(conversationId, ConversationService.getInstance(), 'lattice')).toBeNull();

    // The kept message goes to Codex, now running, once the undo lets go of the turn.
    expect(drain).toHaveBeenCalledWith(conversationId);
    const { markInboxItemsRead } = await import('../../src/services/sessions/session-inbox.js');
    markInboxItemsRead(unreadInboxItems(conversationId).map((row) => row.id), 1);
    harness.script.push(claudeAnswers());
    const again = await switchCoordinator(conversationId, TARGET, deps());
    expect(again).toMatchObject({ status: 'switched' });
    expect(switchEvents()).toEqual(['requested', 'failed', 'requested', 'completed']);
  });

  it('treats a segment added but never recorded as unfinished too', async () => {
    ConversationService.getInstance().addSegment(conversationId, {
      provider: 'claude', providerSessionId: 'pending-switch-1', model: TARGET.model,
    });
    expect(unfinishedSwitchRefusal(conversationId, ConversationService.getInstance(), 'lattice')).toContain('before it was recorded');
    expect(await switchCoordinator(conversationId, TARGET, deps())).toMatchObject({ status: 'rolled-back' });
    expect(ConversationService.getInstance().getConversation(conversationId)!.segments).toHaveLength(1);
  });

  it('keeps sends blocked when Codex will not start again either, until an undo succeeds', async () => {
    harness.script.push((runId) => {
      harness.alive = false;
      harness.append('run:error', { message: 'spawn failed' }, runId);
    });
    const start = harness.start.bind(harness);
    let codexStarts = 0;
    harness.start = async (id, config) => {
      if (config.extra?.provider === 'codex' && codexStarts++ === 0) throw new Error('codex would not start');
      return start(id, config);
    };

    expect(await switchCoordinator(conversationId, TARGET, deps())).toMatchObject({ status: 'failed', restored: false });
    expect(ConversationService.getInstance().getLatestSegment(conversationId)!.provider).toBe('codex');
    expect(unfinishedSwitchRefusal(conversationId, ConversationService.getInstance(), 'lattice')).toContain('did not start again');

    expect(await switchCoordinator(conversationId, TARGET, deps())).toMatchObject({ status: 'rolled-back' });
    expect(unfinishedSwitchRefusal(conversationId, ConversationService.getInstance(), 'lattice')).toBeNull();
  });

  it('drains messages queued with a Codex model or effort to Claude without them', async () => {
    harness.script.push(claudeAnswers());
    expect((await switchCoordinator(conversationId, TARGET, deps())).status).toBe('switched');
    const { app, send } = sendRoute();
    const inboxId = enqueueInboxItem({ sessionId: conversationId, source: 'user', text: 'use astra', model: 'gpt-6-astra', reasoningEffort: 'medium' });

    const admission = tryAdmitTurn(conversationId, 'drain')!;
    const res = await request(app).post(`/api/harness/${conversationId}/send`).send({
      input: 'use astra', inboxIds: [inboxId], admission: admission.id, model: 'gpt-6-astra', reasoningEffort: 'medium',
    });
    admission.release();
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const [, text, extra] = send.mock.calls[0] as unknown as [string, string, Record<string, unknown> | undefined];
    expect(text.endsWith('use astra')).toBe(true);
    expect(extra?.model).toBeUndefined();
    expect(extra?.reasoningEffort).toBeUndefined();
  });

  it('refuses a send that waited behind the switch naming a Codex model, saving nothing', async () => {
    harness.script.push(claudeAnswers());
    const { app, send } = sendRoute();
    const switching = switchCoordinator(conversationId, TARGET, deps());
    const stale = request(app).post(`/api/harness/${conversationId}/send`).send({ input: 'use astra', model: 'gpt-6-astra' });
    expect((await switching).status).toBe('switched');

    const res = await stale;
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Not sent: gpt-6-astra is a Codex model, and this conversation now runs Claude. '
      + 'Choose a Claude model in the model menu, or send with no model to keep the current one, then send again.');
    expect(send).not.toHaveBeenCalled();
    expect(unreadInboxItems(conversationId)).toEqual([]);
  });

  it('does nothing on the model it is already on, and leaves a same-provider change to send --model', async () => {
    harness.script.push(claudeAnswers());
    await switchCoordinator(conversationId, TARGET, deps());
    expect(await switchCoordinator(conversationId, TARGET, deps())).toMatchObject({ status: 'unchanged' });
    expect(await switchCoordinator(conversationId, { provider: 'claude', model: 'claude-fable-5-1' }, deps()))
      .toMatchObject({ status: 'refused', code: 'same-provider' });
    expect(await switchCoordinator(conversationId, { provider: 'codex', model: 'gpt-6-astra' }, deps()))
      .toMatchObject({ status: 'refused', code: 'unsupported' });
    expect(harness.starts).toHaveLength(1);
  });
});
