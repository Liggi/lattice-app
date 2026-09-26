/**
 * Run-scoped message coalescing.
 *
 * A provider streams one API message as multiple content events, and those
 * fragments do not respect turn boundaries: a background subagent
 * legitimately keeps streaming after the orchestrator's turn:end, so
 * fragments of one message can straddle turn:end and even run:end of the
 * parent turn. Coalescing by message identity must therefore span a RUN (one
 * spawned process), not one turn — resetting at turn boundaries splits a
 * message into duplicates sharing an id (React key collisions downstream).
 *
 * Within a run, API message ids are unique, so identity-keyed merging folds
 * exactly the fragments that belong together. ACROSS runs ids may repeat (a
 * respawned process replaying a cassette, or any provider that restarts id
 * allocation), so the scope resets at run:start — a respawn's reply stays its
 * own message instead of vanishing into the previous run's.
 *
 * This module owns that scoping rule; what a "message" is and how two
 * fragments merge stays with the caller.
 */

import type { SessionEvent } from './events.js'

export interface RunScopedCoalescerOptions<M> {
  /** Stable identity for a message within one run (e.g. role + messageId). */
  keyOf: (msg: M) => string
  /** Fold an incoming fragment into the already-emitted message. */
  merge: (existing: M, incoming: M) => void
  /** Emit a message seen for the first time in this run scope. */
  append: (msg: M) => void
}

export interface RunScopedCoalescer<M> {
  /**
   * Observe the next event in sequence order, with the message the caller
   * derived from it (null when the event produces no message — the event
   * still advances the scope: run:start resets it).
   */
  onEvent(event: Pick<SessionEvent, 'type'>, msg: M | null): void
}

export function createRunScopedCoalescer<M>(
  options: RunScopedCoalescerOptions<M>,
): RunScopedCoalescer<M> {
  const byKey = new Map<string, M>()
  return {
    onEvent(event, msg) {
      if (event.type === 'run:start') byKey.clear()
      if (msg === null) return
      const key = options.keyOf(msg)
      const existing = byKey.get(key)
      if (existing) {
        options.merge(existing, msg)
        return
      }
      byKey.set(key, msg)
      options.append(msg)
    },
  }
}
