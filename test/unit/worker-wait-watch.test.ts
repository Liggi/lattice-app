import { describe, expect, it } from 'vitest';
import { classifyWait, unarmedWaitReason, type WaitWatchDeps } from '../../src/services/sessions/wait-watch';
import { archiveReason, type WorkerFacts } from '../../src/services/sessions/worker-auto-archive';
import { emptyProjectState, type ProjectOpenThread, type ProjectState } from '../../src/types/project-state';
import type { WorkerRuntime, WorkerState } from '../../src/types/worker-events';

const COORD = 'conv-front0000';

function waiting(waitingOn: string | null, over: Partial<WorkerState> = {}): WorkerState {
  return {
    worker: 'conv-waiter000', provider: 'claude', model: null, task: 't', thread: null,
    startedAt: 1, phase: 'reported', question: null, since: 2, waitingOn, ...over,
  };
}

/** Every session idle and exited with nothing pending unless listed. */
function deps(live: Record<string, { active?: boolean; pendingWork?: boolean; processAlive?: boolean; queued?: boolean; runtime?: WorkerRuntime }> = {}): WaitWatchDeps {
  return {
    runtime: (id) => live[id]?.runtime ?? 'idle',
    liveness: (id, runtime) => ({ active: (live[id]?.active ?? false) || runtime === 'working', pendingWork: live[id]?.pendingWork ?? false, processAlive: live[id]?.processAlive ?? false }),
    queued: (id) => live[id]?.queued ?? false,
  };
}

describe('what kind of wait a phrase is', () => {
  it('leaves waits on the user, front or a decision to the thread record', () => {
    expect(classifyWait('the user to pick the pricing copy').kind).toBe('exempt');
    expect(classifyWait('front to confirm the scope').kind).toBe('exempt');
    expect(classifyWait('a decision on the fallback').kind).toBe('exempt');
  });
  it('recognises restarts', () => {
    expect(classifyWait('quiet restart onto 08bd1d1').kind).toBe('restart');
  });
  it('recognises another worker, with or without its prefix', () => {
    expect(classifyWait('Eebni84XFym_ to finish the schema', ['conv-Eebni84XFym_'])).toEqual({ kind: 'worker', named: ['conv-Eebni84XFym_'] });
    expect(classifyWait('conv-4hOSFR87a94G landing its fix').named).toEqual(['conv-4hOSFR87a94G']);
  });
  it('treats anything else as the worker\'s own to wake up for', () => {
    expect(classifyWait('first real message to be classified').kind).toBe('self');
    // Eebni84XFym_, 25 Sep: the reason after "so I can" is not what it waits on.
    expect(classifyWait('the first real message to be classified, so I can confirm a NOISE verdict gets stored with its reason').kind).toBe('self');
    expect(classifyWait('#311 merging, so I can rebase #312 onto it and re-check').kind).toBe('self');
  });
});

describe('a waiting worker nothing will wake', () => {
  // Seen in use: the process was killed at idle, and nothing woke it for a day.
  it('flags an exited process', () => {
    expect(unarmedWaitReason(COORD, waiting('first real message to be classified'), [], deps())).toMatch(/process has exited/);
  });
  // 24 Sep 14:23, Canary: waited on a batch run with nothing armed.
  it('flags a live process with nothing pending', () => {
    const reason = unarmedWaitReason(COORD, waiting('the 15:00 UTC batch run'), [], deps({ 'conv-waiter000': { processAlive: true } }));
    expect(reason).toMatch(/no background command, Monitor or ScheduleWakeup/);
  });
  it('leaves a worker with a background task, a queued message or a running turn alone', () => {
    expect(unarmedWaitReason(COORD, waiting('CI'), [], deps({ 'conv-waiter000': { pendingWork: true, processAlive: true } }))).toBeNull();
    expect(unarmedWaitReason(COORD, waiting('CI'), [], deps({ 'conv-waiter000': { queued: true } }))).toBeNull();
    expect(unarmedWaitReason(COORD, waiting('CI'), [], deps({ 'conv-waiter000': { runtime: 'working' } }))).toBeNull();
  });
  it('leaves exempt and restart waits, reports without a wait, and an unknown runtime alone', () => {
    expect(unarmedWaitReason(COORD, waiting('the user to pick one'), [], deps())).toBeNull();
    expect(unarmedWaitReason(COORD, waiting('the next quiet restart'), [], deps())).toBeNull();
    expect(unarmedWaitReason(COORD, waiting(null), [], deps())).toBeNull();
    expect(unarmedWaitReason(COORD, waiting('CI'), [], deps({ 'conv-waiter000': { runtime: 'unknown' } }))).toBeNull();
  });
  it('judges a wait on another worker by that worker', () => {
    const roster = ['conv-waiter000', 'conv-other0000'];
    const state = waiting('other0000 to hand over the fixture');
    expect(unarmedWaitReason(COORD, state, roster, deps({ 'conv-other0000': { runtime: 'working', active: true } }))).toBeNull();
    expect(unarmedWaitReason(COORD, state, roster, deps({ 'conv-other0000': { queued: true } }))).toBeNull();
    expect(unarmedWaitReason(COORD, state, roster, deps())).toMatch(/conv-other0000, which is not running/);
  });
});

