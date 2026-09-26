import { describe, it, expect, vi } from 'vitest'
import { EventLog } from '../../src/server/event-log.js'

function appendN(log: EventLog, n: number) {
  for (let i = 0; i < n; i++) {
    log.append('content', { i }, 'r1', 's1')
  }
}

describe('EventLog', () => {
  describe('append', () => {
    it('assigns monotonically increasing sequence numbers', () => {
      const log = new EventLog()
      const e1 = log.append('run:start', {}, 'r1', 's1')
      const e2 = log.append('run:ready', {}, 'r1', 's1')
      const e3 = log.append('content', { blocks: [] }, 'r1', 's1')
      expect(e1.seq).toBe(1)
      expect(e2.seq).toBe(2)
      expect(e3.seq).toBe(3)
    })

    it('stores sessionId, runId, type, and data correctly', () => {
      const log = new EventLog()
      const e = log.append('run:start', { config: { prompt: 'hi' } }, 'run-1', 'sess-1')
      expect(e.sessionId).toBe('sess-1')
      expect(e.runId).toBe('run-1')
      expect(e.type).toBe('run:start')
      expect(e.data).toEqual({ config: { prompt: 'hi' } })
    })

    it('includes meta when provided', () => {
      const log = new EventLog()
      const e = log.append('content', {}, 'r1', 's1', { pid: 1234, rawType: 'assistant' })
      expect(e.meta).toEqual({ pid: 1234, rawType: 'assistant' })
    })

    it('omits meta when not provided', () => {
      const log = new EventLog()
      const e = log.append('content', {}, 'r1', 's1')
      expect(e.meta).toBeUndefined()
    })

    it('sets a timestamp', () => {
      const log = new EventLog()
      const before = Date.now()
      const e = log.append('run:start', {}, 'r1', 's1')
      const after = Date.now()
      expect(e.timestamp).toBeGreaterThanOrEqual(before)
      expect(e.timestamp).toBeLessThanOrEqual(after)
    })
  })

  describe('since', () => {
    it('returns all events when afterSeq is 0', () => {
      const log = new EventLog()
      appendN(log, 5)
      expect(log.since(0)).toHaveLength(5)
    })

    it('returns events after the given sequence', () => {
      const log = new EventLog()
      appendN(log, 5)
      const events = log.since(3)
      expect(events).toHaveLength(2)
      expect(events[0].seq).toBe(4)
      expect(events[1].seq).toBe(5)
    })

    it('returns empty when afterSeq is at the latest event', () => {
      const log = new EventLog()
      appendN(log, 3)
      expect(log.since(3)).toHaveLength(0)
    })

    it('returns empty when afterSeq is beyond the latest event', () => {
      const log = new EventLog()
      appendN(log, 3)
      expect(log.since(100)).toHaveLength(0)
    })

    it('returns empty for an empty log', () => {
      const log = new EventLog()
      expect(log.since(0)).toHaveLength(0)
    })

    it('returns empty when requested seq is before evicted events', () => {
      const log = new EventLog(5)
      appendN(log, 10) // evicts first 5, keeps seq 6-10
      // Asking for events after seq 2 — we don't have them
      expect(log.since(2)).toHaveLength(0)
    })
  })

  describe('needsReset', () => {
    it('returns false for empty log', () => {
      const log = new EventLog()
      expect(log.needsReset(5)).toBe(false)
    })

    it('returns false when afterSeq is 0 (fresh connect)', () => {
      const log = new EventLog(5)
      appendN(log, 10)
      expect(log.needsReset(0)).toBe(false)
    })

    it('returns true when afterSeq is before the earliest event', () => {
      const log = new EventLog(5)
      appendN(log, 10) // keeps seq 6-10
      expect(log.needsReset(3)).toBe(true)
    })

    it('returns false when afterSeq is within the window', () => {
      const log = new EventLog(5)
      appendN(log, 10) // keeps seq 6-10
      expect(log.needsReset(7)).toBe(false)
    })
  })

  describe('latest', () => {
    it('returns null for empty log', () => {
      const log = new EventLog()
      expect(log.latest()).toBeNull()
    })

    it('returns the most recent event', () => {
      const log = new EventLog()
      log.append('run:start', {}, 'r1', 's1')
      log.append('run:ready', { resumeId: 'abc' }, 'r1', 's1')
      expect(log.latest()!.type).toBe('run:ready')
    })
  })

  describe('all', () => {
    it('returns all events', () => {
      const log = new EventLog()
      appendN(log, 3)
      expect(log.all()).toHaveLength(3)
    })

    it('returns a readonly reference', () => {
      const log = new EventLog()
      appendN(log, 3)
      const events = log.all()
      expect(events).toHaveLength(3)
    })
  })

  describe('subscribe', () => {
    it('notifies listeners on append', () => {
      const log = new EventLog()
      const received: number[] = []
      log.subscribe((e) => received.push(e.seq))
      appendN(log, 3)
      expect(received).toEqual([1, 2, 3])
    })

    it('supports multiple listeners', () => {
      const log = new EventLog()
      const a: number[] = []
      const b: number[] = []
      log.subscribe((e) => a.push(e.seq))
      log.subscribe((e) => b.push(e.seq))
      log.append('run:start', {}, 'r1', 's1')
      expect(a).toEqual([1])
      expect(b).toEqual([1])
    })

    it('unsubscribe stops notifications', () => {
      const log = new EventLog()
      const received: number[] = []
      const unsub = log.subscribe((e) => received.push(e.seq))
      log.append('run:start', {}, 'r1', 's1')
      unsub()
      log.append('run:ready', {}, 'r1', 's1')
      expect(received).toEqual([1])
    })

    it('tracks subscriber count', () => {
      const log = new EventLog()
      expect(log.subscriberCount).toBe(0)
      const unsub1 = log.subscribe(() => {})
      expect(log.subscriberCount).toBe(1)
      const unsub2 = log.subscribe(() => {})
      expect(log.subscriberCount).toBe(2)
      unsub1()
      expect(log.subscriberCount).toBe(1)
      unsub2()
      expect(log.subscriberCount).toBe(0)
    })
  })

  describe('sliding window eviction', () => {
    it('evicts oldest events when exceeding max size', () => {
      const log = new EventLog(5)
      appendN(log, 8)
      expect(log.length).toBe(5)
      expect(log.earliestSeq).toBe(4)
      expect(log.all()[0].seq).toBe(4)
      expect(log.all()[4].seq).toBe(8)
    })

    it('preserves all events when under max size', () => {
      const log = new EventLog(10)
      appendN(log, 5)
      expect(log.length).toBe(5)
      expect(log.earliestSeq).toBe(1)
    })

    it('notifies listener before eviction is visible', () => {
      const log = new EventLog(3)
      const seqs: number[] = []
      log.subscribe((e) => seqs.push(e.seq))
      appendN(log, 5)
      // All 5 events were delivered to the listener
      expect(seqs).toEqual([1, 2, 3, 4, 5])
      // But only last 3 remain in the log
      expect(log.length).toBe(3)
    })

    it('since() returns correctly within the window', () => {
      const log = new EventLog(5)
      appendN(log, 10) // keeps seq 6-10
      const events = log.since(7)
      expect(events).toHaveLength(3) // seq 8, 9, 10
      expect(events[0].seq).toBe(8)
    })
  })

  describe('since() with storage-backed recovery', () => {
    it('since(0) reads from storage when in-memory is empty', () => {
      // Simulates server restart: EventLog created with storage + sessionId,
      // but no events in memory (recoverFromStorage path).
      const storedEvents = [
        { sessionId: 's1', runId: 'r1', seq: 1, timestamp: 1000, type: 'run:start' as const, data: {} },
        { sessionId: 's1', runId: 'r1', seq: 2, timestamp: 1001, type: 'content' as const, data: {} },
        { sessionId: 's1', runId: 'r1', seq: 3, timestamp: 1002, type: 'turn:end' as const, data: {} },
      ]
      const fakeStorage = {
        write: vi.fn(),
        read: vi.fn((_sid: string, opts?: { afterSeq?: number }) => {
          const after = opts?.afterSeq ?? 0
          return storedEvents.filter(e => e.seq > after)
        }),
        readTail: vi.fn((_sid: string, limit: number) => storedEvents.slice(-limit)),
        count: vi.fn(() => storedEvents.length),
        findLatestRunReady: vi.fn(() => null),
        copyFrom: vi.fn(),
      }

      const log = new EventLog({ storage: fakeStorage, sessionId: 's1' })
      // In-memory is empty, but storage has 3 events
      expect(log.all()).toHaveLength(0)

      const result = log.since(0)
      expect(result).toHaveLength(3)
      expect(result[0].seq).toBe(1)
      expect(result[2].seq).toBe(3)
      // Cold client (afterSeq === 0) must read the TAIL, not the head.
      expect(fakeStorage.readTail).toHaveBeenCalled()
      expect(fakeStorage.read).not.toHaveBeenCalledWith('s1', { afterSeq: 0 })
    })

    it('since(N) reads from storage when in-memory is empty', () => {
      const storedEvents = [
        { sessionId: 's1', runId: 'r1', seq: 1, timestamp: 1000, type: 'run:start' as const, data: {} },
        { sessionId: 's1', runId: 'r1', seq: 2, timestamp: 1001, type: 'content' as const, data: {} },
        { sessionId: 's1', runId: 'r1', seq: 3, timestamp: 1002, type: 'turn:end' as const, data: {} },
      ]
      const fakeStorage = {
        write: vi.fn(),
        read: vi.fn((_sid: string, opts?: { afterSeq?: number }) => {
          const after = opts?.afterSeq ?? 0
          return storedEvents.filter(e => e.seq > after)
        }),
        readTail: vi.fn((_sid: string, limit: number) => storedEvents.slice(-limit)),
        count: vi.fn(() => storedEvents.length),
        findLatestRunReady: vi.fn(() => null),
        copyFrom: vi.fn(),
      }

      const log = new EventLog({ storage: fakeStorage, sessionId: 's1' })
      const result = log.since(1)
      expect(result).toHaveLength(2)
      expect(result[0].seq).toBe(2)
      // Incremental reconnect (afterSeq > 0) still uses read(), not readTail.
      expect(fakeStorage.read).toHaveBeenCalledWith('s1', { afterSeq: 1 })
      expect(fakeStorage.readTail).not.toHaveBeenCalled()
    })

    it('since(0) returns the TAIL window, not the head, for a long stored history', () => {
      // Recovery path with >10k stored events and empty in-memory buffer.
      // A head read would return the OLDEST window (mid-history for a long
      // session); the cold client must get the newest turn.
      const total = 25000
      const storedEvents = Array.from({ length: total }, (_, i) => {
        const seq = i + 1
        // Lay out turns so the last contentful turn sits at the very tail.
        let type: 'run:start' | 'content' | 'turn:end' = 'content'
        if (seq % 100 === 1) type = 'run:start'
        else if (seq % 100 === 0) type = 'turn:end'
        return { sessionId: 's1', runId: 'r1', seq, timestamp: 1000 + seq, type, data: { i } }
      })

      const readEvents = (opts?: { afterSeq?: number; beforeSeq?: number; limit?: number }) => {
        const after = opts?.afterSeq ?? 0
        const before = opts?.beforeSeq ?? Number.MAX_SAFE_INTEGER
        const limit = opts?.limit ?? 10000
        const filtered = storedEvents.filter(e => e.seq > after && e.seq < before)
        // Constructor seq-sync uses beforeSeq=MAX, limit=1 → newest event.
        return opts?.beforeSeq !== undefined ? filtered.slice(-limit) : filtered.slice(0, limit)
      }
      const fakeStorage = {
        write: vi.fn(),
        read: vi.fn(readEvents),
        readTail: vi.fn((_sid: string, limit: number) => storedEvents.slice(-limit)),
        count: vi.fn(() => storedEvents.length),
        findLatestRunReady: vi.fn(() => null),
        copyFrom: vi.fn(),
      }

      const log = new EventLog({ storage: fakeStorage, sessionId: 's1' })
      const result = log.since(0)

      // Bounded to the 10k tail window, ASC order, and it is the TAIL.
      expect(result.length).toBe(10000)
      expect(result[0].seq).toBe(total - 10000 + 1)
      expect(result[result.length - 1].seq).toBe(total)
      for (let i = 1; i < result.length; i++) {
        expect(result[i].seq).toBeGreaterThan(result[i - 1].seq)
      }
      // The only read() call is the constructor seq-sync (beforeSeq=MAX);
      // no head read for the cold replay.
      expect(fakeStorage.read).not.toHaveBeenCalledWith('s1', { afterSeq: 0 })
    })

    it('since(0) with a recovery run:end in memory tail-reads the gap below it', () => {
      // recoverFromStorage may append a synthetic run:end into memory (empty
      // buffer + one high-seq event). since(0) must serve the stored TAIL
      // below that event, then the in-memory run:end — no head slice, no dup.
      const stored = Array.from({ length: 12000 }, (_, i) => {
        const seq = i + 1
        return { sessionId: 's1', runId: 'r1', seq, timestamp: 1000 + seq, type: 'content' as const, data: { i } }
      })
      const readTail = vi.fn((_sid: string, limit: number) => stored.slice(-limit))
      const read = vi.fn((_sid: string, opts?: { afterSeq?: number; beforeSeq?: number; limit?: number }) => {
        const after = opts?.afterSeq ?? 0
        const before = opts?.beforeSeq ?? Number.MAX_SAFE_INTEGER
        const limit = opts?.limit ?? 10000
        const filtered = stored.filter(e => e.seq > after && e.seq < before)
        return opts?.beforeSeq !== undefined ? filtered.slice(-limit) : filtered.slice(0, limit)
      })
      const fakeStorage = {
        write: vi.fn(),
        read,
        readTail,
        count: vi.fn(() => stored.length),
        findLatestRunReady: vi.fn(() => null),
        copyFrom: vi.fn(),
      }

      const log = new EventLog({ storage: fakeStorage, sessionId: 's1' })
      // Simulate recovery appending a synthetic run:end at seq 12001.
      log.append('run:end', { reason: 'server_restart' }, 'r1', 's1', { inferred: true, source: 'recovery' })

      const result = log.since(0)
      // All stored events are < 12001, so nothing is filtered out; the tail
      // window (10000) plus the in-memory run:end.
      expect(result.length).toBe(10001)
      expect(result[result.length - 1].seq).toBe(12001)
      expect(result[result.length - 1].type).toBe('run:end')
      // Ascending, no duplicate seqs.
      const seqs = result.map(e => e.seq)
      expect(new Set(seqs).size).toBe(seqs.length)
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
      }
      // No head read (afterSeq=0) for the cold replay — only the tail path.
      expect(fakeStorage.read).not.toHaveBeenCalledWith('s1', { afterSeq: 0 })
    })
  })

  describe('length and earliestSeq', () => {
    it('length tracks event count', () => {
      const log = new EventLog()
      expect(log.length).toBe(0)
      appendN(log, 3)
      expect(log.length).toBe(3)
    })

    it('earliestSeq is null for empty log', () => {
      const log = new EventLog()
      expect(log.earliestSeq).toBeNull()
    })

    it('earliestSeq reflects the first event after eviction', () => {
      const log = new EventLog(3)
      appendN(log, 5)
      expect(log.earliestSeq).toBe(3)
    })
  })
})
