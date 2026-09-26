import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { MemoryStorage } from '../helpers/memory-storage.js'
import { createTestServer } from '../helpers/test-server.js'
import { TAIL_WINDOW } from '../../src/server/event-log.js'
import type { SessionEvent, EventType } from '../../src/protocol/events.js'

let manager: SessionManager
let storage: MemoryStorage
let baseUrl: string
let close: () => Promise<void>

function seedTurns(storage: MemoryStorage, sessionId: string, turns: number, blocksPerTurn: number): number {
  let seq = 0
  const push = (type: EventType, data: unknown, runId: string) => {
    seq++
    storage.write({ sessionId, runId, seq, timestamp: 1000 + seq, type, data } as SessionEvent)
  }
  for (let t = 0; t < turns; t++) {
    const runId = `r${t}`
    push('run:start', { config: {} }, runId)
    push('run:ready', { resumeId: `resume-${t}` }, runId)
    push('input:sent', { text: `q${t}` }, runId)
    for (let b = 0; b < blocksPerTurn; b++) push('content', { turn: t, block: b }, runId)
    push('turn:end', {}, runId)
  }
  return seq
}

/** Seed a single giant turn with no interior turn boundary. */
function seedSingleTurn(storage: MemoryStorage, sessionId: string, contentBlocks: number): number {
  let seq = 0
  const push = (type: EventType, data: unknown) => {
    seq++
    storage.write({ sessionId, runId: 'r0', seq, timestamp: 1000 + seq, type, data } as SessionEvent)
  }
  push('run:start', { config: {} })
  push('run:ready', { resumeId: 'resume-0' })
  push('input:sent', { text: 'q0' })
  for (let b = 0; b < contentBlocks; b++) push('content', { turn: 0, block: b })
  return seq
}

async function readSSE(url: string, timeoutMs = 1500): Promise<{ events: SessionEvent[]; meta: { scoped: boolean; reset?: boolean } | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events: SessionEvent[] = []
  let meta: { scoped: boolean; reset?: boolean } | null = null
  try {
    const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6))
            if (currentEvent === 'replay_meta') meta = parsed
            else if (parsed.seq) events.push(parsed)
          } catch { /* not JSON */ }
        }
      }
    }
  } catch { /* aborted on timeout */ }
  clearTimeout(timer)
  return { events, meta }
}

describe('SSE reconnect with an incoherent client cursor forces a server-declared reset', () => {
  beforeEach(async () => {
    storage = new MemoryStorage()
    manager = new SessionManager(new FakeAdapter(), { storage })
    const server = await createTestServer(manager)
    baseUrl = server.baseUrl
    close = server.close
  })

  afterEach(async () => { await close() })

  it('gap larger than the tail window → tail replay + reset:true', async () => {
    // 400 turns × 40 blocks ≈ 17,600 events — well past TAIL_WINDOW (10k).
    const totalSeq = seedTurns(storage, 's1', 400, 40)
    expect(storage.count('s1')).toBeGreaterThan(TAIL_WINDOW)
    expect(manager.getLog('s1')).toBeFalsy()

    // Client reconnects with a stale-cache cursor far behind the tail.
    const afterSeq = 100
    expect(totalSeq - afterSeq).toBeGreaterThan(TAIL_WINDOW)

    const { events, meta } = await readSSE(`${baseUrl}/session/s1/events?after=${afterSeq}`)

    expect(meta).not.toBeNull()
    expect(meta!.reset).toBe(true)
    expect(meta!.scoped).toBe(true)

    // Tail window: the newest turn is delivered, ending at the last stored seq.
    const last = events[events.length - 1]
    expect(last.seq).toBe(totalSeq)
    expect(last.type).toBe('turn:end')
    const newestContent = events.find(e => e.type === 'content' && (e.data as { turn: number }).turn === 399)
    expect(newestContent).toBeDefined()
  })

  it('afterSeq greater than the stored max seq (seq restart) → tail replay + reset:true', async () => {
    const totalSeq = seedTurns(storage, 's1', 5, 3)
    expect(manager.getLog('s1')).toBeFalsy()

    // Storage was reset and seqs restarted; the client cursor is from the old,
    // higher-numbered life of the session.
    const afterSeq = totalSeq + 5000
    const { events, meta } = await readSSE(`${baseUrl}/session/s1/events?after=${afterSeq}`)

    expect(meta).not.toBeNull()
    expect(meta!.reset).toBe(true)
    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1].seq).toBe(totalSeq)
  })

  it('small coherent gap → incremental replay, no reset', async () => {
    const totalSeq = seedTurns(storage, 's1', 6, 3)
    expect(manager.getLog('s1')).toBeFalsy()

    // Reconnect from just before the last turn — a normal resume.
    const afterSeq = totalSeq - 5
    const { events, meta } = await readSSE(`${baseUrl}/session/s1/events?after=${afterSeq}`)

    expect(meta).not.toBeNull()
    expect(meta!.reset).toBeFalsy()
    // Incremental: only the events after the cursor, none at or below it.
    expect(events.every(e => e.seq > afterSeq)).toBe(true)
    expect(events[events.length - 1].seq).toBe(totalSeq)
  })
})

describe('replay_meta.scoped is truthful when the tail window clips a mid-turn start (F5)', () => {
  beforeEach(async () => {
    storage = new MemoryStorage()
    manager = new SessionManager(new FakeAdapter(), { storage })
    const server = await createTestServer(manager)
    baseUrl = server.baseUrl
    close = server.close
  })

  afterEach(async () => { await close() })

  it('a single giant turn with no interior boundary, longer than the window → scoped:true', async () => {
    // One turn, more content blocks than TAIL_WINDOW. No turn:end at all, so
    // boundary scanning finds nothing (replayStart stays 0) — but the window
    // still clips every event before its first delivered seq.
    const totalSeq = seedSingleTurn(storage, 's1', TAIL_WINDOW + 2000)
    expect(storage.count('s1')).toBeGreaterThan(TAIL_WINDOW)
    expect(manager.getLog('s1')).toBeFalsy()

    const { events, meta } = await readSSE(`${baseUrl}/session/s1/events?after=0`)

    expect(meta).not.toBeNull()
    // The core F5 assertion: the window clipped older events, so scoped is true
    // even though there is no interior turn boundary to detect.
    expect(meta!.scoped).toBe(true)
    // The window is the tail; its first delivered event is not seq 1.
    expect(events[0].seq).toBeGreaterThan(1)
    // The session was mid-turn (last stored event is content), so recovery
    // appends a synthetic run:end at seq totalSeq+1 — the newest delivered event.
    const last = events[events.length - 1]
    expect(last.type).toBe('run:end')
    expect(last.seq).toBe(totalSeq + 1)
  })
})
