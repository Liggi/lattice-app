import { describe, expect, it } from 'vitest';
import { foldWorkerHistory, type WorkerEventLike } from '../../src/types/worker-events.js';

const at = (minute: number) => Date.UTC(2026, 8, 19, 15, minute);
const ev = (type: string, minute: number, data: unknown): WorkerEventLike => ({ type, timestamp: at(minute), data });

describe('foldWorkerHistory', () => {
  it('turns the worker events into one line per move, oldest first, ignoring everything else', () => {
    const events = [
      ev('input:sent', 30, { text: 'hi' }),
      ev('worker:started', 34, { worker: 'conv-w', provider: 'claude', model: 'claude-opus-5', task: 'Fix the four monitoring PRs' }),
      ev('worker:asked', 38, { worker: 'conv-w', text: 'Question for front: is historical backfill in scope?\n\nI would default to no.' }),
      ev('worker:answered', 40, { worker: 'conv-w', text: 'Out of scope.', summary: 'backfill is out of scope for this PR', question: 'is historical backfill in scope?', passedOn: false }),
      ev('worker:answered', 46, { worker: 'conv-w', text: 'The user says skip and log.\nMore detail.', summary: null, question: null, passedOn: true }),
      ev('worker:reported', 52, { worker: 'conv-w', model: 'claude-opus-5', text: '**Batch monitoring #852** — changes requested.\n\nDetails follow.' }),
      ev('worker:reported', 53, { text: 'no worker id' }),
    ];
    expect(foldWorkerHistory(events)).toEqual([
      { tag: 'dispatch', worker: 'conv-w', text: 'Started a Claude worker: Fix the four monitoring PRs', at: at(34) },
      { tag: 'question', worker: 'conv-w', text: 'Worker asked: is historical backfill in scope?', at: at(38) },
      { tag: 'answer', worker: 'conv-w', text: 'Told the worker: backfill is out of scope for this PR', at: at(40) },
      { tag: 'relay', worker: 'conv-w', text: 'Passed on to the worker: The user says skip and log.', at: at(46) },
      { tag: 'report', worker: 'conv-w', text: 'Worker reported: **Batch monitoring #852** — changes requested.', at: at(52) },
    ]);
  });
});
