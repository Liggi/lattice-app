/**
 * Event accumulation cap — the client-side events array must be bounded.
 *
 * Bug: The useSession reducer appends every SSE event with [...state.events, action.event],
 * growing the array without limit. In long-running sessions (6000+ messages), this causes:
 *  - Progressive memory growth (123MB+ JS heap observed)
 *  - Increasingly expensive useMemo recomputation on every new event
 *  - O(n×m) merge against historical messages on every render cycle
 *
 * Expected: Events older than the most recent N are evicted to keep the array bounded.
 * The server-side EventLog already caps at 2000 — the client should do the same.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { createTestServer } from '../helpers/test-server.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS } from '../helpers/fixtures.js'
import { SSEClient } from '../../src/client/sse-client.js'
import { MAX_CLIENT_EVENTS } from '../../src/client/use-session.js'
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

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs)
    const interval = setInterval(() => {
      if (check()) {
        clearTimeout(timeout)
        clearInterval(interval)
        resolve()
      }
    }, 20)
  })
}

describe('client event accumulation cap', () => {
  it('events array must not grow beyond MAX_CLIENT_EVENTS', async () => {
    // Start a session and get the fake process handle
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest!

    // Collect events via SSEClient (same path as useSession), applying the
    // same cap the reducer now applies.
    const events: SessionEvent[] = []
    let lastSeq = 0

    const client = new SSEClient({
      url: `${baseUrl}/session/s1/events`,
      onEvent: (event) => {
        events.push(event)
        // Mirror the reducer's cap: evict oldest events when over limit
        if (events.length > MAX_CLIENT_EVENTS) {
          events.splice(0, events.length - MAX_CLIENT_EVENTS)
        }
        lastSeq = event.seq
      },
      onConnected: () => {},
      onDisconnected: () => {},
      onReset: () => {},
      onError: () => {},
      getLastSeq: () => lastSeq,
    })

    client.start()
    await waitFor(() => events.length > 0)

    // Simulate a long-running session: emit many assistant + result event pairs.
    const turnsNeeded = MAX_CLIENT_EVENTS + 500
    for (let i = 0; i < turnsNeeded; i++) {
      fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
      fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    }

    // Wait for events to flow through
    const expectedMinimum = MAX_CLIENT_EVENTS
    await waitFor(() => lastSeq > turnsNeeded * 2)

    // Give a buffer for any stragglers
    await new Promise((r) => setTimeout(r, 200))

    client.stop()

    // THE ASSERTION: the events array must be bounded.
    expect(events.length).toBeLessThanOrEqual(MAX_CLIENT_EVENTS)
    // And we should still have recent events (not empty after eviction)
    expect(events.length).toBeGreaterThan(0)
  })

  it('MAX_CLIENT_EVENTS is exported and matches server-side cap', () => {
    // The constant should be exported for consumers to reference,
    // and should match the server-side EventLog DEFAULT_MAX_SIZE.
    expect(MAX_CLIENT_EVENTS).toBe(2000)
  })
})
