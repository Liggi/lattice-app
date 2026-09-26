/**
 * Cancelling a session's current turn, and knowing when it has actually gone.
 *
 * `SessionManager.stop()` appends `stop:requested`, sends SIGINT and returns
 * at once; the harness escalates to SIGTERM and SIGKILL over the next 5s only
 * if no `turn:end` follows. The send route used to poll the derived status
 * every 100ms until it read "not mid-turn", which is a statement about the
 * log's newest event, not about the turn it cancelled: when a drain opened a
 * new turn inside the poll interval the interrupt saw "streaming" and gave up.
 * This waits for the event that ends the
 * targeted turn — `turn:end`, or the process's `run:end` / `run:error` —
 * written after the `stop:requested` it caused, by subscribing to the log.
 * Nothing else can be mistaken for it.
 */

import type { SessionManager } from '@liggi/agent-ui-harness/server';

export type InterruptOutcome =
  /** The turn ended; `via` says whether the CLI cancelled it or the process went. */
  | { ended: true; via: 'turn:end' | 'process-exit'; stopSeq: number | null }
  /** No end arrived inside the wait; the turn may still be running. */
  | { ended: false; stopSeq: number | null };

const TERMINAL = new Set(['turn:end', 'run:end', 'run:error']);

/** The default wait: the harness has escalated to SIGKILL by 5s, and the exit lands soon after. */
export const INTERRUPT_WAIT_MS = 8000;

/**
 * Stop the session's current turn and wait until that turn has ended.
 * Resolves `ended: true` at once when there is no live turn to cancel.
 */
export async function interruptTurn(
  sessionManager: SessionManager,
  sessionId: string,
  timeoutMs = INTERRUPT_WAIT_MS,
): Promise<InterruptOutcome> {
  const log = sessionManager.getLog(sessionId);
  const before = log?.latest()?.seq ?? 0;

  await sessionManager.stop(sessionId);

  if (!log) return { ended: true, via: 'process-exit', stopSeq: null };

  // The stop we caused, or — when stop() returned without writing one because
  // an earlier stop is still in flight — that earlier one. Neither: nothing
  // was running, so nothing needs waiting for.
  const events = log.all();
  let stopSeq: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'stop:requested') {
      stopSeq = events[i].seq;
      break;
    }
    if (events[i].seq <= before && TERMINAL.has(events[i].type)) break;
  }
  if (stopSeq === null) {
    const alive = sessionManager.inspect(sessionId)?.processAlive ?? false;
    return { ended: true, via: alive ? 'turn:end' : 'process-exit', stopSeq: null };
  }

  const ended = (event: { type: string; seq: number }): 'turn:end' | 'process-exit' | null => {
    if (event.seq <= stopSeq || !TERMINAL.has(event.type)) return null;
    return event.type === 'turn:end' ? 'turn:end' : 'process-exit';
  };

  // Already there: the CLI can answer SIGINT inside stop()'s own tick.
  for (const event of events) {
    const via = ended(event);
    if (via) return { ended: true, via, stopSeq };
  }

  return new Promise<InterruptOutcome>((resolve) => {
    let done = false;
    const finish = (outcome: InterruptOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    };
    const unsubscribe = log.subscribe((event) => {
      const via = ended(event);
      if (via) finish({ ended: true, via, stopSeq });
    });
    const timer = setTimeout(() => finish({ ended: false, stopSeq }), timeoutMs);
    // Subscribed late: check once more for an end written between the scan and the subscribe.
    for (const event of log.all()) {
      const via = ended(event);
      if (via) {
        finish({ ended: true, via, stopSeq });
        return;
      }
    }
  });
}
