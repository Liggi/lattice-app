import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The runtime half of the worker card: what the process is doing, as distinct
 * from the assignment phase in the coordinator's log.
 *
 * The two cases worth pinning are the ones that were got wrong on the way
 * here. An explicit stop leaves the process alive and idle, so a liveness-only
 * check calls a stopped worker running. And an absent session is not the same
 * absence as an absent harness — one means no process, the other means the
 * question could not be asked.
 */

let manager: { inspect: (id: string) => unknown } | null = null;
let statusEvents: unknown[] = [];

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => manager,
}));
vi.mock('../../src/harness/event-message-reader.js', () => ({
  getEventStorage: () => ({ readStatusWindow: () => statusEvents }),
}));

const { readWorkerRuntime } = await import('../../src/services/sessions/worker-runtime.js');

const live = (status: string, processAlive: boolean) => {
  manager = { inspect: () => ({ status, processAlive }) };
};

beforeEach(() => {
  manager = null;
  statusEvents = [];
});

describe('what a worker process is doing', () => {
  it('reads a turn in progress as working', () => {
    live('streaming', true);
    expect(readWorkerRuntime('conv-w')).toBe('working');
  });

  it('separates booting and winding down from working', () => {
    live('starting', true);
    expect(readWorkerRuntime('conv-w')).toBe('starting');
    live('stopping', true);
    expect(readWorkerRuntime('conv-w')).toBe('stopping');
  });

  it('reads a stopped worker as idle even though its process is alive', () => {
    // What /stop leaves behind, and what a processAlive check gets wrong.
    live('idle', true);
    expect(readWorkerRuntime('conv-w')).toBe('idle');
  });

  it('reads a dead process as exited', () => {
    live('idle', false);
    expect(readWorkerRuntime('conv-w')).toBe('exited');
  });

  it('says unknown when there is no harness to ask, rather than stopped', () => {
    manager = null;
    expect(readWorkerRuntime('conv-w')).toBe('unknown');
  });

  it('treats a session the harness does not hold as exited, given it has run', () => {
    // The manager drops a session only in destroy(), which kills the process
    // first, so an absent session has none here — including after a restart,
    // where the old process died with the previous server.
    manager = { inspect: () => null };
    statusEvents = [{ type: 'run:end' }];
    expect(readWorkerRuntime('conv-w')).toBe('exited');
  });

  it('does not call a worker that has never run stopped', () => {
    // Absent from the harness and no events yet: the process has not been
    // spawned, which is not the same as one that is gone.
    manager = { inspect: () => null };
    statusEvents = [];
    expect(readWorkerRuntime('conv-w')).toBe('unknown');
  });
});
