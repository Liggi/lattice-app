import { describe, expect, it } from 'vitest';
import type { WorkerCardState } from '../../src/types/worker-events';
import { workerStateLine } from '../../src/web/chat/components/InsightsPanel/WorkersSection';

const question: WorkerCardState = {
  worker: 'conv-worker',
  provider: 'codex',
  model: 'gpt-6-astra',
  task: 'Check which files need updating',
  startedAt: 1000,
  phase: 'asked',
  question: 'Question for front: Should the existing export format be preserved?',
  since: 2000,
  contextTokens: null,
  archived: false,
  reportReached: false,
};

describe('worker questions require explicit escalation to the user', () => {
  it('keeps an undelivered question waiting for the coordinator even when it is idle', () => {
    const line = workerStateLine(question, false);
    expect(line.state).toBe('Waiting for coordinator');
    expect(line.needsYou).toBe(false);
  });

  it('does not treat an idle coordinator as evidence that a delivered question was escalated', () => {
    const line = workerStateLine({ ...question, reportReached: true }, false);
    expect(line.needsYou).toBe(false);
    expect(line.state).not.toBe('Needs you');
    expect(line.state).toBe('Question pending');
  });
});
