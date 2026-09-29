/**
 * The coordination contract at its two boundaries: the note route, which is
 * the only way a thread transition is written, and the block a compacted
 * worker gets back.
 *
 * What the route has to refuse is as much the point as what it accepts. A
 * `--addresses conv-x` that reached across threads would let closing one
 * piece of work silently account for a report written on another, which is
 * the loophole the whole contract exists to shut.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RawEvent } from '../../src/session-history/types.js';

let storedEvents = new Map<string, RawEvent[]>();
let nextSeq = 1000;

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({ inspect: () => null }),
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_manager: unknown, sessionId: string, type: string, data: unknown) => {
    nextSeq += 1;
    const event = { conversationId: sessionId, seq: nextSeq, runId: 'run-1', timestamp: nextSeq, type, data, meta: null } as RawEvent;
    storedEvents.set(sessionId, [...(storedEvents.get(sessionId) ?? []), event]);
    return { seq: nextSeq, type, data };
  },
}));
vi.mock('../../src/session-history/repository.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import('./fake-event-reads.js')).fakeEventReads((conversationId) => storedEvents.get(conversationId) ?? []),
}));

const { DatabaseProvider } = await import('../../src/services/infrastructure/database-provider.js');
const { ConversationService } = await import('../../src/services/sessions/conversation-service.js');
const { SessionInfoService } = await import('../../src/services/sessions/session-info-service.js');
const { createUnifiedConversationRoutes } = await import('../../src/routes/conversation/unified-conversation.routes.js');
const { buildCoordinatorRestore } = await import('../../src/services/sessions/context-compaction.js');
const { buildProjectStateNudge } = await import('../../src/services/sessions/project-state.js');
const { renderProjectState } = await import('../../src/types/project-state.js');
type ProjectState = import('../../src/types/project-state.js').ProjectState;

function push(conversationId: string, type: string, data: unknown): number {
  nextSeq += 1;
  const event = { conversationId, seq: nextSeq, runId: 'run-1', timestamp: nextSeq, type, data, meta: null } as RawEvent;
  storedEvents.set(conversationId, [...(storedEvents.get(conversationId) ?? []), event]);
  return nextSeq;
}

function app(): express.Express {
  const application = express();
  application.use(express.json());
  application.use('/api/conv', createUnifiedConversationRoutes({
    historyReader: {} as never,
    activeConversationRegistry: { get: () => undefined } as never,
    sessionInfoService: new SessionInfoService(':memory:'),
    permissionTracker: {} as never,
  }));
  return application;
}

let coordinator: string;
let worker: string;

beforeEach(async () => {
  storedEvents = new Map();
  nextSeq = 1000;
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  const service = ConversationService.getInstance();
  coordinator = service.createConversation({ workingDirectory: '/tmp', provider: 'codex', providerSessionId: 'p-front', coordinator: true }).conversationId;
  worker = service.createConversation({ workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-w', pickedUpFrom: coordinator }).conversationId;
});
afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

const note = (body: Record<string, unknown>) => request(app()).post(`/api/conv/${coordinator}/project/note`).send(body);
/** These fixtures write worker events straight into the store, so they draw the accounting boundary themselves. */
const accounting = () => note({ kind: 'accounting', text: 'accounting starts here' });

