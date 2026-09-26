import { describe, expect, it } from 'vitest';
import { foldWorkerStates, workerWaitPhrase, workerWaitingOn, type WorkerCardState, type WorkerEventLike } from '../../src/types/worker-events';
import { workerStateLine } from '../../src/web/chat/components/InsightsPanel/WorkersSection';
import { markWorkedSinceReport } from '../../src/services/sessions/worker-events';

/**
 * A worker that stops to wait on something other than the coordinator says so
 * on its report's first line. On 2026-09-23 three workers waiting on a restart
 * read Reported for hours, which looks finished.
 */
const started: WorkerEventLike = {
  type: 'worker:started',
  timestamp: 1000,
  data: { worker: 'conv-w', provider: 'claude', model: null, task: 'Fix the stall' },
};
const report = (text: string, timestamp = 2000): WorkerEventLike => ({
  type: 'worker:reported',
  timestamp,
  data: { worker: 'conv-w', model: null, text },
});

function card(events: WorkerEventLike[], over: Partial<WorkerCardState> = {}): WorkerCardState {
  const [state] = foldWorkerStates([started, ...events]);
  return { ...state, contextTokens: null, archived: false, reportReached: true, activity: null, runtime: 'idle', queued: false, ...over };
}

describe('a worker waiting on something shows the wait', () => {
  it('reads the phrase from the marker line, with markdown and on the next line', () => {
    expect(workerWaitPhrase('Waiting on: the next quiet restart.\n\nFix is built.')).toBe('the next quiet restart');
    expect(workerWaitPhrase('**Waiting on:** conv-X\'s file list')).toBe('conv-X\'s file list');
    expect(workerWaitPhrase('Waiting on:\nthe release runner')).toBe('the release runner');
  });

  it('is not a wait without the marker as the first line', () => {
    expect(workerWaitPhrase('Fix is built.\nWaiting on: the restart')).toBeNull();
    expect(workerWaitPhrase('Waiting on the restart, then done.')).toBeNull();
    expect(workerWaitPhrase('Waiting on:')).toBeNull();
    // A worker saying it is not waiting; the card read "Waiting on nothing".
    expect(workerWaitPhrase('Waiting on: nothing.\n\nDone.')).toBeNull();
    expect(workerWaitPhrase('Waiting on: none — all shipped')).toBeNull();
    expect(workerWaitPhrase('Waiting on: nothing-burger CI')).toBe('nothing-burger CI');
  });

  it('shows Waiting on in place of Reported, on the card and for the roster', () => {
    const worker = card([report('Waiting on: the next quiet restart\n\nBuilt.')]);
    expect(workerStateLine(worker, false)).toEqual({ state: 'Waiting on the next quiet restart', needsYou: false, waiting: true });
    expect(workerWaitingOn(worker)).toBe('the next quiet restart');
  });

  it('clears when the worker resumes', () => {
    const resumed = card([report('Waiting on: the restart')], { runtime: 'working' });
    expect(workerWaitingOn(resumed)).toBeNull();
    expect(workerStateLine(resumed, false).state).toBe('Working');
  });

  // 2026-09-26: a Monitor firing opened a turn by itself, then a restart
  // carry-on note another. Neither wrote to the coordinator's log, and once
  // the worker was between turns the roster read the old wait again.
  it('stays cleared after a resumed turn ends, whatever started it', () => {
    const [state] = markWorkedSinceReport(
      foldWorkerStates([started, report('Waiting on: Alex approving the publish')]),
      (worker, since) => worker === 'conv-w' && since === 2000,
    );
    expect(state.workedSinceReport).toBe(true);
    const idle = { ...state, contextTokens: null, archived: false, reportReached: true, activity: null, runtime: 'idle' as const, queued: false };
    expect(workerWaitingOn(idle)).toBeNull();
    expect(workerStateLine(idle, false).state).toBe('Reported');
  });

  it('holds while the worker has done nothing since the report', () => {
    const [state] = markWorkedSinceReport(foldWorkerStates([started, report('Waiting on: CI')]), () => false);
    expect(workerWaitingOn({ ...state, runtime: 'idle', queued: false })).toBe('CI');
  });

  it('clears when it reports again without a wait', () => {
    const worker = card([report('Waiting on: the restart'), report('Restarted and verified.', 3000)]);
    expect(workerStateLine(worker, false).state).toBe('Reported');
  });

  it('clears when it is sent new work', () => {
    const worker = card([report('Waiting on: the restart'), { type: 'worker:answered', timestamp: 3000, data: { worker: 'conv-w' } }]);
    expect(worker.waitingOn).toBeNull();
    expect(workerStateLine(worker, false).state).toBe('Stopped');
  });
});
