import { describe, expect, it } from 'vitest';
import { workerResumedAfterReport, workerRuntimeWord, type WorkerCardState } from '../../src/types/worker-events';
import { workerStateLine } from '../../src/web/chat/components/InsightsPanel/WorkersSection';

/**
 * `phase` is folded from the coordinator's log, which has no event for a
 * process ending: a worker that is stopped or exits part-way stays `working`
 * there for good. On 2026-09-21 four cards across two projects read Working
 * with every process dead since 12:30:22 and no report from any of them.
 *
 * Liveness on its own does not fix it. Stopping a worker leaves its process
 * up and idle, so "is the process alive" still answers yes for a worker that
 * is doing nothing — which is why the card follows `runtime`, the same
 * `deriveStatus` answer the rest of the server uses.
 */
const working: WorkerCardState = {
  worker: 'conv-worker',
  provider: 'claude',
  model: 'claude-opus-5',
  task: 'Verifying queued message identity',
  startedAt: 1000,
  phase: 'working',
  question: null,
  since: 2000,
  contextTokens: null,
  archived: false,
  reportReached: false,
  activity: null,
  runtime: 'working',
  queued: false,
};

const line = (over: Partial<WorkerCardState>) => workerStateLine({ ...working, ...over }, false).state;

describe('a worker card tells the truth about whether work is happening', () => {
  it('says Working while a turn is in progress', () => {
    expect(line({ runtime: 'working' })).toBe('Working');
    expect(line({ runtime: 'starting' })).toBe('Working');
  });

  it('says Stopped once the process has exited, not Working at a dead session', () => {
    expect(line({ runtime: 'exited' })).toBe('Stopped');
  });

  it('says Stopped for an explicit stop, which leaves the process alive but idle', () => {
    // The case that a liveness-only check gets wrong: stopping a worker keeps
    // its process, so `processAlive` stays true while nothing is happening.
    expect(line({ runtime: 'idle' })).toBe('Stopped');
  });

  it('says Queued when it is idle but has something waiting to pick up', () => {
    expect(line({ runtime: 'idle', queued: true })).toBe('Queued');
    expect(line({ runtime: 'exited', queued: true })).toBe('Queued');
  });

  it('says Stopping while a requested stop is still winding down', () => {
    expect(line({ runtime: 'stopping' })).toBe('Stopping');
  });

  it('never calls an unfinished worker Reported, whatever the runtime', () => {
    for (const runtime of ['idle', 'exited', 'stopping', 'unknown'] as const) {
      expect(line({ runtime })).not.toBe('Reported');
    }
  });

  it('does not raise an escalation signal, which stays reserved', () => {
    expect(workerStateLine({ ...working, runtime: 'exited' }, false).needsYou).toBe(false);
  });

  it('does not claim Stopped when the runtime could not be asked', () => {
    // 'unknown' is an unavailable harness, not a dead worker.
    expect(line({ runtime: 'unknown' })).toBe('Working');
  });

  it('does not claim Stopped when the server predates the field', () => {
    // The frontend hot-reloads ahead of the server in development, so the
    // field is briefly absent. Reading absent as dead would put Stopped on
    // every live worker until the restart caught up.
    const { runtime: _runtime, ...withoutField } = working;
    expect(workerStateLine(withoutField as WorkerCardState, false).state).toBe('Working');
  });

  it('still reports a worker whose turn ended with a report and stopped there', () => {
    expect(line({ phase: 'reported', runtime: 'exited' })).toBe('Reported');
    expect(line({ phase: 'reported', runtime: 'idle' })).toBe('Reported');
  });

  it('says Working for a reported worker that has been started up again', () => {
    // A worker reported, was resumed, and
    // the card still read Reported with a turn in progress. Nothing about a
    // restart reaches the coordinator's log, so `phase` cannot see it.
    expect(line({ phase: 'reported', runtime: 'working' })).toBe('Working');
    expect(line({ phase: 'reported', runtime: 'starting' })).toBe('Working');
    expect(line({ phase: 'reported', runtime: 'stopping' })).toBe('Stopping');
    expect(line({ phase: 'reported', runtime: 'idle', queued: true })).toBe('Queued');
  });

  it('does not unreport a worker when the runtime could not be asked', () => {
    // `unknown` and an absent field are both "no answer", and treating either
    // as a running worker would take Reported off every card the moment the
    // harness went away.
    expect(line({ phase: 'reported', runtime: 'unknown' })).toBe('Reported');
    const { runtime: _runtime, ...withoutField } = { ...working, phase: 'reported' as const };
    expect(workerStateLine(withoutField as WorkerCardState, false).state).toBe('Reported');
  });

  it('leaves an archived worker archived, whatever the runtime says', () => {
    expect(line({ archived: true, runtime: 'exited' })).toBe('Archived');
  });
});

/**
 * The CLI roster renders the same worker from the same endpoint through its
 * own code. Correcting only the panel left `lattice session workers` printing
 * the literal word "working" for an exited process, because the endpoint stops
 * serving an activity phrase once a worker is not working and the fallback was
 * doing all the work. These pin the two windows to one answer.
 */
describe('the roster and the card agree about the same worker', () => {
  it('gives a stopped worker the same word in both', () => {
    expect(workerRuntimeWord({ runtime: 'exited', queued: false })).toBe('Stopped');
    expect(workerStateLine({ ...working, runtime: 'exited' }, false).state).toBe('Stopped');
  });

  it('does not fall back to Working for a process that has gone', () => {
    // The exact CLI expression, which used to be `worker.activity ?? 'working'`.
    const dead = { runtime: 'exited', queued: false, activity: null } as const;
    expect(dead.activity ?? workerRuntimeWord(dead).toLowerCase()).toBe('stopped');
  });

  it('keeps a live worker activity phrase, which the roster prefers', () => {
    const live = { runtime: 'working', queued: false, activity: 'Testing the composer' } as const;
    expect(live.activity ?? workerRuntimeWord(live).toLowerCase()).toBe('Testing the composer');
  });

  it('still says Working when the server predates the field, in both windows', () => {
    expect(workerRuntimeWord({ runtime: undefined, queued: undefined })).toBe('Working');
  });

  it('gives a resumed reported worker the runtime word in both', () => {
    // The exact CLI expression: the `reported` branch is skipped, so the
    // roster lands on the same word the panel shows.
    const resumed = { phase: 'reported', runtime: 'working', queued: false, activity: null } as const;
    expect(workerResumedAfterReport(resumed)).toBe(true);
    expect(resumed.activity ?? workerRuntimeWord(resumed).toLowerCase()).toBe('working');
    expect(workerStateLine({ ...working, ...resumed }, false).state).toBe('Working');
  });
});
