/**
 * Router + fast responder contract: a message to a busy coordinator is
 * judged once ("does this need a reply before the turn ends?"); yes gets a
 * provisional answer in the thread and the exchange in the next batch, no
 * or no judge leaves the message on the path it always took.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { createHarnessRoutes } from '../../src/harness/routes.js';
import { __setGenerationOverridesForTests } from '../../src/services/infrastructure/generation-gates.js';
import { foldThread, renderCurrentTurnActivity, renderRecentThread, type ThreadEventLike } from '../../src/services/sessions/coordinator-thread.js';

const inspect = vi.fn<() => { processAlive: boolean; status: string; resumeId: string | null } | null>(() => null);
const appended: Array<{ sessionId: string; type: string; data: unknown }> = [];
let nextSeq = 100;
let storedEvents: ThreadEventLike[] = [];
// Immediate delivery off: this covers the path a mid-turn message takes when it waits for the turn.
const config: Record<string, unknown> = { server: { host: '0.0.0.0', port: 3999 }, messaging: { immediateDelivery: false } };
const messagesCreate = vi.fn();

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({ inspect }),
}));
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: { getInstance: () => ({ getConfig: () => config }) },
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_manager: unknown, sessionId: string, type: string, data: unknown) => {
    appended.push({ sessionId, type, data });
    nextSeq += 1;
    return { seq: nextSeq, type, data };
  },
}));
vi.mock('../../src/session-history/repository.js', () => ({
  getEvents: () => storedEvents,
}));
vi.mock('../../src/services/infrastructure/anthropic-client-factory.js', () => ({
  anthropicClientFactory: { getClient: () => ({ messages: { create: messagesCreate } }) },
}));

const inbox = await import('../../src/services/sessions/session-inbox.js');
const typesafe = await import('../../src/services/infrastructure/typesafe-client.js');
const router = await import('../../src/services/sessions/coordinator-router.js');
const fast = await import('../../src/services/sessions/coordinator-fast-reply.js');

let seq = 0;
function event(type: string, data: unknown = {}): ThreadEventLike {
  seq += 1;
  return { seq, type, timestamp: Date.UTC(2026, 8, 20, 10, 0, seq), data };
}

function jevAnswers(noul: number) {
  return async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul } } }), { status: 200 });
}

beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  appended.length = 0;
  storedEvents = [];
  seq = 0;
  inspect.mockReset();
  inspect.mockReturnValue(null);
  messagesCreate.mockReset();
  delete config.typesafe;
  delete config.coordinator;
  __setGenerationOverridesForTests({ coordinatorFastReply: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setGenerationOverridesForTests(null);
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('TypeSafe client', () => {
  it('reads the key from config, env, or a file, and never puts it in the answer', async () => {
    expect(typesafe.resolveTypeSafeKey()).toBeNull();
    config.typesafe = { apiKey: 'sk-config' };
    let authHeader = '';
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      authHeader = (init.headers as Record<string, string>).Authorization;
      return jevAnswers(0.8)();
    });
    const answer = await typesafe.judgeNoul('state', { instructions: 'q' }, { timeoutMs: 1000 });
    expect(authHeader).toBe('Bearer sk-config');
    expect(answer).toMatchObject({ noul: 0.8, model: 'jev-1.13.0' });
    expect(JSON.stringify(answer)).not.toContain('sk-config');
  });

  it('fails as unavailable on a non-200, a malformed body, or a missing key', async () => {
    await expect(typesafe.judgeNoul('s', { instructions: 'q' }, { timeoutMs: 1000 })).rejects.toThrow('not configured');
    config.typesafe = { apiKey: 'k' };
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    await expect(typesafe.judgeNoul('s', { instructions: 'q' }, { timeoutMs: 1000 })).rejects.toThrow('503');
    vi.stubGlobal('fetch', async () => new Response('{"answers":{}}', { status: 200 }));
    await expect(typesafe.judgeNoul('s', { instructions: 'q' }, { timeoutMs: 1000 })).rejects.toThrow('no noul');
  });

  it('retries once on 429 then answers', async () => {
    config.typesafe = { apiKey: 'k' };
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return calls === 1 ? new Response('slow down', { status: 429 }) : jevAnswers(0.2)();
    });
    expect((await typesafe.judgeNoul('s', { instructions: 'q' }, { timeoutMs: 2000 })).noul).toBe(0.2);
    expect(calls).toBe(2);
  });
});

describe('recent thread', () => {
  it('shows the user, the coordinator, workers and fast replies in order, without server blocks or drained batches', () => {
    const events = [
      event('input:sent', { text: 'You are `front`: the conversation the user talks to.\n---\nstart here' }),
      event('content', { blocks: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Bash' }] }),
      event('worker:started', { worker: 'conv-w', provider: 'claude', model: 'claude-opus-5', task: 'check the thing' }),
      event('content', { blocks: [{ type: 'text', text: 'sub-agent chatter' }], parentToolUseId: 'tu-1' }),
      event('input:sent', { text: '[Report from worker conv-w · claude-opus-5. The user has not read this]\n\nfound it' }),
      event('worker:reported', { worker: 'conv-w', model: 'claude-opus-5', text: 'found it' }),
      event('input:queued', { id: 'q1', source: 'user', text: 'what did it find?' }),
      event('coordinator:replied', { inboxId: 'q1', text: 'It found the thing.', model: 'claude-sonnet-5', responder: 'fast' }),
      event('input:sent', { text: '[From the server: this message arrived while you were busy and was answered provisionally.]\n[End of server note]\nwhat did it find?' }),
      event('input:read', { ids: ['q1'] }),
      event('content', { blocks: [{ type: 'text', text: 'Confirmed.' }] }),
    ];
    expect(foldThread(events).map((entry) => [entry.who, entry.text])).toEqual([
      ['user', 'start here'],
      ['coordinator', 'On it.'],
      ['coordinator', '(dispatched worker conv-w: check the thing)'],
      ['worker', 'conv-w reported: found it'],
      ['user', 'what did it find?'],
      ['fast responder', 'It found the thing.'],
      ['coordinator', 'Confirmed.'],
    ]);
    const last = renderRecentThread(events, 1);
    expect(last).toMatch(/^\[the user · \d\d:\d\d\]\nwhat did it find\?/);
    expect(last).not.toContain('start here');
    expect(renderRecentThread([], 3)).toBe('(nothing in the thread yet)');
  });

  it('joins a Codex message streamed a token at a time into one entry, spaces kept', () => {
    const token = (text: string, messageId: string) => event('content', { blocks: [{ type: 'text', text }], messageId });
    const events = [
      event('input:sent', { text: 'status?' }),
      token('The', 'codex-msg_a'), token(' pul', 'codex-msg_a'), token('sing', 'codex-msg_a'), token(' line.\n', 'codex-msg_a'),
      event('worker:reported', { worker: 'conv-w', model: 'gpt-6-astra', text: 'done' }),
      token('Next', 'codex-msg_b'), token(' one.', 'codex-msg_b'),
    ];
    expect(foldThread(events).map((entry) => [entry.who, entry.text])).toEqual([
      ['user', 'status?'],
      ['coordinator', 'The pulsing line.'],
      ['worker', 'conv-w reported: done'],
      ['coordinator', 'Next one.'],
    ]);
  });
});

describe('current turn activity', () => {
  it('lists what the coordinator ran since its turn began, never the output or a sub-agent\'s calls', () => {
    const tool = (name: string, input: Record<string, unknown>, parentToolUseId: string | null = null) =>
      event('content', { blocks: [{ type: 'tool_use', id: `tu-${seq}`, name, input }], parentToolUseId });
    const events = [
      event('input:sent', { text: 'earlier' }),
      tool('Bash', { command: 'echo old turn' }),
      event('turn:end'),
      event('input:sent', { text: 'audit today\'s Opus 5 work' }),
      event('content', { blocks: [{ type: 'text', text: 'Counting.' }] }),
      tool('Bash', { command: 'sqlite3 db "select count(*) from workers"' }),
      event('result', { output: '15' }),
      tool('Read', { file_path: '/tmp/brief.md' }),
      tool('Grep', { pattern: 'x' }, 'tu-parent'),
      event('input:sent', { text: 'delivered mid-turn' }),
      tool('TodoWrite', { todos: [] }),
    ];
    const lines = renderCurrentTurnActivity(events).split('\n');
    expect(lines.map((line) => line.replace(/^\[\d\d:\d\d\] /, ''))).toEqual([
      'Bash: sqlite3 db "select count(*) from workers"',
      'Read: /tmp/brief.md',
      'TodoWrite',
    ]);
    expect(renderCurrentTurnActivity([...events, event('turn:end')])).toBe('(front is not in a turn: its last one has ended)');
    expect(renderCurrentTurnActivity([event('input:sent', { text: 'go' })])).toBe('(no tool calls yet in this turn)');
  });
});

describe('router', () => {
  it('puts the thread, the now line and the message in front of Jev and applies the threshold', async () => {
    config.typesafe = { apiKey: 'k' };
    storedEvents = [
      event('input:sent', { text: 'go' }),
      event('project:noted', { kind: 'now', text: 'dispatching the verifier', by: 'coordinator' }),
    ];
    let sent: { state?: string; questions?: Record<string, unknown> } = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string) as typeof sent;
      return jevAnswers(0.61)();
    });
    const verdict = await router.routeCoordinatorMessage('conv-c', 'is it done yet?');
    expect(sent.state).toContain('Now: dispatching the verifier');
    expect(sent.state).toMatch(/\[message\]\nis it done yet\?$/);
    expect(sent.questions).toEqual({ q: { type: 'noul', ...router.ROUTER_QUESTION } });
    expect(verdict).toMatchObject({ needsReplyNow: true, score: 0.61, threshold: router.DEFAULT_ROUTER_THRESHOLD });

    config.coordinator = { fastReply: { threshold: 0.7 } };
    expect((await router.routeCoordinatorMessage('conv-c', 'is it done yet?')).needsReplyNow).toBe(false);
  });

  it('answers "wait" with the error when Jev cannot be asked', async () => {
    const verdict = await router.routeCoordinatorMessage('conv-c', 'hello?');
    expect(verdict).toMatchObject({ needsReplyNow: false, score: null });
    expect(verdict.error).toContain('not configured');
  });
});

describe('inbox with a provisional reply', () => {
  it('holds a row out of the drain until the reply lands, then carries the reply with the message', () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'is it done?', replyPending: true });
    expect(inbox.hasUnreadInboxItems('conv-c')).toBe(true);
    expect(inbox.unreadInboxItems('conv-c')).toEqual([]);

    inbox.setInboxReply(id, 'Not yet; the verifier is still running.');
    const rows = inbox.unreadInboxItems('conv-c');
    expect(rows.map((row) => row.id)).toEqual([id]);
    const out = inbox.composeInboxInput(rows, 'lattice');
    // The question, the exact answer and who gave it all survive; the handoff
    // neither claims the user read the answer nor asks the coordinator to
    // ratify it in the thread.
    expect(out).toMatch(/^\[From the server: this message arrived while you were busy and was answered provisionally\.\]\n\[End of server note\]\n\[From the user · \d\d:\d\d\]\nis it done\?\n\n\[Automatic quick answer from the fast responder while you were busy · \d\d:\d\d\. [^\]]*\]\nNot yet; the verifier is still running\.$/);
    expect(out).toContain('Do not assume the user read it');
    expect(out).not.toMatch(/the user has seen this|confirm it or correct it/);
  });

  it('releases rows a previous server was still answering', () => {
    inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'stuck', replyPending: true });
    expect(inbox.releasePendingReplies()).toBe(1);
    expect(inbox.unreadInboxItems('conv-c').map((row) => row.text)).toEqual(['stuck']);
    expect(inbox.unreadInboxItems('conv-c')[0].reply).toBeNull();
  });
});

describe('fast responder', () => {
  it('answers from the state and thread, appends the reply as the coordinator\'s, and releases the row', async () => {
    const coordinator = ConversationService.getInstance().createConversation({ workingDirectory: '/tmp/x', provider: 'claude', providerSessionId: 'p-1', coordinator: true }).conversationId;
    storedEvents = [
      event('input:sent', { text: 'ship the board' }),
      event('project:noted', { kind: 'outcome', text: 'a working release board', by: 'coordinator' }),
      event('worker:started', { worker: 'conv-w', provider: 'claude', model: 'claude-opus-5', task: 'build the readout' }),
    ];
    const id = inbox.enqueueInboxItem({ sessionId: coordinator, source: 'user', text: 'who is on the readout?', replyPending: true });
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'conv-w is building the readout.' }], usage: { input_tokens: 10, output_tokens: 5 } });
    inspect.mockReturnValue({ processAlive: true, status: 'streaming', resumeId: null });

    await fast.answerProvisionally({ conversationId: coordinator, inboxId: id, message: 'who is on the readout?' });

    const call = messagesCreate.mock.calls[0][0] as { model: string; thinking: unknown; system: string; messages: Array<{ content: string }> };
    expect(call.model).toBe(fast.DEFAULT_FAST_REPLY_MODEL);
    expect(call.thinking).toEqual({ type: 'disabled' });
    expect(call.system).toContain('You have no tools');
    // A correction gets engaged with, not filed: the responder can neither
    // record work nor answer for the coordinator's other threads.
    expect(call.system).toContain('Do not say it has been noted, logged, assigned or');
    expect(call.system).toContain('are there to answer them, not to comment on');
    expect(call.messages[0].content).toContain('Outcome: a working release board');
    expect(call.messages[0].content).toContain('conv-w · claude · claude-opus-5 — build the readout');
    expect(call.messages[0].content).toContain('What front has run in its current turn');
    expect(call.system).toContain('never infer an answer from what front ran');
    expect(call.messages[0].content).toMatch(/who is on the readout\?$/);
    expect(inbox.getInboxItem(id)).toMatchObject({ reply: 'conv-w is building the readout.', reply_pending: 0 });
    expect(appended.at(-1)).toEqual({
      sessionId: coordinator,
      type: 'coordinator:replied',
      data: { inboxId: id, text: 'conv-w is building the readout.', model: 'claude-sonnet-5', responder: 'fast' },
    });
  });

  it('leaves the message waiting, unanswered, when the model call fails', async () => {
    const coordinator = ConversationService.getInstance().createConversation({ workingDirectory: '/tmp/x', provider: 'claude', providerSessionId: 'p-1', coordinator: true }).conversationId;
    const id = inbox.enqueueInboxItem({ sessionId: coordinator, source: 'user', text: 'hm?', replyPending: true });
    messagesCreate.mockRejectedValue(new Error('overloaded'));
    inspect.mockReturnValue({ processAlive: true, status: 'streaming', resumeId: null });
    await fast.answerProvisionally({ conversationId: coordinator, inboxId: id, message: 'hm?' });
    expect(inbox.getInboxItem(id)).toMatchObject({ reply: null, reply_pending: 0 });
    expect(appended.map((entry) => entry.type)).toEqual(['input:queued']);
  });

  it('abstains rather than fill the box, leaving the message to reach the coordinator whole', async () => {
    const coordinator = ConversationService.getInstance().createConversation({ workingDirectory: '/tmp/x', provider: 'claude', providerSessionId: 'p-1', coordinator: true }).conversationId;
    storedEvents = [event('input:sent', { text: 'ship the board' })];
    const id = inbox.enqueueInboxItem({ sessionId: coordinator, source: 'user', text: 'what are these two headings for?', replyPending: true });
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: `${fast.NO_USEFUL_ANSWER}` }], usage: {} });
    inspect.mockReturnValue({ processAlive: true, status: 'streaming', resumeId: null });

    await fast.answerProvisionally({ conversationId: coordinator, inboxId: id, message: 'what are these two headings for?' });

    // Same end state as a failed call: no box in the thread, the row drainable
    // with its text untouched.
    expect(inbox.getInboxItem(id)).toMatchObject({ reply: null, reply_pending: 0 });
    expect(appended.map((entry) => entry.type)).toEqual(['input:queued']);
    expect(inbox.unreadInboxItems(coordinator).map((row) => row.text)).toEqual(['what are these two headings for?']);
  });
});

describe('/send to a busy coordinator', () => {
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

  function coordinator(): string {
    return ConversationService.getInstance().createConversation({ workingDirectory: '/tmp/x', provider: 'claude', providerSessionId: 'p-1', coordinator: true }).conversationId;
  }

  it('routes a message that needs a reply now: held row, verdict recorded, fast reply written, nothing to the process', async () => {
    config.typesafe = { apiKey: 'k' };
    vi.stubGlobal('fetch', jevAnswers(0.9));
    inspect.mockReturnValue({ processAlive: true, status: 'streaming', resumeId: null });
    // The model call is held open so the row can be seen in its held-out state.
    let finishReply: (value: unknown) => void = () => {};
    messagesCreate.mockReturnValue(new Promise((resolve) => { finishReply = resolve; }));
    const id = coordinator();
    const { app, send } = build({ provider: 'claude', status: 'streaming' });

    const res = await request(app).post(`/api/harness/${id}/send`).send({ input: 'did we decide on PEACH?' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivery: 'after-turn', responder: 'fast' });
    expect(send).not.toHaveBeenCalled();
    expect(inbox.getInboxItem(res.body.inboxId as string)).toMatchObject({ text: 'did we decide on PEACH?', reply_pending: 1 });
    expect(inbox.unreadInboxItems(id)).toEqual([]);
    expect(appended.map((entry) => entry.type)).toEqual(['input:queued', 'coordinator:routed']);
    expect(appended[1].data).toMatchObject({ inboxId: res.body.inboxId, needsReplyNow: true, score: 0.9 });

    finishReply({ content: [{ type: 'text', text: 'Provisionally yes.' }], usage: {} });
    await vi.waitFor(() => expect(inbox.getInboxItem(res.body.inboxId as string)?.reply).toBe('Provisionally yes.'));
    expect(appended.at(-1)?.type).toBe('coordinator:replied');
  });

  it('sends a message that can wait down the usual path and records the verdict', async () => {
    config.typesafe = { apiKey: 'k' };
    vi.stubGlobal('fetch', jevAnswers(0.1));
    const id = coordinator();
    const { app, send } = build({ provider: 'claude', status: 'streaming' });
    const res = await request(app).post(`/api/harness/${id}/send`).send({ input: 'also fix the footer later' });
    expect(res.body).toMatchObject({ ok: true, delivery: 'after-turn' });
    expect(res.body.responder).toBeUndefined();
    expect(send).toHaveBeenCalled();
    expect(appended.map((entry) => entry.type)).toEqual(['coordinator:routed']);
    expect(appended[0].data).toMatchObject({ needsReplyNow: false, score: 0.1 });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('is today\'s behaviour when Jev is unconfigured, the gate is off, the session is idle, or it is not a coordinator', async () => {
    // No key: verdict recorded as a miss, message goes to the process.
    inspect.mockReturnValue({ processAlive: true, status: 'streaming', resumeId: null });
    const id = coordinator();
    let built = build({ provider: 'claude', status: 'streaming' });
    await request(built.app).post(`/api/harness/${id}/send`).send({ input: 'hello?' });
    expect(built.send).toHaveBeenCalled();
    expect(appended.at(-1)).toMatchObject({ type: 'coordinator:routed', data: { needsReplyNow: false, score: null } });

    // Gate off: no verdict at all.
    appended.length = 0;
    __setGenerationOverridesForTests({ coordinatorFastReply: false });
    config.typesafe = { apiKey: 'k' };
    vi.stubGlobal('fetch', jevAnswers(0.9));
    built = build({ provider: 'claude', status: 'streaming' });
    await request(built.app).post(`/api/harness/${id}/send`).send({ input: 'hello?' });
    expect(built.send).toHaveBeenCalled();
    expect(appended).toEqual([]);

    // Idle: an ordinary turn.
    __setGenerationOverridesForTests({ coordinatorFastReply: true });
    inspect.mockReturnValue({ processAlive: true, status: 'idle', resumeId: null });
    built = build({ provider: 'claude', status: 'idle' });
    const idle = await request(built.app).post(`/api/harness/${id}/send`).send({ input: 'hello?' });
    expect(idle.body.delivery).toBe('now');
    expect(appended).toEqual([]);

    // Not a coordinator: parked for Codex as before, no verdict.
    const plain = ConversationService.getInstance().createConversation({ workingDirectory: '/tmp', provider: 'codex', providerSessionId: 'p-2' }).conversationId;
    inspect.mockReturnValue({ processAlive: true, status: 'streaming', resumeId: null });
    built = build({ provider: 'codex', status: 'streaming' });
    const parked = await request(built.app).post(`/api/harness/${plain}/send`).send({ input: 'hello?' });
    expect(parked.body.delivery).toBe('after-turn');
    expect(appended.map((entry) => entry.type)).toEqual(['input:queued']);
  });
});

describe('thread placement of a fast-answered message', () => {
  it('floats while unanswered, then sits above its quick answer rather than at the batch that carried it', async () => {
    const { placeWaitingMessages } = await import('../../src/web/chat/hooks/useHarnessSession.js');
    const { foldInbox } = await import('../../src/types/inbox.js');
    const queued = event('input:queued', { id: 'q1', source: 'user', text: 'progress?' });
    const waiting = [event('input:sent', { text: 'do the slow thing' }), queued] as unknown as SessionEvent[];
    const before = placeWaitingMessages(waiting, foldInbox(waiting));
    expect(before.pending.map((p) => p.text)).toEqual(['progress?']);
    expect(before.consumed).toEqual([]);

    const replied = event('coordinator:replied', { inboxId: 'q1', text: 'Halfway.', model: 'claude-sonnet-5', responder: 'fast' });
    const batch = event('input:sent', { text: '[From the server: this message arrived while you were busy and was answered provisionally.]\n[End of server note]\nprogress?' });
    const done = [...waiting, replied, event('content', { blocks: [{ type: 'text', text: 'Done.' }] }), batch, event('input:read', { ids: ['q1'] })] as unknown as SessionEvent[];
    const after = placeWaitingMessages(done, foldInbox(done));
    expect(after.pending).toEqual([]);
    expect(after.consumed.map((c) => [c.inputEvent.seq, c.consumedByEvent.seq])).toEqual([[queued.seq, replied.seq]]);
  });
});

describe('an agent message in the thread', () => {
  it('carries who sent it, and the user\'s own message carries nothing', async () => {
    const { placeWaitingMessages } = await import('../../src/web/chat/hooks/useHarnessSession.js');
    const { attributionLabel } = await import('../../src/web/chat/components/shared/message-attribution.js');
    const { foldInbox } = await import('../../src/types/inbox.js');
    const events = [
      event('input:queued', { id: 'a1', source: 'agent', text: 'the branch is ready', sender: 'conv-worker' }),
      event('input:queued', { id: 'a2', source: 'agent', text: 'ship it', sender: 'conv-front', passedOn: true }),
      event('input:queued', { id: 'a3', source: 'agent', text: 'who am i' }),
      event('input:queued', { id: 'u1', source: 'user', text: 'what is going on' }),
    ] as unknown as SessionEvent[];

    const { pending } = placeWaitingMessages(events, foldInbox(events));
    expect(pending.map((p) => p.attribution && attributionLabel(p.attribution))).toEqual([
      'From conv-worker',
      'From conv-front, relaying your decision',
      'From an unidentified sender',
      undefined,
    ]);
  });
});
