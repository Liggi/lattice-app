import { describe, expect, it } from 'vitest';
import { deriveTrack } from '../../src/web/chat/components/InsightsPanel/project-track';
import type { ProjectClosedThread, ProjectOpenThread, ProjectState } from '../../src/types/project-state';
import type { WorkerCardState } from '../../src/types/worker-events';

function openThread(seq: number, name: string, overrides: Partial<ProjectOpenThread> = {}): ProjectOpenThread {
  return {
    seq,
    text: name,
    name,
    label: null,
    summary: null,
    evidence: null,
    owner: { kind: 'coordinator' },
    next: null,
    waitingOn: null,
    ask: null,
    parked: null,
    workers: [],
    createdAt: seq * 1000,
    updatedAt: seq * 1000,
    ...overrides,
  } as ProjectOpenThread;
}

function closedThread(seq: number, name: string, closedAt = seq * 1000): ProjectClosedThread {
  return {
    seq,
    text: name,
    name,
    label: null,
    closedAt,
    updatedAt: closedAt,
    with: 'done',
  } as ProjectClosedThread;
}

function worker(id: string, thread: number, phase: WorkerCardState['phase'], archived = false): WorkerCardState {
  return {
    worker: id,
    thread,
    phase,
    archived,
    movedOn: false,
    task: id,
  } as WorkerCardState;
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    outcome: null,
    story: null,
    decisions: [],
    retired: [],
    priority: null,
    rank: [],
    open: [],
    closed: [],
    attention: [],
    historical: [],
    accountingFrom: null,
    now: null,
    answeredBefore: null,
    nudges: 0,
    revision: 0,
    ...overrides,
  };
}

describe('deriveTrack', () => {
  it('orders steps monotonically done -> progress -> waiting -> todo and keeps reported worker threads in progress', () => {
    const steps = deriveTrack(
      project({
        closed: [
          closedThread(1, 'Older fix', 100),
          closedThread(2, 'Safety policy', 200),
          closedThread(3, 'Clipped summary', 300),
        ],
        open: [
          openThread(5, 'Queued follow-up'),
          openThread(10, 'Waiting on promotion', { waitingOn: { kind: 'dependency', text: 'deploy' } }),
          openThread(20, 'Interrupted canary', { owner: { kind: 'worker', worker: 'w1' } }),
          openThread(30, 'Refused second Run', { owner: { kind: 'worker', worker: 'w2' } }),
          openThread(40, 'Offline Eval declutter', { owner: { kind: 'worker', worker: 'w3' } }),
        ],
      }),
      [
        worker('w1', 20, 'reported'),
        worker('w2', 30, 'reported'),
        worker('w3', 40, 'working'),
      ],
    );

    expect(steps.map((s) => `${s.state}:${s.label}`)).toEqual([
      'done:Safety policy',
      'done:Clipped summary',
      'progress:Interrupted canary',
      'progress:Refused second Run',
      'progress:Offline Eval declutter',
      'waiting:Waiting on promotion',
      'todo:Queued follow-up',
    ]);
  });

  it('drops closed steps whose name matches an active open thread and respects priority ordering', () => {
    const steps = deriveTrack(
      project({
        priority: { text: 'Fix tracing', thread: 20, at: 1000 },
        closed: [
          closedThread(1, 'Sentry dev tracing', 100),
          closedThread(2, 'Push rollout', 200),
        ],
        open: [
          openThread(10, 'First step', { owner: { kind: 'worker', worker: 'w1' } }),
          openThread(20, 'Sentry dev tracing', { owner: { kind: 'worker', worker: 'w2' } }),
        ],
      }),
      [
        worker('w1', 10, 'reported'),
        worker('w2', 20, 'working'),
      ],
    );

    expect(steps.map((s) => `${s.state}:${s.label}`)).toEqual([
      'done:Push rollout',
      'progress:Sentry dev tracing',
      'progress:First step',
    ]);
  });

  it('returns empty when no unparked named open threads exist', () => {
    expect(deriveTrack(project({ closed: [closedThread(1, 'Done thing')] }), [])).toEqual([]);
  });

  it('shows a worker-owned thread that waits on a dependency no live worker carries as waiting', () => {
    const steps = deriveTrack(
      project({
        open: [
          openThread(273, 'Fleet tasks waiting on you', {
            owner: { kind: 'worker', worker: 'conv-coordinator' },
            waitingOn: { kind: 'dependency', text: 'Fleet answers' },
          }),
          openThread(274, 'Held on a live worker', {
            owner: { kind: 'worker', worker: 'w9' },
            waitingOn: { kind: 'worker', text: 'w9 finishing', worker: 'w9' },
          }),
          openThread(275, 'Held on an archived worker', {
            owner: { kind: 'worker', worker: 'w8' },
            waitingOn: { kind: 'worker', text: 'w8 finishing', worker: 'w8' },
          }),
        ],
      }),
      [worker('w9', 999, 'working'), worker('w8', 998, 'reported', true)],
    );

    expect(steps.map((s) => `${s.state}:${s.label}`)).toEqual([
      'progress:Held on a live worker',
      'waiting:Fleet tasks waiting on you',
      'waiting:Held on an archived worker',
    ]);
  });
});
