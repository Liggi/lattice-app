/**
 * SSEClient duplicate event regression test.
 *
 * Bug: the visibility handler calls connectLoop() while an existing instance
 * is sleeping in reconnection backoff. This creates two concurrent loops,
 * each establishing its own SSE connection. Both subscribe to the same
 * server-side EventLog, so every event is delivered twice.
 *
 * Trigger sequence:
 *   1. SSE connection drops (server restart, network blip)
 *   2. connectLoop catches the error, enters backoff sleep
 *   3. Tab goes hidden → visible (user alt-tabs)
 *   4. Visibility handler: controller.signal.aborted is true → starts second loop
 *   5. Both loops connect → two SSE streams → double events
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { createTestServer } from '../helpers/test-server.js'
import { INIT_EVENT, TEXT_ASSISTANT } from '../helpers/fixtures.js'
import { SSEClient } from '../../src/client/sse-client.js'
import type { SessionEvent } from '../../src/protocol/events.js'

// --- Minimal document mock for visibility handler ---
// SSEClient.setupVisibilityHandler() checks typeof document === 'undefined'
// and registers a visibilitychange listener. We mock just enough to trigger it.

let visibilityListeners: Array<() => void> = []
let documentHidden = false

beforeAll(() => {
  // @ts-expect-error — minimal mock
  globalThis.document = {
    get hidden() {
      return documentHidden
    },
    addEventListener(event: string, handler: () => void) {
      if (event === 'visibilitychange') visibilityListeners.push(handler)
    },
    removeEventListener(event: string, handler: () => void) {
      if (event === 'visibilitychange') {
        visibilityListeners = visibilityListeners.filter((h) => h !== handler)
      }
    },
  }
})

afterAll(() => {
  // @ts-expect-error — cleanup
  delete globalThis.document
})

// --- Test infrastructure ---

let adapter: FakeAdapter
let manager: SessionManager
let baseUrl: string
let server: import('node:http').Server
let close: () => Promise<void>

beforeEach(async () => {
  adapter = new FakeAdapter()
  manager = new SessionManager(adapter)
  const s = await createTestServer(manager)
  baseUrl = s.baseUrl
  server = s.server
  close = s.close
  visibilityListeners = []
  documentHidden = false
})

afterEach(async () => {
  // The duplicate connectLoop bug means stop() can't cleanly abort both loops.
  // Force-destroy all connections so the server can close.
  server.closeAllConnections()
  await close().catch(() => {})
})

function waitFor(check: () => boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
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

function fireVisibilityChange(hidden: boolean): void {
  documentHidden = hidden
  for (const listener of visibilityListeners) listener()
}

describe('SSEClient — no duplicate events on visibility reconnect', () => {
  it('tab hidden→visible during reconnection backoff must not cause duplicate events', async () => {
    // Setup: start a session and emit initial events
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await new Promise((r) => setTimeout(r, 50))

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
    await waitFor(() => events.length >= 3) // run:start + input:sent + run:ready (or content)

    const eventsBeforeDisconnect = events.length

    // Simulate connection drop: abort the active controller.
    // connectLoop catches the AbortError and enters backoff sleep (~2s).
    const controller = (client as any).controller as AbortController
    controller.abort()

    // Wait for connectLoop to enter the catch block and start sleeping
    await new Promise((r) => setTimeout(r, 200))

    // Simulate tab hidden → visible. The visibility handler checks
    // this.controller.signal.aborted (true, from our abort above)
    // and calls connectLoop() — creating a second concurrent loop.
    fireVisibilityChange(true)
    await new Promise((r) => setTimeout(r, 50))
    fireVisibilityChange(false)

    // Wait for the visibility-triggered loop to connect (immediate),
    // plus the original loop to wake from backoff and reconnect (~2s).
    await new Promise((r) => setTimeout(r, 3000))

    // Clear events from reconnection replay — we only care about NEW events
    events.length = 0

    // Emit a new event. If two SSE connections exist, onEvent fires twice.
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await new Promise((r) => setTimeout(r, 300))

    // Count how many times each seq appears
    const seqCounts = new Map<number, number>()
    for (const e of events) {
      seqCounts.set(e.seq, (seqCounts.get(e.seq) ?? 0) + 1)
    }

    const duplicatedSeqs = [...seqCounts.entries()].filter(([, count]) => count > 1)

    // ASSERTION: each event seq should appear exactly once.
    // With the bug, events arrive twice (one per SSE connection).
    expect(duplicatedSeqs).toEqual([])

    client.stop()
  })
})
