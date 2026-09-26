import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { MemoryStorage } from '../helpers/memory-storage.js'
import { createTestServer } from '../helpers/test-server.js'
import type { SessionEvent, EventType } from '../../src/protocol/events.js'

let manager: SessionManager
let storage: MemoryStorage
let baseUrl: string
let close: () => Promise<void>

function seed(storage: MemoryStorage, sessionId: string, turns: number, blocksPerTurn: number) {
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
    for (let b = 0; b < blocksPerTurn; b++) {
      push('content', { turn: t, block: b }, runId)
    }
    push('turn:end', {}, runId)
  }
  return seq
}

async function readSSE(url: string, timeoutMs = 1500): Promise<{ events: SessionEvent[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events: SessionEvent[] = []
  try {
    const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.seq) events.push(parsed)
          } catch { /* not an event line */ }
        }
      }
    }
  } catch { /* aborted on timeout */ }
  clearTimeout(timer)
  return { events }
}

describe('SSE cold-load of a long recovered history', () => {
  beforeEach(async () => {
    storage = new MemoryStorage()
    manager = new SessionManager(new FakeAdapter(), { storage })
    const server = await createTestServer(manager)
    baseUrl = server.baseUrl
    close = server.close
  })

  afterEach(async () => { await close() })

  it('cold load (after=0) replays the NEWEST turn, never a mid-history slice', async () => {
    // 200 turns × 60 content blocks ≈ 12,800 events — well past the 10k
    // storage window and any in-memory buffer. Pre-server-restart state.
    const totalSeq = seed(storage, 's1', 200, 60)
    expect(storage.count('s1')).toBeGreaterThan(12000)

    // Server restart: nothing in the manager's memory yet.
    expect(manager.getLog('s1')).toBeFalsy()

    const { events } = await readSSE(`${baseUrl}/session/s1/events?after=0`)

    expect(events.length).toBeGreaterThan(0)
    // The scoped replay must be the LAST turn: its final event is the last
    // stored turn:end, and it must include the newest content block.
    const last = events[events.length - 1]
    expect(last.seq).toBe(totalSeq)
    expect(last.type).toBe('turn:end')

    const newestContent = events.find(e => e.type === 'content' && (e.data as { turn: number }).turn === 199)
    expect(newestContent).toBeDefined()

    // It must NOT contain a mid-history turn (the old head-window bug rendered
    // turn ~15 as latest). No content block from an early turn should appear.
    const earliestTurnSeen = Math.min(
      ...events.filter(e => e.type === 'content').map(e => (e.data as { turn: number }).turn),
    )
    expect(earliestTurnSeen).toBe(199)

    // Ascending order preserved.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq)
    }
  })
})
