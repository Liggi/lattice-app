/**
 * SSE Replay Scoping — Compact Boundary Regression
 *
 * Tests that the SSE replay scoping logic correctly handles compact boundaries.
 *
 * Bug: After compact, two consecutive turn:end events (compact_boundary + result)
 * cause the replay scoping to create a "turn" with zero renderable content. On
 * initial connection (afterSeq=0), the SSE replays only this empty turn, clipping
 * all pre-compact messages.
 *
 * Observed: conv-eFdn1g_aGLmE, 2026-04-14.
 * Sequence: ...content → turn:end → compact_boundary(turn:end) → turn:end → ...
 * Expected: initial SSE replay includes pre-compact content events
 * Actual: initial SSE replay delivers only the result turn:end (no content)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { createTestServer } from '../helpers/test-server.js'
import {
  INIT_EVENT,
  TEXT_ASSISTANT,
  RESULT_SUCCESS,
  COMPACT_BOUNDARY,
} from '../helpers/fixtures.js'
import type { SessionEvent } from '../../src/protocol/events.js'

let adapter: FakeAdapter
let manager: SessionManager
let baseUrl: string
let close: () => Promise<void>

beforeEach(async () => {
  adapter = new FakeAdapter()
  manager = new SessionManager(adapter)
  const server = await createTestServer(manager)
  baseUrl = server.baseUrl
  close = server.close
})

afterEach(async () => {
  await close()
})

/** Collect SSE events until count reached or timeout. */
async function collectEvents(
  url: string,
  count: number,
  timeoutMs = 2000,
): Promise<{ events: SessionEvent[]; comments: string[] }> {
  const controller = new AbortController()
  const events: SessionEvent[] = []
  const comments: string[] = []

  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    })
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
          } catch {}
        }
        if (line.startsWith(': ')) {
          comments.push(line)
        }
      }

      if (events.length >= count) {
        controller.abort()
        break
      }
    }
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) throw err
  }

  clearTimeout(timeout)
  return { events, comments }
}

describe('SSE replay scoping with compact boundary', () => {
  it('replays pre-compact content on initial connection', async () => {
    // Build a session: run:start → run:ready → content → turn:end
    //                  → compact_boundary(turn:end) → run:ready → turn:end
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    // Compact boundary → normalized to turn:end with compact=true
    fake.emitLine(JSON.stringify(COMPACT_BOUNDARY))
    // Re-initialization after compact
    fake.emitLine(JSON.stringify(INIT_EVENT))
    // Result for the compact "turn"
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))

    await new Promise((r) => setTimeout(r, 100))

    // Initial SSE connection (afterSeq=0) — this is the bug scenario.
    // The replay scoping should include the pre-compact content event,
    // not just the post-compact turn:end.
    const { events, comments } = await collectEvents(
      `${baseUrl}/session/s1/events?after=0`,
      10,
      1000,
    )

    // Check the diagnostic comment for replay stats
    const replayComment = comments.find(c => c.includes('replay sessionId='))
    expect(replayComment).toBeDefined()

    // The replayed events should include at least one content event
    // (the pre-compact assistant message).
    const contentEvents = events.filter(e => e.type === 'content')
    expect(contentEvents.length).toBeGreaterThanOrEqual(1)

    // Specifically: the text "Hello, how can I help?" from TEXT_ASSISTANT
    const textData = contentEvents[0]?.data as { blocks?: Array<{ text?: string }> }
    expect(textData.blocks?.[0]?.text).toContain('Hello')
  })

  it('a /compact turn opens on the reply before it, not the compaction alone', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await new Promise((r) => setTimeout(r, 50))

    // The user's /compact: its command, then the boundary and its result.
    await manager.send('s1', '/compact')
    fake.emitLine(JSON.stringify(COMPACT_BOUNDARY))
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await new Promise((r) => setTimeout(r, 100))
    expect(manager.getLog('s1')!.all().some(e => e.type === 'input:sent' && (e.data as { text?: string }).text === '/compact')).toBe(true)

    const { events } = await collectEvents(`${baseUrl}/session/s1/events?after=0`, 50, 1000)

    const text = events.find(e => e.type === 'content')?.data as { blocks?: Array<{ text?: string }> } | undefined
    expect(text?.blocks?.[0]?.text).toContain('Hello')
    expect(events.some(e => e.type === 'turn:end' && (e.data as { compact?: boolean }).compact === true)).toBe(true)
  })

  it('reconnect after compact replays from correct seq', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest

    // Full turn
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await new Promise((r) => setTimeout(r, 50))

    // Get the turn:end seq for reconnect
    const log = manager.getLog('s1')!
    const turnEndSeq = log.all().find(e => e.type === 'turn:end')!.seq

    // Now compact
    fake.emitLine(JSON.stringify(COMPACT_BOUNDARY))
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await new Promise((r) => setTimeout(r, 50))

    // Reconnect with afterSeq = the first turn:end seq
    // (simulates a client that saw the first turn but disconnected before compact)
    const { events } = await collectEvents(
      `${baseUrl}/session/s1/events?after=${turnEndSeq}`,
      10,
      1000,
    )

    // Should get the compact boundary turn:end, run:ready, and result turn:end
    expect(events.length).toBeGreaterThanOrEqual(2)
    const compactTurnEnd = events.find(
      e => e.type === 'turn:end' && (e.data as { compact?: boolean }).compact === true,
    )
    expect(compactTurnEnd).toBeDefined()
  })
})
