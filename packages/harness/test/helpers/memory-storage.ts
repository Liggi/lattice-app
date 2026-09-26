import type { EventStorageAdapter } from '../../src/server/event-storage.js'
import type { SessionEvent } from '../../src/protocol/events.js'

/**
 * In-memory EventStorageAdapter for tests that need persistence
 * behavior without SQLite.
 */
export class MemoryStorage implements EventStorageAdapter {
  private events = new Map<string, SessionEvent[]>()

  write(event: SessionEvent): void {
    const list = this.events.get(event.sessionId) ?? []
    list.push(event)
    this.events.set(event.sessionId, list)
  }

  read(sessionId: string, opts?: {
    afterSeq?: number
    beforeSeq?: number
    limit?: number
  }): SessionEvent[] {
    const all = this.events.get(sessionId) ?? []
    const afterSeq = opts?.afterSeq
    const beforeSeq = opts?.beforeSeq
    const limit = opts?.limit ?? 10000

    if (afterSeq !== undefined && beforeSeq !== undefined) {
      return all.filter(e => e.seq > afterSeq && e.seq < beforeSeq)
    }
    if (beforeSeq !== undefined) {
      const filtered = all.filter(e => e.seq < beforeSeq)
      // Return last N in ascending order (matches SQLite DESC + reverse)
      return filtered.slice(-limit)
    }
    const filtered = all.filter(e => e.seq > (afterSeq ?? 0))
    return filtered.slice(0, limit)
  }

  readTail(sessionId: string, limit: number): SessionEvent[] {
    const all = this.events.get(sessionId) ?? []
    return all.slice(-limit)
  }

  count(sessionId: string): number {
    return (this.events.get(sessionId) ?? []).length
  }

  maxSeq(sessionId: string): number {
    const all = this.events.get(sessionId) ?? []
    return all.length > 0 ? all[all.length - 1].seq : 0
  }

  findLatestRunReady(sessionId: string): SessionEvent | null {
    const all = this.events.get(sessionId) ?? []
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].type === 'run:ready') return all[i]
    }
    return null
  }

  copyFrom(parentSessionId: string, targetSessionId: string, upToSeq: number): void {
    const parent = this.events.get(parentSessionId) ?? []
    const copied = parent.filter(e => e.seq <= upToSeq).map(e => ({
      ...e,
      sessionId: targetSessionId,
    }))
    const existing = this.events.get(targetSessionId) ?? []
    this.events.set(targetSessionId, [...existing, ...copied])
  }
}
