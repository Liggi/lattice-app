import type { SessionEvent, EventType } from '../protocol/events.js'
import type { EventStorageAdapter } from './event-storage.js'

export const DEFAULT_MAX_SIZE = 2000

/** Number of most-recent stored events served to a cold client (after=0)
 *  recovering a session from storage. Matches the head-read limit the
 *  storage adapter previously applied, so only the direction changes. */
export const TAIL_WINDOW = 10000

/** Most events an SSE connection replays before going live. A worker's turn
 *  can run to thousands of events and megabytes, and replaying it all made an
 *  opened session play forward from the turn's start. Older events come from
 *  the history endpoint, which the client asks for after a clipped replay. */
export const REPLAY_WINDOW = 100

export interface EventLogOptions {
  maxSize?: number
  storage?: EventStorageAdapter
  /** Session ID for storage lookups. Required when recovering from storage
   *  with an empty in-memory buffer (server restart). */
  sessionId?: string
}

export class EventLog {
  private events: SessionEvent[] = []
  private seq = 0
  private listeners = new Set<(event: SessionEvent) => void>()
  private maxSize: number
  private storage: EventStorageAdapter | null
  private sessionId: string | null

  constructor(options?: EventLogOptions | number) {
    // Backwards compatible: accept a plain number (maxSize) or options object
    if (typeof options === 'number') {
      this.maxSize = options
      this.storage = null
      this.sessionId = null
    } else {
      this.maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE
      this.storage = options?.storage ?? null
      this.sessionId = options?.sessionId ?? null
    }

    // When recovering from storage, sync the seq counter so new appends
    // don't collide with existing events.
    if (this.storage && this.sessionId) {
      const tail = this.storage.read(this.sessionId, {
        beforeSeq: Number.MAX_SAFE_INTEGER,
        limit: 1,
      })
      if (tail.length > 0) {
        this.seq = tail[0].seq
      }
    }
  }

  /**
   * Hold already-stored events in memory, oldest first and ending at the
   * stored tail, so what is derived from all() sees them; nothing is written
   * or announced. Only on a log with nothing in memory yet.
   */
  preload(events: readonly SessionEvent[]): void {
    if (this.events.length > 0 || events.length === 0) return
    this.events = [...events]
    this.seq = Math.max(this.seq, events[events.length - 1].seq)
    this.evict()
  }

  append(
    type: EventType,
    data: unknown,
    runId: string,
    sessionId: string,
    meta?: SessionEvent['meta'],
  ): SessionEvent {
    const event: SessionEvent = {
      sessionId,
      runId,
      seq: ++this.seq,
      timestamp: Date.now(),
      type,
      data,
      ...(meta ? { meta } : {}),
    }
    this.events.push(event)
    this.storage?.write(event)
    this.evict()
    for (const listener of this.listeners) listener(event)
    return event
  }

