/**
 * Whether a worker is actually running, asked of the harness rather than
 * inferred from its coordinator's log.
 *
 * The two are different questions and the card needs both. `phase` is the
 * assignment lifecycle folded from the coordinator's log, and nothing in that
 * fold represents a process ending: a worker that is stopped or exits without
 * reporting leaves no event there, so its phase stays wherever it was. On
 * 2026-09-21 four workers across two projects read `working` with every
 * process dead since 12:30:22 and no report from any of them.
 *
 * Liveness alone is not the answer either. A worker the user stops keeps its
 * process: `deriveStatus` returns `idle` while `processAlive` stays true, so
 * "is the process up" would still have called those four Working. What the
 * card needs is whether a turn is in progress, which is what `deriveStatus`
 * already answers everywhere else in the server.
 */

import type { WorkerRuntime } from '../../types/worker-events.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { getEventStorage } from '../../harness/event-message-reader.js';

function fromStatus(status: string, processAlive: boolean): WorkerRuntime {
  if (status === 'starting') return 'starting';
  if (status === 'streaming') return 'working';
  if (status === 'stopping') return 'stopping';
  return processAlive ? 'idle' : 'exited';
}

export function readWorkerRuntime(worker: string): WorkerRuntime {
  const manager = getHarnessSessionManager();
  // No harness at all is the one genuinely unknown case. It is not evidence
  // of a stopped worker, and saying Stopped here would be inventing a fact.
  if (!manager) return 'unknown';

  const live = manager.inspect(worker);
  if (live) return fromStatus(live.status, live.processAlive);

  // The manager holds every session this server spawned and drops one only in
  // `destroy()`, which SIGKILLs a live process on the way out (verified in
  // session-manager.js, the sole `sessions.delete`). So an absent session has
  // no process here — including every session inherited from before a
  // restart, whose process died with the previous server. That is `exited`
  // rather than unknown, and after a restart it is exactly what the card
  // should say.
  //
  // One thing absence cannot distinguish on its own: a worker whose process
  // has not been spawned yet looks identical to one whose process is gone.
  // The persisted log separates them — a session with no status-bearing event
  // has never run, and calling that Stopped would be as wrong as calling it
  // Working.
  const events = getEventStorage().readStatusWindow(worker);
  return events.length === 0 ? 'unknown' : 'exited';
}
