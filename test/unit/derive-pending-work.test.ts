import { describe, it, expect } from 'vitest';
import { derivePendingWork } from '@/harness/derive-pending-work.js';
import { deriveStatus, hasRunningBackgroundTasks } from '@liggi/agent-ui-harness/protocol';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';

let seq = 0;
function event(type: string, data: unknown = {}): SessionEvent {
  seq += 1;
  return {
    sessionId: 'conv-test',
    runId: 'run-1',
    seq,
    timestamp: 1_700_000_000_000 + seq * 1000,
    type,
    data,
  } as SessionEvent;
}

function taskStarted(taskId: string, taskType: string): SessionEvent {
  return event('task:started', { taskId, toolUseId: `tu-${taskId}`, taskType });
}

function taskFinished(taskId: string, status = 'completed'): SessionEvent {
  return event('task:updated', { taskId, patch: { status } });
}

/** A turn that scheduled a wakeup, ending idle. */
function turnWithWakeup(delaySeconds = 600): SessionEvent[] {
  return [
    event('content', {
      blocks: [{
        type: 'tool_use',
        name: 'ScheduleWakeup',
        input: { delaySeconds, prompt: 'keep going', reason: 'polling CI' },
      }],
    }),
    event('turn:end', {}),
  ];
}

describe('derivePendingWork', () => {
  it('returns null for a session that just finished a turn', () => {
    expect(derivePendingWork([event('input:sent', { text: 'hi' }), event('turn:end', {})])).toBeNull();
  });

  it('reports a running background bash command', () => {
    const events = [taskStarted('t1', 'local_bash'), event('turn:end', {})];
    expect(derivePendingWork(events)).toBe('background_task');
  });

  it('reports a running subagent, which deriveBackgroundTasks deliberately ignores', () => {
    const events = [taskStarted('t1', 'local_agent'), event('turn:end', {})];
    expect(derivePendingWork(events)).toBe('subagent');
  });

  it('reports a running workflow', () => {
    const events = [taskStarted('t1', 'local_workflow'), event('turn:end', {})];
    expect(derivePendingWork(events)).toBe('workflow');
  });

  it('treats an unrecognised task type as background work rather than dropping it', () => {
    const events = [taskStarted('t1', 'something_new'), event('turn:end', {})];
    expect(derivePendingWork(events)).toBe('background_task');
  });

  it('clears once the task completes', () => {
    const events = [taskStarted('t1', 'local_bash'), taskFinished('t1'), event('turn:end', {})];
    expect(derivePendingWork(events)).toBeNull();
  });

  it.each(['failed', 'killed'])('treats a %s task as finished, not still running', (status) => {
    const events = [taskStarted('t1', 'local_agent'), taskFinished('t1', status), event('turn:end', {})];
    expect(derivePendingWork(events)).toBeNull();
  });

  it('clears on a task:notification', () => {
    const events = [
      taskStarted('t1', 'local_bash'),
      event('task:notification', { taskId: 't1' }),
      event('turn:end', {}),
    ];
    expect(derivePendingWork(events)).toBeNull();
  });

  it('drops tasks orphaned by a process boundary', () => {
    const events = [taskStarted('t1', 'local_bash'), event('run:end', {}), event('run:start', {})];
    expect(derivePendingWork(events)).toBeNull();
  });

  it('keeps reporting while one of several tasks is still running', () => {
    const events = [
      taskStarted('t1', 'local_bash'),
      taskStarted('t2', 'local_agent'),
      taskFinished('t1'),
      event('turn:end', {}),
    ];
    expect(derivePendingWork(events)).toBe('subagent');
  });

  it('reports a scheduled wakeup when nothing else is outstanding', () => {
    expect(derivePendingWork(turnWithWakeup())).toBe('scheduled_wakeup');
  });

  it('prefers outstanding tasks over a scheduled wakeup', () => {
    const events = [taskStarted('t1', 'local_bash'), ...turnWithWakeup()];
    expect(derivePendingWork(events)).toBe('background_task');
  });

  it('returns null for an empty log', () => {
    expect(derivePendingWork([])).toBeNull();
  });
});

/**
 * The composer picks between Working, "Waiting for …" and Ready from three
 * signals. A backgrounded subagent switches off the first two, so this is the
 * shape where pendingWork is the only thing standing between a live subagent
 * and a status bar claiming Ready.
 *
 * Sequenced after a real session log: the
 * Agent tool_use and its immediate tool_result, turn:end, then child events
 * carrying the parent's tool_use id while the agent keeps working.
 */
describe('composer status inputs for a backgrounded subagent', () => {
  const PARENT = 'toolu_bg';

  function backgroundedSubagentLog(): SessionEvent[] {
    return [
      event('run:start', {}),
      event('input:sent', { text: 'mine those sessions in the background' }),
      event('run:ready', {}),
      event('content', { blocks: [{ type: 'tool_use', id: PARENT, name: 'Agent' }] }),
      taskStarted('a66232a64', 'local_agent'),
      event('result', { blocks: [{ type: 'tool_result', tool_use_id: PARENT }] }),
      event('turn:end', {}),
      event('content', { blocks: [{ type: 'text', text: 'reading' }], parentToolUseId: PARENT }),
      event('result', { blocks: [{ type: 'tool_result', tool_use_id: 'tu-inner' }], parentToolUseId: PARENT }),
    ];
  }

  it('reads as idle — the user\'s turn really did end', () => {
    expect(deriveStatus(backgroundedSubagentLog())).toBe('idle');
  });

  it('is invisible to hasRunningBackgroundTasks, which counts bash tasks only', () => {
    expect(hasRunningBackgroundTasks(backgroundedSubagentLog())).toBe(false);
  });

  it('is still reported as pending work, so the composer says Waiting and not Ready', () => {
    expect(derivePendingWork(backgroundedSubagentLog())).toBe('subagent');
  });

  it('goes quiet once the subagent finishes', () => {
    const events = [...backgroundedSubagentLog(), taskFinished('a66232a64')];
    expect(derivePendingWork(events)).toBeNull();
    expect(deriveStatus(events)).toBe('idle');
  });
});