  /**
   * Returns events after the given seq.
   * Checks in-memory first; falls back to storage for evicted events.
   */
  since(afterSeq: number): SessionEvent[] {
    if (this.events.length === 0 && !this.storage) return []

    const earliest = this.events[0]?.seq ?? Infinity

    // In-memory fast path: serve from memory when the requested seq is
    // within the in-memory range.
    if (this.events.length > 0 && afterSeq >= earliest) {
      return this.events.filter((e) => e.seq > afterSeq)
    }

    // Below here: afterSeq < earliest (gap between request and memory).
    // After recovery, memory may contain only the synthetic run:end event
    // at a high seq while all real conversation events are in storage.

    // Storage + memory: read the gap from storage, merge with in-memory
    if (this.storage && this.events.length > 0) {
      const sessionId = this.events[0].sessionId
      // Cold client (afterSeq === 0) on a recovered log: serve the TAIL of
      // the stored gap, not the head. A head read would return the oldest
      // events and the SSE handler would scope its last-turn scan to a
      // mid-history window. Bound to seq < earliest so we don't duplicate
      // the in-memory tail (typically the synthetic recovery run:end).
      const fromStorage = afterSeq === 0
        ? this.storage.readTail(sessionId, TAIL_WINDOW).filter((e) => e.seq < earliest)
        : this.storage.read(sessionId, { afterSeq, beforeSeq: earliest })
      const fromMemory = this.events.filter((e) => e.seq > afterSeq)
      return [...fromStorage, ...fromMemory]
    }

    // Storage only (memory empty, e.g., pure recovery before any new events)
    if (this.storage) {
      const sid = this.sessionId ?? this.events[0]?.sessionId
      if (sid) {
        // Cold client on a recovered log with empty memory: the TAIL is the
        // newest turn. A read({ afterSeq: 0 }) here returns the OLDEST window.
        return afterSeq === 0
          ? this.storage.readTail(sid, TAIL_WINDOW)
          : this.storage.read(sid, { afterSeq })
      }
      return []
    }

    // No storage, afterSeq=0 — return in-memory events (the full session
    // for no-storage EventLogs that haven't evicted anything yet).
    // For afterSeq > 0 with evicted events, return [] — the gap is
    // unrecoverable without storage. Callers should check needsReset() first.
    if (this.events.length > 0 && afterSeq === 0) {
      return [...this.events]
    }

    return []
  }

  /**
   * Classifies a storage-backed reconnect at `afterSeq > 0`. Returns whether
   * the client's cursor is incoherent — its seq is past the stored tail (a seq
   * restart after the session's storage was reset) or the gap to the newest
   * stored event exceeds REPLAY_WINDOW (a client reopening a session it last
   * saw hundreds of events ago would otherwise play them all forward). In
   * either case the caller must serve the tail window and declare a reset so
   * the client rebuilds from the tail rather than merging into a gapped list.
   *
   * Returns false when there's no storage, when afterSeq is 0, or when the gap
   * is small and coherent (normal resume).
   */
  reconnectNeedsReset(afterSeq: number): boolean {
    if (afterSeq <= 0) return false
    if (!this.storage) return false
    const sid = this.sessionId ?? this.events[0]?.sessionId
    if (!sid) return false
    const maxSeq = this.storage.maxSeq(sid)
    if (maxSeq === 0) return false
    if (afterSeq > maxSeq) return true
    return maxSeq - afterSeq > REPLAY_WINDOW
  }

  /**
   * Returns true if the requested afterSeq is older than our earliest event
   * AND we can't serve from storage — meaning the caller needs a full reset.
   */
  needsReset(afterSeq: number): boolean {
    if (this.events.length === 0 && !this.storage) return false
    if (afterSeq === 0) return false

    const earliest = this.events[0]?.seq ?? Infinity

    // If storage exists, we can always serve historical events
    if (this.storage) return false

    // No storage — check if requested seq is before our earliest in-memory event
    return afterSeq < earliest
  }

  /**
   * Read events directly from storage (bypassing in-memory cache).
   * Useful for HTTP history endpoints. Returns empty if no storage adapter.
   */
  readFromStorage(sessionId: string, opts?: {
    afterSeq?: number
    beforeSeq?: number
    limit?: number
  }): SessionEvent[] {
    return this.storage?.read(sessionId, opts) ?? []
  }

  /**
   * Count total events in storage for a session.
   * Returns in-memory count if no storage adapter.
   */
  countInStorage(sessionId: string): number {
    return this.storage?.count(sessionId) ?? this.events.length
  }

  latest(): SessionEvent | null {
    return this.events[this.events.length - 1] ?? null
  }

  all(): readonly SessionEvent[] {
    return this.events
  }

  subscribe(cb: (event: SessionEvent) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  get length(): number {
    return this.events.length
  }

  get subscriberCount(): number {
    return this.listeners.size
  }

  get earliestSeq(): number | null {
    return this.events[0]?.seq ?? null
  }

  get hasStorage(): boolean {
    return this.storage !== null
  }

  private evict(): void {
    if (this.events.length > this.maxSize) {
      const excess = this.events.length - this.maxSize
      this.events.splice(0, excess)
    }
  }
}
