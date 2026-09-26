import type { SessionEvent } from '../protocol/events.js'

/**
 * Pluggable storage backend for EventLog persistence.
 *
 * When provided, EventLog writes every event to storage on append()
 * and reads from storage when in-memory events have been evicted.
 *
 * Implementations must be synchronous — EventLog.append() is synchronous
 * and storage writes must not defer. For async backends, buffer and flush
 * outside the EventLog call path.
 */
export interface EventStorageAdapter {
  /** Persist a single event. Called from EventLog.append(). */
  write(event: SessionEvent): void

  /**
   * Load events for a session, optionally filtered by seq range.
   * Results must be ordered by seq ascending.
   */
  read(sessionId: string, opts?: {
    afterSeq?: number
    beforeSeq?: number
    limit?: number
  }): SessionEvent[]

  /**
   * Load the most recent `limit` events for a session, ordered by seq
   * ascending. Unlike read() with afterSeq=0 (which returns the OLDEST
   * `limit` events), this returns the TAIL of the log. Used to serve a
   * cold client (`after=0`) the newest turn of a long history recovered
   * from storage, rather than a mid-history head slice.
   */
  readTail(sessionId: string, limit: number): SessionEvent[]

  /** Total event count for a session. */
  count(sessionId: string): number

  /**
   * Highest stored seq for a session, or 0 if it has no events. seq is strictly
   * increasing per session, so this is the change-detector a reconnect uses to
   * tell an incoherent client cursor (afterSeq past the stored tail, or a gap
   * too large to replay contiguously) from a normal small-gap resume.
   */
  maxSeq(sessionId: string): number

  /**
   * Return the most recent `run:ready` event for a session, or null if
   * none exists. Used by recovery to derive the resume identity without
   * relying on a tail-window scan that long histories can push past.
   */
  findLatestRunReady(sessionId: string): SessionEvent | null

  /**
   * Copy events from a parent session into a target session,
   * up to and including the given seq. Used for session branching.
   */
  copyFrom(parentSessionId: string, targetSessionId: string, upToSeq: number): void
}
