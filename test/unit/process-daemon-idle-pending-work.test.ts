/**
 * The idle timer ends the CLI by closing stdin, and the CLI then kills its
 * background tasks and drops scheduled wakeups. A worker that ended its turn
 * waiting on either was never woken (2026-09-25, output file read `[killed]`
 * five minutes after the turn ended). The timer now waits for that work.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProcessDaemon } from '../../src/process-daemon/process-daemon.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface DaemonInternals {
  processes: Map<string, unknown>;
  idleTimeouts: Map<string, NodeJS.Timeout>;
  handleClaudeMessage: (sid: string, msg: unknown) => void;
  getActiveSessions: () => Array<{ streamingId: string; isIdle: boolean }>;
}

const tasksChanged = (ids: string[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: ids.map((task_id) => ({ task_id, task_type: 'local_bash' })),
});
const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [] };
const scheduleWakeup = (input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ScheduleWakeup', input }] },
});

describe('ProcessDaemon idle timer waits for work the CLI will wake for', () => {
  let internals: DaemonInternals;
  let endStdinCalls: number;
  const sid = 'streaming-bg';

  beforeEach(() => {
    vi.useFakeTimers();
    const daemon = new ProcessDaemon({
      socketPath: `/tmp/test-daemon-${Math.random()}.sock`,
      claudeExecutablePath: '/usr/bin/false',
    });
    internals = daemon as unknown as DaemonInternals;
    endStdinCalls = 0;
    internals.processes.set(sid, {
      type: 'pipe',
      pid: 99999,
      write: () => {},
      kill: () => {},
      endStdin: () => { endStdinCalls += 1; },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not end the process while a background task runs', () => {
    internals.handleClaudeMessage(sid, tasksChanged(['b1']));
    internals.handleClaudeMessage(sid, { type: 'result' });

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 3);
    expect(endStdinCalls).toBe(0);
    expect(internals.getActiveSessions()[0].isIdle).toBe(true);
  });

  it('arms the timer once the tasks end, and the wake-up turn clears it', () => {
    internals.handleClaudeMessage(sid, tasksChanged(['b1']));
    internals.handleClaudeMessage(sid, { type: 'result' });
    internals.handleClaudeMessage(sid, tasksChanged([]));
    expect(internals.idleTimeouts.has(sid)).toBe(true);

    // The CLI starts its own turn to report the task.
    internals.handleClaudeMessage(sid, init);
    expect(internals.idleTimeouts.has(sid)).toBe(false);
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2);
    expect(endStdinCalls).toBe(0);

    internals.handleClaudeMessage(sid, { type: 'result' });
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 100);
    expect(endStdinCalls).toBe(1);
  });

  it('keeps the process past a scheduled wakeup longer than the idle timeout', () => {
    internals.handleClaudeMessage(sid, scheduleWakeup({ delaySeconds: 1200 }));
    internals.handleClaudeMessage(sid, { type: 'result' });

    vi.advanceTimersByTime(1200 * 1000);
    expect(endStdinCalls).toBe(0);
    vi.advanceTimersByTime(60 * 1000 + IDLE_TIMEOUT_MS + 100);
    expect(endStdinCalls).toBe(1);
  });

  it('a stopped wakeup no longer holds the process', () => {
    internals.handleClaudeMessage(sid, scheduleWakeup({ delaySeconds: 1200 }));
    internals.handleClaudeMessage(sid, scheduleWakeup({ stop: true }));
    internals.handleClaudeMessage(sid, { type: 'result' });

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 100);
    expect(endStdinCalls).toBe(1);
  });
});

describe('ProcessDaemon after the idle timer has closed stdin', () => {
  it('refuses writes while the CLI keeps running, instead of sending them into the closed pipe', () => {
    vi.useFakeTimers();
    const daemon = new ProcessDaemon({
      socketPath: `/tmp/test-daemon-${Math.random()}.sock`,
      claudeExecutablePath: '/usr/bin/false',
    });
    const internals = daemon as unknown as DaemonInternals & {
      handleWrite: (p: { streamingId: string; message: string }) => { success: boolean };
    };
    const sid = 'streaming-closed';
    let stdinEnded = false;
    const written: string[] = [];
    internals.processes.set(sid, {
      type: 'pipe',
      pid: 99998,
      write: (data: string) => { written.push(data); },
      kill: () => {},
      endStdin: () => { stdinEnded = true; },
      inputOpen: () => !stdinEnded,
    });

    internals.handleClaudeMessage(sid, { type: 'result' });
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 100);
    expect(stdinEnded).toBe(true);

    // The CLI finishes a background task and reports it in a turn of its own.
    internals.handleClaudeMessage(sid, init);
    internals.handleClaudeMessage(sid, { type: 'result' });

    expect(internals.handleWrite({ streamingId: sid, message: 'stop it' })).toEqual({ success: false });
    expect(written).toEqual([]);
    vi.useRealTimers();
  });
});
