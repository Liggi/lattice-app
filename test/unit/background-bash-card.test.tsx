// @vitest-environment happy-dom

/**
 * The card for a background command. It used to decide the command was done
 * only when its output file stopped growing at a non-zero size, and Lattice
 * never gave it a way to read that file, so every background card kept
 * spinning on "Waiting for output…" — whether the command finished, finished
 * silently, or was lost with its process. Its state now comes from the
 * session's task events.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BashTool } from '@liggi/agent-ui-toolkit';
import { deriveBackgroundTaskStates, type SessionEvent } from '@liggi/agent-ui-harness/protocol';

afterEach(cleanup);

function events(list: Array<[string, unknown]>): SessionEvent[] {
  return list.map(([type, data], i) => ({ seq: i + 1, runId: 'run-1', timestamp: i, type, data } as SessionEvent));
}

const started = (taskId: string, toolUseId: string): [string, unknown] =>
  ['task:started', { taskId, toolUseId, taskType: 'local_bash', description: 'Sleep' }];

const RESULT = 'Command running in background with ID: b1. Output is being written to: /private/tmp/claude-501/x/tasks/b1.output';
const INPUT = { command: 'sleep 5', run_in_background: true };

describe('background command state', () => {
  it('follows the task events, and a task still running when its process ends is lost', () => {
    const states = deriveBackgroundTaskStates(events([
      ['run:start', {}],
      started('b1', 'tu-silent'),
      started('b2', 'tu-updated'),
      started('b3', 'tu-lost'),
      ['task:updated', { taskId: 'b2', patch: { status: 'running' } }],
      ['task:notification', { taskId: 'b1' }],
      ['task:updated', { taskId: 'b2', patch: { status: 'completed' } }],
      started('b4', 'tu-live'),
      ['turn:end', {}],
    ]));
    expect(states).toEqual({ 'tu-silent': 'finished', 'tu-updated': 'finished', 'tu-lost': 'running', 'tu-live': 'running' });

    const afterLoss = deriveBackgroundTaskStates(events([
      ['run:start', {}],
      started('b1', 'tu-done'),
      ['task:notification', { taskId: 'b1' }],
      started('b3', 'tu-lost'),
      ['run:end', { reason: 'process_lost', code: null, lostTasks: [{ taskId: 'b3', taskType: 'local_bash' }] }],
      // A late notification for a lost task changes nothing.
      ['task:notification', { taskId: 'b3' }],
    ]));
    expect(afterLoss).toEqual({ 'tu-done': 'finished', 'tu-lost': 'lost' });
  });

  it('spins only while running', () => {
    const { container } = render(<BashTool input={INPUT} result={RESULT} backgroundState="running" />);
    expect(screen.getByText('Running in the background…')).toBeTruthy();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows a command that finished without writing anything as finished', async () => {
    const fetchBackgroundOutput = async () => ({ content: '', size: 0, truncated: false });
    const { container } = render(
      <BashTool input={INPUT} result={RESULT} backgroundState="finished" fetchBackgroundOutput={fetchBackgroundOutput} />,
    );
    expect(await screen.findByText('Finished with no output.')).toBeTruthy();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(screen.queryByText('Waiting for output…')).toBeNull();
  });

  it('says a lost command was lost and stops spinning', () => {
    const { container } = render(<BashTool input={INPUT} result={RESULT} backgroundState="lost" />);
    expect(screen.getByText('Lost')).toBeTruthy();
    expect(screen.getByText(/its result will not arrive/)).toBeTruthy();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});
