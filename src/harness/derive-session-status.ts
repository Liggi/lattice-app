/**
 * Event-log-backed session status.
 *
 * The harness event log is the single source of truth for session lifecycle.
 * This helper runs the harness's own deriveStatus/deriveProcessAlive over the
 * full log and maps the result to the status-endpoint shape
 * (ongoing/idle/stopping/completed).
 *
 * This is intentionally a small wrapper rather than a reimplementation: the
 * harness protocol owns the semantics of "what does this event log mean," and
 * we want the server's answer to agree with the client's answer whenever they
 * see the same events. Divergence is the bug class we're eliminating.
 */

import { deriveStatus, deriveProcessAlive } from '@liggi/agent-ui-harness/protocol';
import type { RunEndData, RunErrorData, SessionEvent, TurnEndData } from '@liggi/agent-ui-harness/protocol';
import { derivePendingWork, type PendingWork } from './derive-pending-work.js';

export type EndpointStatus = 'ongoing' | 'idle' | 'stopping' | 'completed';

export interface DerivedSessionStatus {
  status: EndpointStatus;
  processAlive: boolean;
  harnessStatus: ReturnType<typeof deriveStatus>;
  /**
   * Work that will wake this session without user input. Only meaningful while
   * the process is alive — a dead process cannot resume its own background
   * task, however the log ended.
   */
  pendingWork: PendingWork | null;
  /** A context compaction has started and neither finished nor been overtaken. */
  compacting: boolean;
  /** The session's latest turn or run ended in an error; null once new work starts. */
  failure: RunFailure | null;
}

export interface RunFailure {
  /** What went wrong, in the provider's or the harness's words. */
  message: string;
  /** When it failed, epoch ms. */
  at: number;
}

/**
 * Whether the session's latest work ended in a failure: a turn the provider
 * closed on an error (a usage limit, a sign-in failure, an API error), a run
 * that could not start, or a process that exited mid-turn. A Stop during the
 * turn is the user's doing, not a failure. Restarts end runs as
 * `server_restart` or `process_lost`, which the carry-on resumes, so they are
 * not failures either. The next input or run clears it.
 */
export function deriveRunFailure(events: readonly SessionEvent[]): RunFailure | null {
  let failure: RunFailure | null = null;
  let inTurn = false;
  let stopped = false;
  for (const event of events) {
    switch (event.type) {
      case 'input:sent':
      case 'run:start':
        failure = null;
        inTurn = true;
        stopped = false;
        break;
      case 'stop:requested':
        stopped = true;
        break;
      case 'turn:end': {
        const error = (event.data as TurnEndData | undefined)?.error;
        failure = error && !stopped ? { message: error.message, at: event.timestamp } : null;
        inTurn = false;
        stopped = false;
        break;
      }
      case 'run:error':
        failure = { message: (event.data as RunErrorData | undefined)?.message ?? 'The session could not start', at: event.timestamp };
        inTurn = false;
        break;
      case 'run:end': {
        const data = event.data as RunEndData | undefined;
        if (inTurn && !stopped && (data?.reason === 'error' || data?.reason === 'process_exit')) {
          const how = data.signal ? `signal ${data.signal}` : `code ${data.code ?? 'unknown'}`;
          failure = { message: `The process exited mid-turn (${how})`, at: event.timestamp };
        }
        inTurn = false;
        break;
      }
    }
  }
  return failure;
}

/** The events that decide whether a session is compacting; every other type is irrelevant to it. */
export const COMPACTION_STATE_EVENT_TYPES = [
  'context:compaction',
  'turn:end',
  'run:end',
  'run:error',
  'run:start',
  'run:ready',
] as const;

/**
 * True when the newest compaction-relevant event is a `context:compaction`
 * with phase 'started'. A terminal compaction phase, or any turn/run boundary
 * after the start (a crash mid-compaction never writes a terminal phase),
 * clears it. Takes the events newest first, so a caller reading the log
 * lazily stops at the first one that decides.
 *
 * "Boundary" includes the ones that *open* a run, not only the ones that close
 * it. A process killed mid-compaction never writes a terminal phase; when it is
 * respawned the next events are run:start / run:ready, and without those in the
 * clearing set the session would keep reporting compacting:true right through
 * the following turn until its turn:end. A new run supersedes the previous
 * run's unfinished compaction.
 */
export function compactingFromNewestFirst(events: Iterable<{ type: string; data?: unknown }>): boolean {
  for (const event of events) {
    if (event.type === 'context:compaction') {
      return (event.data as { phase?: string } | undefined)?.phase === 'started';
    }
    if ((COMPACTION_STATE_EVENT_TYPES as readonly string[]).includes(event.type)) return false;
  }
  return false;
}

function* newestFirst<T>(events: readonly T[]): Generator<T> {
  for (let i = events.length - 1; i >= 0; i--) yield events[i];
}

export function deriveSessionStatusFromEvents(events: readonly SessionEvent[]): DerivedSessionStatus {
  if (events.length === 0) {
    return { status: 'completed', processAlive: false, harnessStatus: 'idle', pendingWork: null, compacting: false, failure: null };
  }

  const harnessStatus = deriveStatus(events);
  const processAlive = deriveProcessAlive(events);

  const status: EndpointStatus = (() => {
    switch (harnessStatus) {
      case 'starting':
      case 'streaming':
        return 'ongoing';
      case 'stopping':
        return 'stopping';
      case 'idle':
        return processAlive ? 'idle' : 'completed';
    }
  })();

  const pendingWork = processAlive ? derivePendingWork(events) : null;
  const compacting = processAlive ? compactingFromNewestFirst(newestFirst(events)) : false;

  const failure = status === 'ongoing' || status === 'stopping' ? null : deriveRunFailure(events);

  return { status, processAlive, harnessStatus, pendingWork, compacting, failure };
}
