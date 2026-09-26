import { describe, expect, it } from 'vitest';
import { foldWorkerHistory, foldWorkerStates, type WorkerEventLike } from '../../src/types/worker-events.js';

/**
 * A worker is named by the task its coordinator dispatched it on, and a
 * coordinator that reuses an idle worker for something else used to leave that
 * name describing work that had finished, which confused the project view.
 * The
 * coordinator now says so on the send, and `worker:reassigned` is the record.
 *
 * The fold is where this has to be right: the card, the CLI roster, the
 * coordinator's restored roster after compaction, the worker's own "what front
 * dispatched you to do" line and the report and activity prompts all read
 * `task` from here, so one case covers every naming surface but attribution,
 * which reads the events directly (`sender-identity.ts`).
 */
const at = (minute: number) => Date.UTC(2026, 8, 22, 15, minute);
const ev = (type: string, minute: number, data: unknown): WorkerEventLike => ({ type, timestamp: at(minute), data });

const dispatch = ev('worker:started', 10, {
  worker: 'conv-w', provider: 'claude', model: 'claude-opus-5', thread: 7, task: 'Prepare a canary report preview',
});

const only = (events: WorkerEventLike[]) => foldWorkerStates(events)[0];

describe('a worker its coordinator moves on to something else', () => {
  it('is called what it is doing now', () => {
    const state = only([
      dispatch,
      ev('worker:reported', 20, { worker: 'conv-w', model: 'claude-opus-5', text: 'Preview is live.' }),
      ev('worker:reassigned', 30, { worker: 'conv-w', task: 'Fix worker status display', previousTask: 'Prepare a canary report preview' }),
      ev('worker:answered', 30, { worker: 'conv-w', text: 'Here is the brief.', summary: null, question: null, passedOn: false }),
    ]);
    expect(state.task).toBe('Fix worker status display');
  });

  it('keeps the name when the coordinator sends an ordinary follow-up', () => {
    // No --task, so no event: the worker is still on the task it was given.
    const state = only([
      dispatch,
      ev('worker:answered', 30, { worker: 'conv-w', text: 'One correction.', summary: null, question: null, passedOn: false }),
    ]);
    expect(state.task).toBe('Prepare a canary report preview');
  });

  it('renames and nothing else: the rest of the card belongs to events that meant it', () => {
    const asked = ev('worker:asked', 20, { worker: 'conv-w', text: 'Question for front: which chart?' });
    const before = only([dispatch, asked]);
    const after = only([dispatch, asked, ev('worker:reassigned', 30, { worker: 'conv-w', task: 'Something else', previousTask: 'Prepare a canary report preview' })]);

    // An open question survives a rename. Discharging it here would be the
    // loophole `--answers` exists to close.
    expect(after.phase).toBe('asked');
    expect(after.question).toBe(before.question);
    expect(after.since).toBe(before.since);
    expect(after.startedAt).toBe(at(10));
    expect(after.thread).toBe(7);
  });

  it('does not invent a card for a worker that was never dispatched', () => {
    expect(foldWorkerStates([ev('worker:reassigned', 30, { worker: 'conv-ghost', task: 'Something', previousTask: '' })])).toEqual([]);
  });

  it('leaves the original dispatch and its reports standing in the history', () => {
    const history = foldWorkerHistory([
      dispatch,
      ev('worker:reported', 20, { worker: 'conv-w', model: 'claude-opus-5', text: 'Preview is live.' }),
      ev('worker:reassigned', 30, { worker: 'conv-w', task: 'Fix worker status display', previousTask: 'Prepare a canary report preview' }),
    ]);
    expect(history).toEqual([
      { tag: 'dispatch', worker: 'conv-w', text: 'Started a Claude worker: Prepare a canary report preview', at: at(10) },
      { tag: 'report', worker: 'conv-w', text: 'Worker reported: Preview is live.', at: at(20) },
      { tag: 'reassign', worker: 'conv-w', text: 'Moved the worker on to: Fix worker status display', at: at(30) },
    ]);
  });
});