function thread(seq: number, workers: string[], closed = false): ProjectOpenThread {
  return {
    seq, at: seq, text: 'x', summary: null, evidence: [], owner: null, nextAction: null, waitingOn: null,
    workers, events: [], updatedAt: seq, ...(closed ? { closedAt: seq + 1 } : {}),
  };
}
function project(over: Partial<ProjectState>): ProjectState {
  return { ...emptyProjectState(), ...over };
}
const facts = (over: Partial<WorkerFacts> = {}): WorkerFacts => ({ archived: false, live: false, latestEventSeq: 50, ...over });

describe('which finished workers are archived', () => {
  const w = 'conv-waiter000';
  it('archives a worker whose threads are all closed', () => {
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({ closed: [thread(10, [w], true)] }))).toBe('threads-closed');
  });
  it('does not archive a worker sent on to other work because the thread it left closed', () => {
    // latestEventSeq null: it has not reported on the new work yet.
    expect(archiveReason(waiting(null, { worker: w, thread: 11, movedOn: true }), facts({ latestEventSeq: null }), project({ open: [thread(11, [])], closed: [thread(10, [w], true)] }))).toBeNull();
  });
  it('archives a worker with no thread whose latest report was dealt with', () => {
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({}))).toBe('report-dealt-with');
  });
  it('archives a dealt-with worker on an open thread it does not own, parked or not', () => {
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({ open: [thread(10, [w])] }))).toBe('report-dealt-with');
    const parked = { ...thread(10, [w]), waitingOn: { kind: 'dependency' as const, text: 'the run after midnight' } };
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({ open: [parked] }))).toBe('report-dealt-with');
    const userOwned = { ...thread(10, [w]), owner: { kind: 'user' as const } };
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({ open: [userOwned] }))).toBe('report-dealt-with');
  });
  it('keeps the worker an open thread names as owner or waits on, even dealt with', () => {
    const owned = { ...thread(10, [w, 'conv-other0000']), owner: { kind: 'worker' as const, worker: w } };
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({ open: [owned] }))).toBeNull();
    expect(archiveReason(waiting(null, { worker: 'conv-other0000' }), facts(), project({ open: [owned] }))).toBe('report-dealt-with');
    // Owner of another open thread than the one it carries (CK3's 9819, owned by 8080's installer).
    const elsewhere = { ...thread(11, []), owner: { kind: 'worker' as const, worker: w } };
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({ open: [thread(10, [w]), elsewhere] }))).toBeNull();
    const waitsOn = { ...thread(10, [w]), waitingOn: { kind: 'worker' as const, text: 'the install', worker: w } };
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({ open: [waitsOn] }))).toBeNull();
  });
  it('keeps a worker on an open thread whose report declared a wait', () => {
    expect(archiveReason(waiting('front to reschedule a PC turn', { worker: w }), facts(), project({ open: [thread(10, [w])] }))).toBeNull();
  });
  it('archives a worker once its last open thread is closed', () => {
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({ closed: [thread(10, [w], true)] }))).toBe('threads-closed');
  });
  it('keeps a worker whose report is still owed a disposition', () => {
    const owed = { seq: 50, at: 50, kind: 'report' as const, worker: w, thread: 10, firstLine: 'x', since: 50 };
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({ attention: [owed] }))).toBeNull();
    expect(archiveReason(waiting(null, { worker: w }), facts(), project({ historical: [owed] }))).toBeNull();
  });
  it('keeps a worker that is waiting, running, asking, or already archived', () => {
    const open = project({});
    expect(archiveReason(waiting('CI', { worker: w }), facts(), open)).toBeNull();
    expect(archiveReason(waiting(null, { worker: w }), facts({ live: true }), open)).toBeNull();
    expect(archiveReason(waiting(null, { worker: w, phase: 'asked' }), facts(), open)).toBeNull();
    expect(archiveReason(waiting(null, { worker: w }), facts({ archived: true }), open)).toBeNull();
  });
  it('keeps an unfinished worker on an open thread', () => {
    expect(archiveReason(waiting(null, { worker: w, phase: 'working' }), facts({ latestEventSeq: null }), project({ open: [thread(10, [w])] }))).toBeNull();
  });
});