describe('the note route', () => {
  it('updates a thread by its original id and refuses one that is not open', async () => {
    const opened = await note({ kind: 'open', text: 'ship the release board', owner: { kind: 'coordinator' } });
    expect(opened.status).toBe(200);
    const id = opened.body.seq as number;

    const updated = await note({
      kind: 'update',
      text: '',
      ref: id,
      owner: { kind: 'worker', worker },
      nextAction: 'verify the migration',
      waitingOn: { kind: 'worker', text: `${worker} is running it`, worker },
      workers: [worker],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.state.open).toHaveLength(1);
    expect(updated.body.state.open[0]).toMatchObject({
      seq: id,
      text: 'ship the release board',
      owner: { kind: 'worker', worker },
      nextAction: 'verify the migration',
      workers: [worker],
    });

    expect((await note({ kind: 'update', text: '', ref: id + 5000, nextAction: 'x' })).status).toBe(400);
    expect((await note({ kind: 'update', text: '', ref: id })).status).toBe(400);
    expect((await note({ kind: 'open', text: 'x', owner: { kind: 'worker' } })).status).toBe(400);
    expect((await note({ kind: 'open', text: 'x', waitingOn: { kind: 'nonsense', text: 'y' } })).status).toBe(400);
    expect((await note({ kind: 'update', text: '', ref: id, workers: ['conv-does-not-exist'] })).status).toBe(400);
  });

  it('holds a thread that needs the user to a one-line summary, and no other', async () => {
    const id = (await note({ kind: 'open', text: 'the beta' })).body.seq as number;
    const long = 'x'.repeat(161);
    expect((await note({ kind: 'update', text: long, ref: id })).status).toBe(200);
    const refused = await note({ kind: 'update', text: long, ref: id, waitingOn: { kind: 'decision', text: 'the go' } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('--evidence');
    await note({ kind: 'update', text: '', ref: id, owner: { kind: 'user' } });
    expect((await note({ kind: 'update', text: long, ref: id })).status).toBe(400);
    expect((await note({ kind: 'update', text: 'x'.repeat(160), ref: id })).status).toBe(200);
  });

  it('expands --addresses <worker> only over that thread, so closing one does not account for another', async () => {
    await accounting();
    const first = (await note({ kind: 'open', text: 'the migration' })).body.seq as number;
    push(coordinator, 'worker:started', { worker, provider: 'claude', model: null, task: 'apply it', thread: first });
    const onFirst = push(coordinator, 'worker:reported', { worker, model: null, text: 'migration applied' });

    const second = (await note({ kind: 'open', text: 'the readout' })).body.seq as number;
    await note({ kind: 'update', text: '', ref: second, workers: [worker] });
    const onSecond = push(coordinator, 'worker:reported', { worker, model: null, text: 'readout still null' });

    const state = (await request(app()).get(`/api/conv/${coordinator}/project`)).body;
    expect(state.attention.map((item: { seq: number; thread: number }) => [item.seq, item.thread]))
      .toEqual([[onFirst, first], [onSecond, second]]);

    // The worker shorthand on the first thread reaches only its own report.
    const closed = await note({ kind: 'close', text: 'applied and verified', ref: first, addresses: [worker] });
    expect(closed.status).toBe(200);
    expect(closed.body.state.attention.map((item: { seq: number }) => item.seq)).toEqual([onSecond]);

    // Naming another thread's event outright is still refused once it is no
    // longer pending, and a worker with nothing pending here is an error
    // rather than a silent no-op.
    expect((await note({ kind: 'update', text: '', ref: second, addresses: [onFirst] })).status).toBe(400);
    const done = await note({ kind: 'close', text: 'readout landed', ref: second, addresses: [onSecond] });
    expect(done.body.state.attention).toEqual([]);
    expect((await note({ kind: 'open', text: 'third', addresses: [worker] })).status).toBe(400);
  });
});

describe('rendering a state an older server sent', () => {
  it('renders what a pre-threads server returned instead of throwing', () => {
    // The shape a 3343484d server answers `/project` with: no attention, no
    // closed, no historical, and open entries carrying only seq/text/at.
    const legacy = {
      outcome: 'Get the trial activated',
      decisions: [],
      open: [{ seq: 4, text: 'wire the detector CLI routes', at: 1 }],
    } as unknown as ProjectState;

    const rendered = renderProjectState(legacy);

    expect(rendered).toContain('Outcome: Get the trial activated');
    expect(rendered).toContain('[4] wire the detector CLI routes');
    expect(rendered).toContain('no owner noted');
  });
});

describe('the accounting boundary at the route', () => {
  it('refuses a second boundary, and refuses to reconcile anything but unreconciled history', async () => {
    const thread = (await note({ kind: 'open', text: 'ship it' })).body.seq as number;
    const early = push(coordinator, 'worker:reported', { worker, model: null, text: 'from before the boundary' });
    expect((await accounting()).status).toBe(200);
    expect((await accounting()).status).toBe(400);

    push(coordinator, 'worker:started', { worker, provider: 'claude', model: null, task: 't', thread });
    const after = push(coordinator, 'worker:reported', { worker, model: null, text: 'since the boundary' });

    // A post-boundary report is ordinary attention, and says so rather than failing blankly.
    const wrong = await note({ kind: 'reconcile', text: 'handled', disposition: 'handled', addresses: [after] });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain('on its thread');

    expect((await note({ kind: 'reconcile', text: 'x', disposition: 'handled', addresses: [] })).status).toBe(400);
    expect((await note({ kind: 'reconcile', text: 'x', addresses: [early] })).status).toBe(400);
    expect((await note({ kind: 'reconcile', text: 'x', disposition: 'handled', addresses: [early], ref: thread + 99 })).status).toBe(400);

    const done = await note({ kind: 'reconcile', text: 'closed at [4464] with the live readout', disposition: 'handled', addresses: [early], ref: thread });
    expect(done.status).toBe(200);
    expect(done.body.state.historical).toEqual([]);
    expect(done.body.state.attention.map((item: { seq: number }) => item.seq)).toEqual([after]);
  });

  it('starts accounting on a new project\'s first dispatch, and never behind a log that already has reports', async () => {
    const { appendWorkerEvent } = await import('../../src/services/sessions/worker-events.js');
    appendWorkerEvent(coordinator, 'worker:started', { worker, provider: 'claude', model: null, task: 'first' });
    const first = (await request(app()).get(`/api/conv/${coordinator}/project`)).body;
    expect(first.accountingFrom).not.toBeNull();
    const report = push(coordinator, 'worker:reported', { worker, model: null, text: 'done' });
    expect((await request(app()).get(`/api/conv/${coordinator}/project`)).body.attention.map((i: { seq: number }) => i.seq)).toEqual([report]);

    // A coordinator that already has reports is not accounted behind them.
    const legacy = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'codex', providerSessionId: 'p-old', coordinator: true,
    }).conversationId;
    push(legacy, 'worker:reported', { worker, model: null, text: 'from before any of this' });
    appendWorkerEvent(legacy, 'worker:started', { worker, provider: 'claude', model: null, task: 'next' });
    const old = (await request(app()).get(`/api/conv/${legacy}/project`)).body;
    expect(old.accountingFrom).toBeNull();
    expect(old.attention).toEqual([]);
    expect(old.historical).toHaveLength(1);
  });
});

describe('answering a question', () => {
  it('accepts only a seq that really is a question this worker asked this coordinator', async () => {
    const { isWorkerQuestionSeq } = await import('../../src/services/sessions/worker-events.js');
    const question = push(coordinator, 'worker:asked', { worker, text: 'Question for front: which store?' });
    const report = push(coordinator, 'worker:reported', { worker, model: null, text: 'done' });
    expect(isWorkerQuestionSeq(coordinator, worker, question)).toBe(true);
    // A report is not a question, another worker's question is not this one's,
    // and a seq that is not in the log at all is not one either.
    expect(isWorkerQuestionSeq(coordinator, worker, report)).toBe(false);
    expect(isWorkerQuestionSeq(coordinator, 'conv-someone-else', question)).toBe(false);
    expect(isWorkerQuestionSeq(coordinator, worker, question + 500)).toBe(false);
  });
});

describe('the nudge', () => {
  it('names the report a turn left unaccounted for, and says nothing once it is accounted for', async () => {
    await accounting();
    const thread = (await note({ kind: 'open', text: 'ship it' })).body.seq as number;
    push(coordinator, 'worker:started', { worker, provider: 'claude', model: null, task: 'build it', thread });
    const report = push(coordinator, 'worker:reported', { worker, model: null, text: 'Done and verified.' });
    push(coordinator, 'input:sent', { text: '[Report from worker …]' });
    await note({ kind: 'now', text: 'reading the report' });
    push(coordinator, 'turn:end', {});

    const nudge = buildProjectStateNudge(coordinator, 'lattice');
    expect(nudge).toContain(`[${report}] the report from ${worker}`);
    expect(nudge).toContain('--answers');

    await note({ kind: 'update', text: '', ref: thread, nextAction: 'activate', addresses: [report] });
    expect(buildProjectStateNudge(coordinator, 'lattice')).toBe('');
  });

  it('names the newest few and counts the rest, so a coordinator that predates the record is not handed a wall', async () => {
    await accounting();
    const thread = (await note({ kind: 'open', text: 'ship it' })).body.seq as number;
    push(coordinator, 'worker:started', { worker, provider: 'claude', model: null, task: 'build it', thread });
    const seqs = Array.from({ length: 7 }, (_, i) => push(coordinator, 'worker:reported', { worker, model: null, text: `report ${i}` }));
    push(coordinator, 'input:sent', { text: 'go' });
    push(coordinator, 'turn:end', {});

    const nudge = buildProjectStateNudge(coordinator, 'lattice');
    for (const seq of seqs.slice(-3)) expect(nudge).toContain(`[${seq}]`);
    for (const seq of seqs.slice(0, 4)) expect(nudge).not.toContain(`[${seq}]`);
    expect(nudge).toContain('and 4 older');
    expect(nudge).toContain(`session state ${coordinator}`);
  });

  it('looks only at the turn since the last input: a dispatch there with no note, not a report that arrived during it', async () => {
    await accounting();
    push(coordinator, 'worker:started', { worker: 'conv-earlier', provider: 'claude', model: null, task: 'noted before' });
    await note({ kind: 'now', text: 'dispatched conv-earlier' });
    push(coordinator, 'input:sent', { text: 'go' });
    push(coordinator, 'worker:started', { worker, provider: 'claude', model: null, task: 'build it' });
    const midTurn = push(coordinator, 'worker:reported', { worker, model: null, text: 'Done.' });
    push(coordinator, 'turn:end', {});

    const nudge = buildProjectStateNudge(coordinator, 'lattice');
    expect(nudge).toContain('left the project state untouched');
    expect(nudge).not.toContain(`[${midTurn}]`);
  });
});

describe('dispatching onto a thread', () => {
  it('refuses a thread that is not open on the parent, and a thread with no parent to own it', async () => {
    const thread = (await note({ kind: 'open', text: 'real thread' })).body.seq as number;
    expect((await request(app()).post('/api/conv/create').send({ pickedUpFrom: coordinator, thread: thread + 99, message: 'go' })).status).toBe(400);
    expect((await request(app()).post('/api/conv/create').send({ thread, message: 'go' })).status).toBe(400);
  });
});

describe('a compacted worker', () => {
  it('gets back who dispatched it, the thread it is on, the decisions and where its colleagues reported', async () => {
    const thread = (await note({ kind: 'open', text: 'wire the detector CLI' })).body.seq as number;
    await note({ kind: 'outcome', text: 'a detector CLI the user can run' });
    await note({ kind: 'decision', text: 'no new store; extend the project record', by: 'user' });
    await note({ kind: 'update', text: '', ref: thread, nextAction: 'wire the routes', waitingOn: { kind: 'decision', text: 'the user on the flag name' } });
    push(coordinator, 'worker:started', { worker, provider: 'claude', model: 'claude-fable-5-1', task: 'wire the detector CLI routes', thread });

    const sibling = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-s', pickedUpFrom: coordinator,
    }).conversationId;
    push(coordinator, 'worker:started', { worker: sibling, provider: 'claude', model: null, task: 'audit what a worker can read', thread });
    const siblingReport = push(coordinator, 'worker:reported', { worker: sibling, model: null, text: 'Workers can already read the project state.\nMore detail follows.' });

    // The worker's own log: a turn, then a compaction boundary.
    push(worker, 'input:sent', { text: 'go' });
    push(worker, 'turn:end', { compact: true, trigger: 'auto' });

    const restored = buildCoordinatorRestore(worker);
    expect(restored).toContain(`Picked up from ${coordinator}`);
    expect(restored).toContain(`Your thread: [${thread}] wire the detector CLI`);
    expect(restored).toContain('What front dispatched you to do: wire the detector CLI routes');
    expect(restored).toContain('next: wire the routes');
    expect(restored).toContain('waiting on decision: the user on the flag name');
    expect(restored).toContain('What this project is for: a detector CLI the user can run');
    expect(restored).toContain("no new store; extend the project record (the user's call)");
    expect(restored).toContain(`- [${siblingReport}] ${sibling} (your thread): Workers can already read the project state.`);
    expect(restored).toContain(`session event ${coordinator} <seq>`);
    // Its own report is not read back to it.
    expect(restored).not.toContain(`] ${worker}:`);
  });

  it('is given the block whole, with no stray rule left from the preamble it embeds', async () => {
    const thread = (await note({ kind: 'open', text: 'do a thing' })).body.seq as number;
    push(coordinator, 'worker:started', { worker, provider: 'claude', model: null, task: 't', thread });
    push(worker, 'input:sent', { text: 'go' });
    push(worker, 'turn:end', { compact: true, trigger: 'auto' });
    expect(buildCoordinatorRestore(worker).split('\n').filter((line) => line.trim() === '---')).toEqual([]);
  });

  it('is not built for an ordinary pickup, whose parent has no project to point it at', () => {
    const plain = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-plain',
    }).conversationId;
    const child = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-child', pickedUpFrom: plain,
    }).conversationId;
    push(child, 'input:sent', { text: 'go' });
    push(child, 'turn:end', { compact: true, trigger: 'auto' });
    expect(buildCoordinatorRestore(child)).toBe('');
  });

  it('gets nothing when it has not compacted since its last input', () => {
    push(worker, 'input:sent', { text: 'go' });
    push(worker, 'turn:end', {});
    expect(buildCoordinatorRestore(worker)).toBe('');
  });
});

describe('a compacted New-screen session', () => {
  it('gets its diagram guidance back, with no stray rule', () => {
    const plain = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'codex', providerSessionId: 'p-plain',
    }).conversationId;
    push(plain, 'input:sent', { text: 'go' });
    push(plain, 'turn:end', { compact: true, trigger: 'auto' });
    const restored = buildCoordinatorRestore(plain);
    expect(restored).toContain('This session runs in Lattice, ');
    expect(restored).toContain('Never draw ASCII-art diagrams.');
    expect(restored.split('\n').filter((line) => line.trim() === '---')).toEqual([]);
  });
});
