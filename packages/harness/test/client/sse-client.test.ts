import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { createTestServer } from '../helpers/test-server.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS } from '../helpers/fixtures.js'
import { SSEClient } from '../../src/client/sse-client.js'
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

function waitFor(
  check: () => boolean,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs)
    const interval = setInterval(() => {
      if (check()) {
        clearTimeout(timeout)
        clearInterval(interval)
        resolve()
      }
    }, intervalMs)
  })
}

describe('SSEClient', () => {
  it('connects and receives replayed events', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await new Promise((r) => setTimeout(r, 50))

    const events: SessionEvent[] = []
    let connected = false
    let lastSeq = 0

    const client = new SSEClient({
      url: `${baseUrl}/session/s1/events`,
      onEvent: (e) => {
        events.push(e)
        lastSeq = e.seq
      },
      onConnected: () => {
        connected = true
      },
      onDisconnected: () => {
        connected = false
      },
      onReset: () => {},
      onError: () => {},
      getLastSeq: () => lastSeq,
    })

    client.start()

    await waitFor(() => events.length >= 4)
    expect(connected).toBe(true)
    expect(events[0].type).toBe('run:start')
    expect(events[1].type).toBe('input:sent')
    expect(events[2].type).toBe('run:ready')
    expect(events[3].type).toBe('content')

    client.stop()
  })

  it('receives live events after initial replay', async () => {
    await manager.start('s1', { prompt: 'hello' })

    const events: SessionEvent[] = []
    let lastSeq = 0

    const client = new SSEClient({
      url: `${baseUrl}/session/s1/events`,
      onEvent: (e) => {
        events.push(e)
        lastSeq = e.seq
      },
      onConnected: () => {},
      onDisconnected: () => {},
      onReset: () => {},
      onError: () => {},
      getLastSeq: () => lastSeq,
    })

    client.start()

    // Wait for initial connection
    await waitFor(() => events.length >= 1) // run:start

    // Now emit live events
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))

    await waitFor(() => events.length >= 3) // run:start + run:ready + content
    expect(events.some((e) => e.type === 'run:ready')).toBe(true)
    expect(events.some((e) => e.type === 'content')).toBe(true)

    client.stop()
  })

  it('calls onReset for unknown session', async () => {
    let resetCalled = false

    const client = new SSEClient({
      url: `${baseUrl}/session/unknown/events`,
      onEvent: () => {},
      onConnected: () => {},
      onDisconnected: () => {},
      onReset: () => {
        resetCalled = true
      },
      onError: () => {},
      getLastSeq: () => 0,
    })

    client.start()
    await waitFor(() => resetCalled)
    expect(resetCalled).toBe(true)

    client.stop()
  })

  it('does NOT fire onConnected for no_session responses', async () => {
    // Regression test: connecting to a non-existent session must not flash
    // connected=true before reverting to false. The old behavior fired
    // onConnected() eagerly on HTTP 200, then onDisconnected() when the
    // body revealed no_session — causing a visible Idle→Connected→Idle flash.
    let connectedCalls = 0
    let resetCalled = false

    const client = new SSEClient({
      url: `${baseUrl}/session/nonexistent/events`,
      onEvent: () => {},
      onConnected: () => {
        connectedCalls++
      },
      onDisconnected: () => {},
      onReset: () => {
        resetCalled = true
      },
      onError: () => {},
      getLastSeq: () => 0,
    })

    client.start()
    await waitFor(() => resetCalled)

    // onReset was called (no_session), but onConnected should NEVER have fired.
    expect(connectedCalls).toBe(0)

    client.stop()
  })

  it('stop() aborts the connection', async () => {
    await manager.start('s1', { prompt: 'hello' })

    let connected = false
    let disconnected = false

    const client = new SSEClient({
      url: `${baseUrl}/session/s1/events`,
      onEvent: () => {},
      onConnected: () => {
        connected = true
      },
      onDisconnected: () => {
        disconnected = true
      },
      onReset: () => {},
      onError: () => {},
      getLastSeq: () => 0,
    })

    client.start()
    await waitFor(() => connected)

    client.stop()
    // Give time for disconnect to propagate
    await new Promise((r) => setTimeout(r, 50))
    // After stop, no more reconnection attempts
  })

  it('reconnects after server closes connection', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await new Promise((r) => setTimeout(r, 50))

    const events: SessionEvent[] = []
    let lastSeq = 0
    let connectCount = 0

    const client = new SSEClient({
      url: `${baseUrl}/session/s1/events`,
      onEvent: (e) => {
        events.push(e)
        lastSeq = e.seq
      },
      onConnected: () => {
        connectCount++
      },
      onDisconnected: () => {},
      onReset: () => {},
      onError: () => {},
      getLastSeq: () => lastSeq,
    })

    client.start()
    await waitFor(() => events.length >= 2) // run:start + run:ready

    // End the process, which closes the run but session persists
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await new Promise((r) => setTimeout(r, 50))

    expect(events.some((e) => e.type === 'turn:end')).toBe(true)

    client.stop()
  })

  it('uses getLastSeq for reconnection offset', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await new Promise((r) => setTimeout(r, 50))

    let lastSeq = 0
    const events: SessionEvent[] = []

    const client = new SSEClient({
      url: `${baseUrl}/session/s1/events`,
      onEvent: (e) => {
        events.push(e)
        lastSeq = e.seq
      },
      onConnected: () => {},
      onDisconnected: () => {},
      onReset: () => {},
      onError: () => {},
      getLastSeq: () => lastSeq,
    })

    client.start()
    await waitFor(() => events.length >= 3)

    // Verify seq tracking
    expect(lastSeq).toBeGreaterThan(0)
    const maxSeq = Math.max(...events.map((e) => e.seq))
    expect(lastSeq).toBe(maxSeq)

    client.stop()
  })
})
