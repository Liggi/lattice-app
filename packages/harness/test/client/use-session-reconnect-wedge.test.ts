/**
 * Regression test: hydration wedge after mid-replay disconnect + reconnect.
 *
 * Symptom on mobile (and reproducible elsewhere via flaky network):
 *
 *   1. The session loads but no thinking indicator appears even when the
 *      server is actively streaming.
 *   2. Different refreshes show different "positions" of the conversation —
 *      sometimes only the most recent turn is visible.
 *
 * Both symptoms have one root cause: hydrationPhase gets stuck at 'hydrating'
 * after a mid-replay disconnect + reconnect, because:
 *
 *   - The `onConnected` 50ms IIFE in use-session.ts only sets the hydration
 *     checkpoint when it actually runs the history backfill — and after a
 *     disconnect with events in hand (lastSeq > 0), the IIFE doesn't run
 *     at all on the reconnect (`if (lastSeqRef.current === 0)` is false).
 *   - The server only emits `replay_meta` on the cold-load path
 *     (`afterSeq === 0` in sse-handler.ts:123). On reconnect with
 *     afterSeq > 0, no replay_meta is sent. So `onReplayMeta` doesn't
 *     fire either.
 *
 * Result: nothing sets `hydrationCheckpointReachedRef.current = true`, so
 * `maybeFinishHydration` is a no-op forever.
 *
 * Downstream consequences:
 *   - latticeStatus is clamped to 'idle' (useHarnessSession.ts:113), hiding
 *     the thinking indicator on a server-active session.
 *   - The scoped-history fetch path inside `onReplayMeta` never runs, so
 *     older turns are never backfilled — the user sees only the most recent
 *     turn (whatever the initial scoped SSE replay delivered before the drop).
 *
 * This test mirrors `useSession`'s hydration state machine inline (matching
 * the existing pattern in use-session-race.test.ts — the React hook itself
 * can't be driven without jsdom, which conflicts with node:http) and walks
 * through the exact two-connection sequence that produces the wedge.
 *
 * Empirical reproduction confirmed via chrome-devtools MCP on a running
 * Lattice instance 2026-05-07: stripping `replay_meta` from the SSE response
 * left `__latticeDebug.hydrationPhase === 'hydrating'` indefinitely with
 * `eventCount: 6` (only the scoped replay's most-recent turn) where the
 * baseline showed `hydrationPhase === 'ready'` and `eventCount: 16` (full
 * conversation via `PREPEND_HISTORY`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { createTestServer } from '../helpers/test-server.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS } from '../helpers/fixtures.js'
import { SSEClient } from '../../src/client/sse-client.js'
import type { SessionEvent } from '../../src/protocol/events.js'
import type { ReplayMeta } from '../../src/protocol/sse.js'

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
})

afterEach(async () => {
  server.closeAllConnections()
  await close().catch(() => {})
})

function waitFor(check: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
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

describe('Hydration wedge after mid-replay disconnect + reconnect', () => {
  it('hydration completes and full history is recovered after reconnect with afterSeq > 0', async () => {
    // Build a 2-turn completed session. After this setup, the EventLog has
    // ~10 events spread across two turn boundaries. The SSE handler scopes
    // the initial replay to the most recent turn only — the older turn is
    // only delivered to the client via the `replay_meta`-triggered scoped
    // history fetch.
    await manager.start('s1', { prompt: 'turn 1' })
    let fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    fake.exit(0)
    await new Promise(r => setTimeout(r, 50))

    await manager.send('s1', 'turn 2')
    fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    fake.exit(0)
    await new Promise(r => setTimeout(r, 50))

    // Sanity: server has multiple turn boundaries
    const log = manager.getLog('s1')!
    const allSeqs = [...log.all()].map(e => e.seq)
    expect(allSeqs.length).toBeGreaterThan(5)
    const firstSeq = allSeqs[0]

    // ---- Inline hydration state machine (mirrors use-session.ts) ----
    const events: SessionEvent[] = []
    let lastSeq = 0
    let pending = 0
    let checkpointReached = false
    let hydrationPhase: 'hydrating' | 'ready' = 'hydrating'

    function maybeFinishHydration() {
      if (!checkpointReached) return
      if (pending > 0) return
      hydrationPhase = 'ready'
    }

    function pushEvent(event: SessionEvent) {
      if (lastSeq > 0 && event.seq <= lastSeq) return
      events.push(event)
      lastSeq = event.seq
    }

    // First connection drops replay_meta (simulating a mid-replay network drop:
    // the server has emitted the events but the connection died before the
    // replay_meta frame was processed by the client). After the drop, the
    // SSE client reconnects — that reconnect is what the second SSEClient
    // below stands in for. The server side will see afterSeq > 0 and skip
    // replay_meta entirely, so the second connection won't fire onReplayMeta
    // either. Both paths to the checkpoint are closed.
    let connectionIdx = 0

    function makeClient(): SSEClient {
      const myConnIdx = connectionIdx++
      return new SSEClient({
        url: `${baseUrl}/session/s1/events`,
        onEvent: (event) => {
          pushEvent(event)
        },
        onConnected: () => {
          // Mirror use-session.ts onConnected IIFE
          if (lastSeq === 0) {
            pending++
            void (async () => {
              let attemptedBackfill = false
              try {
                await new Promise(r => setTimeout(r, 50))
                if (lastSeq > 0) return
                attemptedBackfill = true
                const resp = await fetch(
                  `${baseUrl}/session/s1/history?before=${Number.MAX_SAFE_INTEGER}&limit=200`,
                )
                if (resp.ok) {
                  const data = (await resp.json()) as { events: SessionEvent[]; hasMore: boolean }
                  if (data.events.length > 0 && lastSeq === 0) {
                    for (const e of data.events) pushEvent(e)
                  }
                }
              } finally {
                pending--
                if (attemptedBackfill) checkpointReached = true
                maybeFinishHydration()
              }
            })()
          }
        },
        onReplayMeta: (meta: ReplayMeta) => {
          // Drop on the very first connection — stand-in for the mid-replay
          // network drop. After the fix, even if this drop happens, the
          // SUBSEQUENT reconnect should still get the client to 'ready'.
          if (myConnIdx === 0) return

          checkpointReached = true
          if (!meta.scoped) {
            maybeFinishHydration()
            return
          }
          pending++
          void (async () => {
            try {
              const resp = await fetch(
                `${baseUrl}/session/s1/history?before=${Number.MAX_SAFE_INTEGER}&limit=200`,
              )
              if (resp.ok) {
                const data = (await resp.json()) as { events: SessionEvent[] }
                const known = new Set(events.map(e => e.seq))
                for (const e of data.events) {
                  if (!known.has(e.seq)) {
                    events.push(e)
                    known.add(e.seq)
                  }
                }
                events.sort((a, b) => a.seq - b.seq)
                if (events.length > 0) lastSeq = Math.max(lastSeq, events.at(-1)!.seq)
              }
            } finally {
              pending--
              maybeFinishHydration()
            }
          })()
        },
        onDisconnected: () => {},
        onReset: () => {},
        onError: () => {},
        getLastSeq: () => lastSeq,
      })
    }

    // ---- First connection: receive scoped SSE replay, drop replay_meta ----
    const client1 = makeClient()
    client1.start()
    await waitFor(() => events.length > 0)
    // Wait long enough for the IIFE setTimeout(50) to settle
    await new Promise(r => setTimeout(r, 80))
    client1.stop()
    await new Promise(r => setTimeout(r, 30))

    // Pre-conditions for the bug: events received, but checkpoint never reached
    expect(events.length).toBeGreaterThan(0)
    expect(lastSeq).toBeGreaterThan(0)
    expect(checkpointReached).toBe(false)
    expect(hydrationPhase).toBe('hydrating')

    const seqsBeforeReconnect = events.map(e => e.seq).sort((a, b) => a - b)
    // The scoped replay only delivered the most recent turn — older events
    // (including seq=firstSeq, the run:start of the first turn) are missing.
    expect(seqsBeforeReconnect[0]).toBeGreaterThan(firstSeq)

    // ---- Second connection: SSE reconnect with afterSeq > 0 ----
    const client2 = makeClient()
    client2.start()

    // Wait long enough for any reconnect-triggered work (replay_meta path or
    // backfill) to complete. 500ms is generous — the IIFE 50ms + a fetch round
    // trip to localhost is well under that.
    await new Promise(r => setTimeout(r, 500))
    client2.stop()

    // ---- Post-fix invariants ----
    // 1. Hydration completes — latticeStatus stops being clamped to 'idle'.
    expect(hydrationPhase).toBe('ready')

    // 2. The full conversation history is recovered — the older turn that
    //    was clipped from the initial scoped replay is fetched on reconnect.
    expect(events.find(e => e.seq === firstSeq)).toBeDefined()
  })
})
