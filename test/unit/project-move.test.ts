/**
 * Splitting a project: a worker, or an open thread with its workers, moves
 * from one coordinator to another (`session move-worker` / `move-thread`).
 *
 * The canary split on 2026-09-23 is the case these guard. Rewriting
 * `picked_up_from` alone routed reports to the new project while the card,
 * the roster and the thread binding stayed in the old one, because those are
 * folds over the old coordinator's log. So each case checks both sides: where
 * delivery goes, and what each project's own fold now says.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawEvent } from '../../src/session-history/types.js';

const storedEvents = new Map<string, RawEvent[]>();
let nextSeq = 0;
function store(sessionId: string, type: string, data: unknown) {
  nextSeq += 1;
  const event = { conversationId: sessionId, sessionId, seq: nextSeq, runId: 'run', timestamp: nextSeq, type, data, meta: null };
  storedEvents.set(sessionId, [...(storedEvents.get(sessionId) ?? []), event as unknown as RawEvent]);
  return event;
}

vi.mock('../../src/harness/setup.js', () => ({ getHarnessSessionManager: () => ({}) }));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_manager: unknown, sessionId: string, type: string, data: unknown) => store(sessionId, type, data),
}));
vi.mock('../../src/session-history/repository.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEvents: (conversationId: string) => storedEvents.get(conversationId) ?? [],
}));
let runtime = 'idle';
vi.mock('../../src/services/sessions/worker-runtime.js', () => ({ readWorkerRuntime: () => runtime }));

const { DatabaseProvider } = await import('../../src/services/infrastructure/database-provider.js');
const { SessionInfoService } = await import('../../src/services/sessions/session-info-service.js');
const { ConversationService } = await import('../../src/services/sessions/conversation-service.js');
const { appendProjectNote, readProjectState } = await import('../../src/services/sessions/project-state.js');
const { appendWorkerEvent, readWorkerHistory, readWorkerStates } = await import('../../src/services/sessions/worker-events.js');
const { enqueueInboxItem } = await import('../../src/services/sessions/session-inbox.js');
const { moveThread, moveWorker, ProjectMoveError } = await import('../../src/services/sessions/project-move.js');
const { WORKER_REPORT_SUMMARY_EVENT } = await import('../../src/types/worker-events.js');

let canary: string;
let batch: string;

function coordinator(): string {
  return ConversationService.getInstance().createConversation({
    workingDirectory: '/tmp', provider: 'claude', providerSessionId: `p-${Math.random()}`, coordinator: true,
  }).conversationId;
}

function worker(parent: string, task: string, thread?: number): string {
  const id = ConversationService.getInstance().createConversation({
    workingDirectory: '/tmp', provider: 'claude', providerSessionId: `p-${Math.random()}`, pickedUpFrom: parent,
  }).conversationId;
  appendWorkerEvent(parent, 'worker:started', { worker: id, provider: 'claude', model: 'claude-opus-5-5', task, ...(thread !== undefined ? { thread } : {}) });
  return id;
}

const pickedUpFrom = (id: string) => ConversationService.getInstance().getConversation(id)?.pickedUpFrom;

beforeEach(async () => {
  storedEvents.clear();
  nextSeq = 0;
  runtime = 'idle';
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  canary = coordinator();
  batch = coordinator();
  appendProjectNote(canary, { kind: 'outcome', text: 'Canary reports flag known-bad strategies', by: 'coordinator' });
  appendProjectNote(batch, { kind: 'outcome', text: 'Batch monitoring keeps up', by: 'coordinator' });
});
afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('move-worker', () => {
  it('moves the card, the delivery and the unaccounted report, and leaves the old project owing nothing', async () => {
    const gnaw = worker(canary, 'Get batch monitoring keeping up');
    const report = appendWorkerEvent(canary, 'worker:reported', { worker: gnaw, model: 'claude-opus-5-5', text: 'Backlog is 20.5k tasks.' })!;
    store(canary, WORKER_REPORT_SUMMARY_EVENT, { worker: gnaw, reportSeq: report.seq, title: 'Backlog measured', text: '20.5k tasks', model: 'm' });

    const moved = await moveWorker({ worker: gnaw, from: canary, to: batch });

    expect(pickedUpFrom(gnaw)).toBe(batch);
    expect(readWorkerStates(canary)).toEqual([]);
    expect(readProjectState(canary).attention).toEqual([]);
    const [card] = readWorkerStates(batch);
    expect(card).toMatchObject({ worker: gnaw, task: 'Get batch monitoring keeping up', phase: 'reported' });
    const owed = readProjectState(batch).attention;
    expect(owed.map((item) => [item.worker, item.firstLine])).toEqual([[gnaw, 'Backlog is 20.5k tasks.']]);
    expect(moved.copied).toEqual([{ from: report.seq, to: owed[0].seq }]);
    // The card summary follows the copy, so it reads the same in the new thread.
    const summary = storedEvents.get(batch)!.find((event) => event.type === WORKER_REPORT_SUMMARY_EVENT);
    expect((summary?.data as { reportSeq: number }).reportSeq).toBe(owed[0].seq);
    expect(readWorkerHistory(canary).at(-1)?.text).toBe('Moved the worker to Batch monitoring keeps up: Get batch monitoring keeping up');
  });

  it('carries an open question so the new coordinator can answer it by seq', async () => {
    const gnaw = worker(canary, 'Profile the monitor');
    appendProjectNote(canary, { kind: 'accounting', text: 'from here', by: 'coordinator' });
    appendWorkerEvent(canary, 'worker:asked', { worker: gnaw, text: 'Question for front: may I trial 24 concurrent entries?' });
    await moveWorker({ worker: gnaw, from: canary, to: batch });
    const [card] = readWorkerStates(batch);
    expect(card.phase).toBe('asked');
    expect(readProjectState(batch).attention[0].kind).toBe('question');
  });

  it('attaches to a thread in the new project, and says what in the old one still names it', async () => {
    const opened = appendProjectNote(batch, { kind: 'open', text: 'Keep up with arrivals', by: 'coordinator' })!;
    const stays = appendProjectNote(canary, { kind: 'open', text: 'Evening peak check', by: 'coordinator', owner: { kind: 'worker', worker: 'x' } })!;
    const gnaw = worker(canary, 'Get batch monitoring keeping up');
    appendProjectNote(canary, { kind: 'update', text: '', by: 'coordinator', ref: stays, owner: { kind: 'worker', worker: gnaw } });

    const moved = await moveWorker({ worker: gnaw, from: canary, to: batch, thread: opened });

    expect(readWorkerStates(batch)[0].thread).toBe(opened);
    expect(readProjectState(batch).open[0].workers).toEqual([gnaw]);
    expect(moved.warnings).toEqual([`thread [${stays}] in ${canary} still names ${gnaw} as its owner or what it waits on`]);
  });

  it('refuses, changing nothing, when the worker is not the old project\'s or a report is still unread there', async () => {
    const gnaw = worker(canary, 'Get batch monitoring keeping up');
    await expect(moveWorker({ worker: gnaw, from: batch, to: canary })).rejects.toThrow(`reports to ${canary}, not ${batch}`);
    enqueueInboxItem({ sessionId: canary, source: 'worker-report', text: 'Done.', worker: gnaw });
    await expect(moveWorker({ worker: gnaw, from: canary, to: batch })).rejects.toBeInstanceOf(ProjectMoveError);
    expect(pickedUpFrom(gnaw)).toBe(canary);
    expect(readWorkerStates(batch)).toEqual([]);
  });

  it('says whether the worker is mid-turn, which is when the CLI tells it', async () => {
    const gnaw = worker(canary, 'Bump backend dependencies');
    runtime = 'working';
    expect((await moveWorker({ worker: gnaw, from: canary, to: batch })).midTurn).toBe(true);
  });
});

describe('move-thread', () => {
  it('opens the thread again with what it had, closes the old one, and brings its workers and what it is owed', async () => {
    appendProjectNote(canary, { kind: 'accounting', text: 'from here', by: 'coordinator' });
    const thread = appendProjectNote(canary, {
      kind: 'open', text: 'Move monitoring signals out of the event log', by: 'coordinator',
      owner: { kind: 'coordinator' }, nextAction: 'Deploy and check alongside imports',
      waitingOn: { kind: 'worker', text: 'the rollout' }, evidence: ['PR 852'],
    })!;
    appendProjectNote(canary, { kind: 'update', text: 'Infrastructure applied', by: 'coordinator', ref: thread });
    const gnaw = worker(canary, 'Get batch monitoring keeping up', thread);
    const reviewer = worker(canary, 'Review the common PR', thread);
    const other = appendProjectNote(canary, { kind: 'open', text: 'Stop canaries closer to the limit', by: 'coordinator', workers: [reviewer] })!;
    appendWorkerEvent(canary, 'worker:reported', { worker: gnaw, model: null, text: 'Rolled out 3.87.0.' });

    const moved = await moveThread({ from: canary, to: batch, thread });

    const [copy] = readProjectState(batch).open;
    expect(copy).toMatchObject({
      seq: moved.newThread,
      text: 'Move monitoring signals out of the event log',
      summary: 'Infrastructure applied',
      owner: { kind: 'coordinator' },
      nextAction: 'Deploy and check alongside imports',
      waitingOn: { kind: 'worker', text: 'the rollout' },
      evidence: ['PR 852', `moved from Canary reports flag known-bad strategies (${canary}) thread [${thread}]`],
    });
    expect(copy.events.map((event) => [event.worker, event.firstLine, event.addressed])).toEqual([[gnaw, 'Rolled out 3.87.0.', false]]);
    expect(readProjectState(batch).attention.map((item) => item.thread)).toEqual([moved.newThread]);

    const old = readProjectState(canary);
    expect(old.open.map((t) => t.seq)).toEqual([other]);
    expect(old.closed.find((t) => t.seq === thread)?.resolution).toBe(`Moved to Batch monitoring keeps up as thread [${moved.newThread}]`);
    expect(old.attention).toEqual([]);

    // The worker carrying only this thread went with it, bound to the new id;
    // the one also carrying another open thread stayed, and the result says so.
    expect(moved.workers.map((result) => result.worker)).toEqual([gnaw]);
    expect(pickedUpFrom(gnaw)).toBe(batch);
    expect(readWorkerStates(batch)[0]).toMatchObject({ worker: gnaw, thread: moved.newThread });
    expect(pickedUpFrom(reviewer)).toBe(canary);
    expect(moved.warnings).toEqual([`${reviewer} also carries another open thread in ${canary}, so it stayed; move it with move-worker if it should go`]);
    // Copied once: the thread brought the report, so the worker's move did not bring it again.
    expect(storedEvents.get(batch)!.filter((event) => event.type === 'worker:reported')).toHaveLength(1);
  });

  it('refuses a closed thread: only open work moves', async () => {
    const thread = appendProjectNote(canary, { kind: 'open', text: 'Done work', by: 'coordinator' })!;
    appendProjectNote(canary, { kind: 'close', text: 'done', by: 'coordinator', ref: thread });
    await expect(moveThread({ from: canary, to: batch, thread })).rejects.toThrow('is closed');
  });
});
