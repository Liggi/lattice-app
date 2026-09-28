/**
 * The panel's to-do list sorts a coordinator's threads into Needs you, In
 * progress and Next from what is already recorded (owner, wait, live
 * workers), orders each part by the user's rank, and folds the workers in.
 * These pin that sorting and the fold behind it: a label, a rank that forgets
 * closed threads, and a park that remembers it was the user's call.
 */

import { describe, expect, it } from 'vitest';
import { foldProjectState, PROJECT_NOTED_EVENT, type ProjectEventLike, type ProjectNotedData } from '../../src/types/project-state.js';
import { deriveStateOfPlay } from '../../src/types/state-of-play.js';
import type { WorkerCardState } from '../../src/types/worker-events.js';

let seq = 0;
function note(data: Partial<ProjectNotedData>): ProjectEventLike {
  seq += 1;
  return { seq, type: PROJECT_NOTED_EVENT, timestamp: seq, data: { text: '', by: 'coordinator', ...data } };
}

function worker(id: string, thread: number | null, overrides: Partial<WorkerCardState> = {}): WorkerCardState {
  return {
    worker: id, provider: 'claude', model: null, task: `task of ${id}`, thread, startedAt: 0, phase: 'working',
    question: null, since: 0, contextTokens: null, archived: false, reportReached: false, runtime: 'working', activity: null,
    ...overrides,
  };
}

describe('deriveStateOfPlay', () => {
  seq = 0;
  const events = [
    note({ kind: 'open', text: 'Publish the release', owner: { kind: 'user' }, label: 'Publish 0.4.1?' }), // 1
    note({ kind: 'open', text: 'Panel restyle', owner: { kind: 'worker', worker: 'conv-a' }, workers: ['conv-a'] }), // 2
    note({ kind: 'open', text: 'A tester tries it', owner: { kind: 'external', who: 'Sam' } }), // 3
    note({ kind: 'open', text: 'Queued idea', owner: { kind: 'coordinator' } }), // 4
    note({ kind: 'open', text: 'Waits on the usage window', owner: { kind: 'coordinator' }, waitingOn: { kind: 'resource', text: 'the usage window' } }), // 5
    note({ kind: 'open', text: 'Choose a name', owner: { kind: 'coordinator' }, waitingOn: { kind: 'decision', text: 'Jason picking' } }), // 6
    note({ kind: 'open', text: 'Dismissed work', owner: { kind: 'worker', worker: 'conv-d' }, workers: ['conv-d'] }), // 7
    note({ kind: 'park', text: 'Jason dismissed it', by: 'user', ref: 7 }), // 8
    note({ kind: 'open', text: 'Owned by a reused worker', owner: { kind: 'worker', worker: 'conv-reused' } }), // 9
  ];
  const project = foldProjectState(events);
  const workers = [worker('conv-a', 2), worker('conv-loose', null), worker('conv-d', 7), worker('conv-gone', 2, { archived: true }), worker('conv-reused', 99)];
  const play = deriveStateOfPlay(project, workers);

  it('puts the user\'s moves under Needs you: owned by them, or waiting on a decision', () => {
    expect(play.needsYou.map((item) => item.label)).toEqual(['Publish 0.4.1?', 'Choose a name']);
  });

  it('lists every live worker by its task, and not the threads they carry', () => {
    expect(play.workers.map((w) => w.worker)).toEqual(['conv-a', 'conv-loose', 'conv-reused']);
    expect([...play.inProgress, ...play.next].map((item) => item.label)).not.toContain('Panel restyle');
  });

  it('puts held threads nobody is on under In progress', () => {
    expect(play.inProgress.map((item) => item.label)).toEqual(['A tester tries it', 'Waits on the usage window']);
    expect(play.inProgress[0].heldOn).toBe('Sam');
  });

  it('lists a worker sent on to other work while its thread waits on the user, and does not count it on that thread', () => {
    const sentOn = worker('conv-sent-on', null, { task: 'Activity log for the detector', movedOn: true });
    const withIt = foldProjectState([...events, note({ kind: 'update', ref: 6, text: 'still deciding', workers: ['conv-sent-on'] })]);
    expect(withIt.open.find((thread) => thread.seq === 6)?.workers).toContain('conv-sent-on');
    const moved = deriveStateOfPlay(withIt, [...workers, sentOn]);
    expect(moved.workers.map((w) => w.task)).toContain('Activity log for the detector');
    expect(moved.needsYou.find((item) => item.label === 'Choose a name')?.workers).toEqual([]);
  });

  it('leaves open work nobody has started under Next', () => {
    expect(play.next.map((item) => item.label)).toEqual(['Queued idea']);
  });

  it('lists a parked thread apart, and not the worker that was stopped with it', () => {
    expect(play.parked.map((item) => item.label)).toEqual(['Dismissed work']);
    expect(play.workers.map((w) => w.worker)).not.toContain('conv-d');
    expect(project.open.find((thread) => thread.seq === 7)?.parked?.by).toBe('user');
  });

  it('orders each part by the rank, with unranked threads after in the order they opened', () => {
    const ranked = foldProjectState([...events, note({ kind: 'rank', order: [6, 5] })]);
    const order = deriveStateOfPlay(ranked, workers);
    expect(order.needsYou.map((item) => item.label)).toEqual(['Choose a name', 'Publish 0.4.1?']);
    expect(order.inProgress.map((item) => item.label)).toEqual(['Waits on the usage window', 'A tester tries it']);
  });
});

describe('the fold behind it', () => {
  it('keeps the latest label and drops closed threads from the rank', () => {
    seq = 0;
    const state = foldProjectState([
      note({ kind: 'open', text: 'One', label: 'first label' }), // 1
      note({ kind: 'open', text: 'Two' }), // 2
      note({ kind: 'update', text: '', ref: 1, label: 'second label' }), // 3
      note({ kind: 'rank', order: [2, 1] }), // 4
      note({ kind: 'close', text: 'done', ref: 2 }), // 5
    ]);
    expect(state.open[0].label).toBe('second label');
    expect(state.open.find((thread) => thread.seq === 1)).toBeTruthy();
    expect(state.rank).toEqual([1]);
  });
});
