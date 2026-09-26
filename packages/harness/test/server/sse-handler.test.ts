import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { createTestServer } from '../helpers/test-server.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS } from '../helpers/fixtures.js'
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

/** Read SSE events from a fetch response until aborted or stream ends. */
async function readSSEEvents(
  url: string,
  signal?: AbortSignal,
): Promise<SessionEvent[]> {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal,
  })
  const events: SessionEvent[] = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop()! // keep partial line

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6))
          if (parsed.seq) events.push(parsed) // skip reset events
        } catch {}
      }
    }
  }

  return events
}

/** Read SSE until we have at least `count` events or timeout. */
async function collectEvents(
  url: string,
  count: number,
  timeoutMs = 2000,
): Promise<{ events: SessionEvent[]; raw: string }> {
  const controller = new AbortController()
  const events: SessionEvent[] = []
  let raw = ''

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
      const chunk = decoder.decode(value, { stream: true })
      raw += chunk
      buffer += chunk

      const lines = buffer.split('\n')
      buffer = lines.pop()!

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.seq) events.push(parsed)
          } catch {}
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
  return { events, raw }
}

describe('SSE handler', () => {
  it('returns reset event for unknown session', async () => {
    const res = await fetch(`${baseUrl}/session/unknown/events`)
    const text = await res.text()
    expect(text).toContain('event: reset')
    expect(text).toContain('"reason":"no_session"')
  })

  it('replays all events when connecting with after=0', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    // Give piping time to process
    await new Promise((r) => setTimeout(r, 50))

    const { events } = await collectEvents(`${baseUrl}/session/s1/events?after=0`, 4)

    expect(events.length).toBeGreaterThanOrEqual(4) // run:start + run:ready + content + turn:end
    expect(events[0].type).toBe('run:start')
    expect(events[0].seq).toBe(1)
  })

  it('replays only events after the given sequence', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await new Promise((r) => setTimeout(r, 50))

    // Connect asking for events after seq 2
    const { events } = await collectEvents(`${baseUrl}/session/s1/events?after=2`, 2)

    expect(events[0].seq).toBeGreaterThan(2)
  })

  it('streams live events to connected clients', async () => {
    await manager.start('s1', { prompt: 'hello' })

    // Start collecting events in background
    const collecting = collectEvents(`${baseUrl}/session/s1/events?after=0`, 3, 3000)

    // Emit events after client connects
    await new Promise((r) => setTimeout(r, 100))
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await new Promise((r) => setTimeout(r, 100))

    const { events } = await collecting
    // Should have at least run:start (from start()) + run:ready + content
    expect(events.length).toBeGreaterThanOrEqual(3)
  })

  it('includes heartbeat comments in the stream', async () => {
    await manager.start('s1', { prompt: 'hello' })

    // Collect raw output for a bit to catch heartbeat (500ms interval in test)
    const { raw } = await collectEvents(
      `${baseUrl}/session/s1/events?after=0`,
      100, // won't reach 100, will timeout
      1200, // wait for 1.2s to catch at least one heartbeat
    )

    expect(raw).toContain(': heartbeat')
  })

  it('supports multiple concurrent SSE clients on same session', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await new Promise((r) => setTimeout(r, 50))

    // Two clients connect simultaneously
    const client1 = collectEvents(`${baseUrl}/session/s1/events?after=0`, 3, 2000)
    const client2 = collectEvents(`${baseUrl}/session/s1/events?after=0`, 3, 2000)

    // Emit more events
    await new Promise((r) => setTimeout(r, 100))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await new Promise((r) => setTimeout(r, 100))

    const [r1, r2] = await Promise.all([client1, client2])

    // Both clients should have received events
    expect(r1.events.length).toBeGreaterThanOrEqual(3)
    expect(r2.events.length).toBeGreaterThanOrEqual(3)
  })

  it('each event has SSE id and event type fields', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await new Promise((r) => setTimeout(r, 50))

    // Read until the first event actually arrives rather than asserting on
    // whatever a single read() happens to return. The stream opens with a
    // replay_meta frame, which lands in its own chunk whenever the two writes
    // don't coalesce — so a one-chunk read saw only replay_meta under suite
    // load, failed on the missing `id:`, and then never reached its
    // reader.cancel(), leaving the connection open until afterEach timed out.
    const { raw } = await collectEvents(`${baseUrl}/session/s1/events?after=0`, 1)

    // Verify SSE format: id: N\nevent: type\ndata: {...}\n\n
    expect(raw).toMatch(/id: \d+/)
    expect(raw).toMatch(/event: run:start/)
    expect(raw).toMatch(/data: \{/)
  })

  it('emits replay_meta before any replay events on cold load', async () => {
    // Order on the wire matters: replay_meta arriving before the events lets
    // the client kick off the /history fetch in parallel with consuming the
    // SSE replay, instead of after. On slow networks this collapses
    // SSE_replay_time + history_fetch_time into max(SSE_replay_time,
    // history_fetch_time) and removes the visible "stops for a bit" pause
    // between scoped-replay events arriving and PREPEND_HISTORY merging in
    // the older turns.
    //
    // Verified empirically via chrome-devtools MCP under Slow 3G: today the
    // pause is ~6s on a 200-event session; with this order the client starts
    // /history at the same instant SSE replay begins.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await new Promise((r) => setTimeout(r, 50))

    const { raw } = await collectEvents(`${baseUrl}/session/s1/events?after=0`, 4, 1500)

    const replayMetaIdx = raw.indexOf('event: replay_meta')
    const firstEventDataIdx = raw.search(/data: \{[^}]*"seq"/)

    expect(replayMetaIdx).toBeGreaterThanOrEqual(0)
    expect(firstEventDataIdx).toBeGreaterThanOrEqual(0)
    expect(replayMetaIdx).toBeLessThan(firstEventDataIdx)
  })

  it('cleans up subscriber on client disconnect', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const log = manager.getLog('s1')!
    expect(log.subscriberCount).toBe(0)

    const controller = new AbortController()
    const fetchPromise = fetch(`${baseUrl}/session/s1/events?after=0`, {
      signal: controller.signal,
    }).catch(() => {})

    // Wait for connection to establish
    await new Promise((r) => setTimeout(r, 100))
    expect(log.subscriberCount).toBe(1)

    // Disconnect
    controller.abort()
    await fetchPromise
    await new Promise((r) => setTimeout(r, 100))

    expect(log.subscriberCount).toBe(0)
  })
})
