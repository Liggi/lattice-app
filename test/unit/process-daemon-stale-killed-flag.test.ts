/**
 * Regression: silent input drop after idle-timeout "kill" attempt
 *
 * Diagnosed 2026-04-27. The daemon's
 * 5-minute idle timer fires while the Claude CLI is in a long autonomous
 * tool-use loop (e.g. waiting on a long `Monitor` call). The timer:
 *
 *   1. Calls `proc.endStdin()` (graceful EOF on stdin) — but the CLI is
 *      not currently reading stdin, so closing it is invisible mid-loop.
 *   2. Adds the streamingId to `killedProcesses` *unconditionally*, with
 *      no verification that the underlying OS process actually exited.
 *
 * Before the fix, the CLI kept producing turns and the `killedProcesses`
 * flag never cleared (only `cleanup()` removes it, and cleanup only runs
 * on actual process death). When the user later submitted input,
 * `handleWrite` rejected it via the stale flag — but the harness records
 * `input:sent` before the IPC rejection propagates (and `sendStdinMessage`
 * resolves false instead of rejecting, so `daemon-process-adapter.ts:123`
 * silently swallows it). UI shows "streaming" forever; no response comes.
 *
 * Fix: in `handleClaudeMessage`, self-heal the stale flag. If we receive
 * any output for a streamingId we thought we killed, the kill didn't
 * take — clear the flag so the next user input goes through.
 *
 * Source references:
 *   - process-daemon.ts:handleClaudeMessage  self-healing block (the fix)
 *   - process-daemon.ts:1182-1199            idle timer body
 *   - process-daemon.ts:824-826              handleWrite rejection check
 *   - process-daemon.ts:993                  flag also cleared on cleanup
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProcessDaemon } from '../../src/process-daemon/process-daemon.js';

// IDLE_TIMEOUT_MS is private static readonly = 5 * 60 * 1000 (process-daemon.ts:127)
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface FakePipeProcess {
  type: 'pipe';
  pid: number;
  write: (data: string) => void;
  kill: (signal?: NodeJS.Signals) => void;
  endStdin?: () => void;
}

interface DaemonInternals {
  processes: Map<string, FakePipeProcess>;
  killedProcesses: Set<string>;
  idleTimeouts: Map<string, NodeJS.Timeout>;
  handleClaudeMessage: (sid: string, msg: unknown) => void;
  handleWrite: (params: { streamingId: string; message: string }) => { success: boolean };
}

function makeFakeAliveProcess(opts?: {
  onWrite?: (data: string) => void;
  onEndStdin?: () => void;
  onKill?: (sig?: NodeJS.Signals) => void;
}): FakePipeProcess {
  return {
    type: 'pipe',
    pid: 99999,
    write: (data: string) => opts?.onWrite?.(data),
    // Both kill paths are no-ops by default: simulates the real-world case
    // where the CLI is mid-tool-loop, not reading stdin, and ignores
    // graceful close. This is what PID 94305 was doing in the production
    // incident — alive in `kevent64` 25+ minutes after the supposed kill.
    kill: (sig) => opts?.onKill?.(sig),
    endStdin: () => opts?.onEndStdin?.(),
  };
}

describe('ProcessDaemon — stale killedProcesses flag self-heals on output', () => {
  let daemon: ProcessDaemon;

  beforeEach(() => {
    vi.useFakeTimers();
    daemon = new ProcessDaemon({
      socketPath: `/tmp/test-daemon-${Math.random()}.sock`,
      // Avoid hitting findClaudeExecutable() — we never spawn anything.
      claudeExecutablePath: '/usr/bin/false',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('idle timer attempts kill and marks killedProcesses (intermediate state)', () => {
    const streamingId = 'streaming-A';
    let endStdinCalls = 0;
    const fakeProc = makeFakeAliveProcess({
      onEndStdin: () => { endStdinCalls += 1; },
    });

    const internals = daemon as unknown as DaemonInternals;
    internals.processes.set(streamingId, fakeProc);

    // CLI emits a `result` message → schedules 5-min idle timer.
    internals.handleClaudeMessage(streamingId, { type: 'result' });

    expect(internals.idleTimeouts.has(streamingId)).toBe(true);
    expect(internals.killedProcesses.has(streamingId)).toBe(false);

    // Time passes — agent in long tool loop, no further `result` arrives.
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 100);

    // Idle timer fired: endStdin called, killedProcesses set.
    // Process still in `processes` map (no close event yet).
    expect(endStdinCalls).toBe(1);
    expect(internals.killedProcesses.has(streamingId)).toBe(true);
    expect(internals.processes.has(streamingId)).toBe(true);
  });

  it('FIX: subsequent CLI output clears the stale killedProcesses flag', () => {
    const streamingId = 'streaming-heal';
    const fakeProc = makeFakeAliveProcess();

    const internals = daemon as unknown as DaemonInternals;
    internals.processes.set(streamingId, fakeProc);

    // Reproduce the post-idle-kill state: process alive, flag set.
    internals.killedProcesses.add(streamingId);

    // CLI emits any message — proves the kill didn't actually take.
    internals.handleClaudeMessage(streamingId, {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-7',
      tools: [],
      mcp_servers: [],
    });

    // Self-heal: flag cleared so subsequent writes work.
    expect(internals.killedProcesses.has(streamingId)).toBe(false);
  });

  it('FIX: handleWrite succeeds after self-heal, even though idle timer "killed" the process', () => {
    const streamingId = 'streaming-write';
    const writesReceived: string[] = [];
    const fakeProc = makeFakeAliveProcess({
      onWrite: (data) => { writesReceived.push(data); },
    });

    const internals = daemon as unknown as DaemonInternals;
    internals.processes.set(streamingId, fakeProc);

    // Idle timer fires while agent is in a tool loop.
    internals.handleClaudeMessage(streamingId, { type: 'result' });
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 100);
    expect(internals.killedProcesses.has(streamingId)).toBe(true);

    // Agent emits a message — kill clearly didn't take. Self-heal fires.
    internals.handleClaudeMessage(streamingId, {
      type: 'assistant',
      message: { role: 'assistant', content: [] },
    });
    expect(internals.killedProcesses.has(streamingId)).toBe(false);

    // User input now goes through to the alive process.
    const result = internals.handleWrite({
      streamingId,
      message: '{"type":"user","message":{"role":"user","content":"yeah lets open a PR"}}',
    });

    expect(result).toEqual({ success: true });
    expect(writesReceived).toHaveLength(1);
    expect(writesReceived[0]).toContain('yeah lets open a PR');
  });

  it('end-to-end: the stuck-flag scenario no longer drops user input', () => {
    const streamingId = 'streaming-E2E';
    const writesReceived: string[] = [];
    const fakeProc = makeFakeAliveProcess({
      onWrite: (data) => { writesReceived.push(data); },
      // endStdin is a no-op: CLI is in autonomous loop, ignores stdin EOF.
    });

    const internals = daemon as unknown as DaemonInternals;
    internals.processes.set(streamingId, fakeProc);

    // Step 1 — agent emits result → idle timer scheduled.
    internals.handleClaudeMessage(streamingId, { type: 'result' });

    // Step 2 — 5 min pass with no further messages → timer fires, kill
    // attempted, killedProcesses flag set, but process didn't actually die.
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 100);
    expect(internals.killedProcesses.has(streamingId)).toBe(true);

    // Step 3 — agent continues producing turns (matches real-world
    // production timeline: `System init message received` events at 18:20,
    // 18:25 *after* the 18:16 kill).
    internals.handleClaudeMessage(streamingId, {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-7',
      tools: [],
      mcp_servers: [],
    });

    // Self-heal cleared the flag.
    expect(internals.killedProcesses.has(streamingId)).toBe(false);

    // Step 4 — user submits input (the actual message that was dropped
    // in the production incident).
    const result = internals.handleWrite({
      streamingId,
      message: '{"type":"user","message":{"role":"user","content":"yeah i\\u2019m happy, lets open a PR"}}',
    });

    // Delivered, not dropped.
    expect(result).toEqual({ success: true });
    expect(writesReceived).toHaveLength(1);
    expect(writesReceived[0]).toContain("lets open a PR");
  });
});
