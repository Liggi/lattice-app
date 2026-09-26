/**
 * Regression test: onConnected auto-fetch race + EVENT reducer seq dedup.
 *
 * Reproduces the bug where a user's message appears at the wrong position
 * or is duplicated after sending a message immediately on page load.
 *
 * Two stacked bugs in useSession (use-session.ts), now fixed:
 *
 * Bug 1: The EVENT reducer action appended events without checking for
 *         duplicate seq values. If the same event arrived twice (via
 *         overlapping SSE connections during reconnect), it appeared
 *         twice in the state. Fixed: dedup by existing seq while still
 *         accepting lower-but-novel replay events that arrive after a
 *         higher-seq history page.
 *
 * Bug 2: onConnected fires BEFORE onEvent for the first SSE message
 *         (sse-client.ts lines 180-183). This meant lastSeqRef was always 0
 *         at onConnected time, triggering an unnecessary async history fetch
 *         that raced with SSE event delivery. Fixed: 50ms yield before fetch.
 *
 * Telemetry evidence (conv-4tQK330CBVKu, 2026-04-10):
 *   RESET(count=0), CONNECTED, EVENT(seq=1176),
 *   PREPEND_HISTORY(count=200, seqRange=1..200),
 *   CONNECTED (no preceding DISCONNECTED),
 *   DISCONNECTED, CONNECTED,
 *   EVENT(seq=1177), EVENT(seq=1177) ← duplicate,
 *   EVENT(seq=1178), EVENT(seq=1178) ← duplicate
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { createTestServer } from '../helpers/test-server.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS } from '../helpers/fixtures.js'
import { SSEClient } from '../../src/client/sse-client.js'
import type { SessionEvent } from '../../src/protocol/events.js'

// ---------------------------------------------------------------------------
// Inline reducer — mirrors use-session.ts lines 121-161.
//
// Cannot import directly because use-session.ts depends on React.
// If the source reducer changes, this test must be updated to match.
// ---------------------------------------------------------------------------

const MAX_CLIENT_EVENTS = 2000

interface State {
  events: SessionEvent[]
  lastSeq: number
  connected: boolean
  error: string | null
  sessionId: string | null
}

type Action =
  | { type: 'EVENT'; event: SessionEvent }
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'ERROR'; message: string }
  | { type: 'RESET'; events: SessionEvent[]; sessionId: string | null }
  | { type: 'PREPEND_HISTORY'; events: SessionEvent[] }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'EVENT': {
      if (state.events.some(e => e.seq === action.event.seq)) return state

      if (action.event.seq > state.lastSeq) {
        const next = [...state.events, action.event]
        const trimmed = next.length > MAX_CLIENT_EVENTS
          ? next.slice(next.length - MAX_CLIENT_EVENTS)
          : next
        return { ...state, events: trimmed, lastSeq: action.event.seq }
      }

      const combined = [...state.events, action.event]
      combined.sort((a, b) => a.seq - b.seq)
      const trimmed = combined.length > MAX_CLIENT_EVENTS
        ? combined.slice(combined.length - MAX_CLIENT_EVENTS)
        : combined
      const maxSeq = trimmed.at(-1)?.seq ?? state.lastSeq
      return { ...state, events: trimmed, lastSeq: Math.max(state.lastSeq, maxSeq) }
    }
    case 'CONNECTED':
      return { ...state, connected: true, error: null }
    case 'DISCONNECTED':
      return { ...state, connected: false }
    case 'ERROR':
      return { ...state, error: action.message }
    case 'RESET':
      return {
        ...state,
        events: action.events,
        lastSeq: action.events.at(-1)?.seq ?? 0,
        sessionId: action.sessionId,
      }
    case 'PREPEND_HISTORY':
      if (action.events.length === 0) return state
      {
        const existingSeqs = new Set(state.events.map(e => e.seq))
        const novel = action.events.filter(e => !existingSeqs.has(e.seq))
        if (novel.length === 0) return state
        const combined = [...novel, ...state.events]
        combined.sort((a, b) => a.seq - b.seq)
        const maxSeq = combined.at(-1)?.seq ?? state.lastSeq
        return { ...state, events: combined, lastSeq: Math.max(state.lastSeq, maxSeq) }
      }
  }
}

const initialState: State = {
  events: [],
  lastSeq: 0,
  connected: false,
  error: null,
  sessionId: null,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeEvent(seq: number, type: SessionEvent['type']): SessionEvent {
  return {
    sessionId: 's1',
    runId: 'r1',
    seq,
    timestamp: Date.now(),
    type,
    data: {},
  }
}

function fakeEvents(fromSeq: number, toSeq: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let seq = fromSeq; seq <= toSeq; seq++) {
    events.push(fakeEvent(seq, 'content'))
  }
  return events
}

function countDuplicateSeqs(events: SessionEvent[]): Array<[number, number]> {
  const seqCounts = new Map<number, number>()
  for (const e of events) {
    seqCounts.set(e.seq, (seqCounts.get(e.seq) ?? 0) + 1)
  }
  return [...seqCounts.entries()].filter(([, count]) => count > 1)
}

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

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

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

// ===========================================================================
// Regression: EVENT reducer seq dedup
// ===========================================================================

describe('EVENT reducer seq dedup', () => {
  it('replays the exact telemetry action sequence — duplicate seqs are rejected', () => {
    // Replay the action sequence observed in conv-4tQK330CBVKu (2026-04-10).
    // Before the fix, this produced duplicate events for seqs 1177 and 1178.

    let state = initialState

    // 1. Page loads, SSE effect mounts → empty RESET
    state = reducer(state, { type: 'RESET', events: [], sessionId: 's1' })

    // 2. SSE connects — server scopes replay to last turn only (1 event: run:end)
    state = reducer(state, { type: 'CONNECTED' })
    state = reducer(state, { type: 'EVENT', event: fakeEvent(1176, 'run:end') })

    // 3. onConnected auto-fetch resolves with 200 events from /history
    //    lastSeqRef > 0 → takes PREPEND_HISTORY path
    state = reducer(state, {
      type: 'PREPEND_HISTORY',
      events: fakeEvents(1, 200),
    })

    // Verify state after prepend: seqs 1..200 + 1176, sorted
    expect(state.events).toHaveLength(201)
    expect(state.events[0].seq).toBe(1)
    expect(state.events[200].seq).toBe(1176)

    // 4. Second CONNECTED without preceding DISCONNECTED (dual SSE connection)
    state = reducer(state, { type: 'CONNECTED' })
    state = reducer(state, { type: 'DISCONNECTED' })
    state = reducer(state, { type: 'CONNECTED' })

    // 5. Duplicate EVENTs from dual SSE connections — should be rejected
    state = reducer(state, { type: 'EVENT', event: fakeEvent(1177, 'run:start') })
    state = reducer(state, { type: 'EVENT', event: fakeEvent(1177, 'run:start') })
    state = reducer(state, { type: 'EVENT', event: fakeEvent(1178, 'input:sent') })
    state = reducer(state, { type: 'EVENT', event: fakeEvent(1178, 'input:sent') })

    // No duplicate seqs in the final state
    const duplicates = countDuplicateSeqs(state.events)
    expect(duplicates).toEqual([])
    expect(state.events).toHaveLength(203) // 200 + 1176 + 1177 + 1178
  })

  it('rejects EVENT with same seq as the last processed event', () => {
    let state = initialState
    const event = fakeEvent(1, 'content')

    state = reducer(state, { type: 'EVENT', event })
    state = reducer(state, { type: 'EVENT', event })

    expect(state.events).toHaveLength(1)
  })

  it('accepts lower novel EVENTs and preserves the highest processed seq', () => {
    let state = initialState
    state = reducer(state, { type: 'EVENT', event: fakeEvent(5, 'content') })
    state = reducer(state, { type: 'EVENT', event: fakeEvent(3, 'content') })

    expect(state.events).toHaveLength(2)
    expect(state.events.map(e => e.seq)).toEqual([3, 5])
    expect(state.lastSeq).toBe(5)
  })

  it('accepts lower novel SSE replay events after a high-seq history page wins the race', () => {
    let state = initialState

    // replay_meta is emitted before SSE replay events, so the /history fetch
    // can return the newest page before the replay has delivered its lower
    // seq prefix. These lower seqs are novel and must still be merged.
    state = reducer(state, {
      type: 'PREPEND_HISTORY',
      events: fakeEvents(901, 1000),
    })
    expect(state.lastSeq).toBe(1000)

    state = reducer(state, { type: 'EVENT', event: fakeEvent(1, 'run:start') })
    state = reducer(state, { type: 'EVENT', event: fakeEvent(2, 'input:sent') })

    expect(state.events.slice(0, 2).map(e => e.seq)).toEqual([1, 2])
    expect(state.events.at(-1)?.seq).toBe(1000)
    expect(state.lastSeq).toBe(1000)
  })

  it('allows first EVENT when lastSeq is 0 (initial state)', () => {
    let state = initialState
    state = reducer(state, { type: 'EVENT', event: fakeEvent(1, 'run:start') })

    expect(state.events).toHaveLength(1)
    expect(state.lastSeq).toBe(1)
  })

  it('allows EVENT after RESET sets lastSeq high', () => {
    let state = initialState
    state = reducer(state, { type: 'RESET', events: fakeEvents(1, 10), sessionId: 's1' })
    expect(state.lastSeq).toBe(10)

    // New event with seq > lastSeq passes
    state = reducer(state, { type: 'EVENT', event: fakeEvent(11, 'content') })
    expect(state.events).toHaveLength(11)

    // Duplicate of existing event is rejected
    state = reducer(state, { type: 'EVENT', event: fakeEvent(5, 'content') })
    expect(state.events).toHaveLength(11)
  })
})

// ===========================================================================
// Regression: cache write race can poison another session's cache entry (F3)
//
// On the first render after a sessionId switch, the SSE effect dispatches
// RESET (establishing the new session's state) BEFORE the cache-write effect
// runs — but at that point `state` still holds the PREVIOUS session's events.
// Without a guard, session A's events get written under session B's key.
//
// The fix tracks which session the reducer `state` belongs to (stateSessionIdRef,
// set whenever a RESET is dispatched via the current sessionId) and skips the
// cache write when it doesn't match the current sessionId. This block mirrors
// that mechanism inline — the React hook can't be driven under node:http.
// ===========================================================================

describe('cache write guard (F3)', () => {
  interface CachedSessionState {
    events: SessionEvent[]
    lastSeq: number
  }

  // The cache-write effect body, guarded exactly as in use-session.ts:
  // only write when the reducer state's owning session matches the render's
  // sessionId. `state.sessionId` is set by RESET, so it names the session
  // `state.events` actually belong to, regardless of render timing.
  function writeCacheEffect(
    cache: Map<string, CachedSessionState>,
    sessionId: string | null,
    state: State,
  ) {
    if (state.sessionId !== sessionId) return
    if (!sessionId) return
    cache.set(sessionId, { events: state.events, lastSeq: state.lastSeq })
  }

  it('does not write session A events under session B key on the first render after a switch', () => {
    const cache = new Map<string, CachedSessionState>()

    // Session A: RESET establishes A, events accumulate, cache write lands.
    let state: State = reducer(initialState, { type: 'RESET', events: [], sessionId: 'A' })
    for (let seq = 1; seq <= 5; seq++) {
      state = reducer(state, { type: 'EVENT', event: fakeEvent(seq, 'content') })
    }
    writeCacheEffect(cache, 'A', state)
    expect(cache.get('A')?.events).toHaveLength(5)

    // Switch to B. On the first render after the switch, `sessionId` is already
    // 'B' but the committed `state` is still A's (the SSE effect's RESET for B
    // hasn't re-rendered yet, so state.sessionId is still 'A'). The write effect
    // fires with sessionId='B' + this stale state. Without the guard it would
    // write A's 5 events under key 'B'.
    const staleStateForBRender = state // state.sessionId === 'A'
    writeCacheEffect(cache, 'B', staleStateForBRender)

    // B must NOT have been poisoned with A's events.
    expect(cache.has('B')).toBe(false)
    // A's entry is intact.
    expect(cache.get('A')?.events).toHaveLength(5)

    // Next render: the RESET for B has committed, state.sessionId === 'B'.
    state = reducer(state, { type: 'RESET', events: [], sessionId: 'B' })
    writeCacheEffect(cache, 'B', state)
    expect(cache.get('B')?.events ?? []).toHaveLength(0)
    // A still intact — never overwritten with B's data either.
    expect(cache.get('A')?.events).toHaveLength(5)
  })

  it('the guard skips a write whose state belongs to a different session', () => {
    const cache = new Map<string, CachedSessionState>()

    // State belongs to A.
    const stateA = reducer(initialState, { type: 'RESET', events: fakeEvents(1, 5), sessionId: 'A' })

    // A write effect fires for the new session B while state still belongs to A.
    writeCacheEffect(cache, 'B', stateA)
    expect(cache.has('B')).toBe(false)

    // Once B's RESET commits, the write lands under B.
    const stateB = reducer(stateA, { type: 'RESET', events: fakeEvents(10, 12), sessionId: 'B' })
    writeCacheEffect(cache, 'B', stateB)
    expect(cache.get('B')?.events).toHaveLength(3)
  })
})

// ===========================================================================
// Regression: PREPEND_HISTORY sorts combined array
// ===========================================================================

describe('PREPEND_HISTORY sorts combined events by seq', () => {
  it('handles history events that interleave with existing events', () => {
    let state = initialState
    // SSE delivered events 6-10
    for (let seq = 6; seq <= 10; seq++) {
      state = reducer(state, { type: 'EVENT', event: fakeEvent(seq, 'content') })
    }

    // History returns events 1-10 (overlaps 6-10 + adds 1-5).
    // A race could also include event 11 written to storage between
    // SSE replay and fetch resolution.
    state = reducer(state, {
      type: 'PREPEND_HISTORY',
      events: [...fakeEvents(1, 10), fakeEvent(11, 'content')],
    })

    // All unique events present, in ascending seq order
    expect(state.events).toHaveLength(11)
    for (let i = 0; i < state.events.length; i++) {
      expect(state.events[i].seq).toBe(i + 1)
    }
  })
})

// ===========================================================================
// onConnected fires before first onEvent
// ===========================================================================

describe('onConnected timing', () => {
  it('at onConnected time, lastSeq is still 0 — the root cause of the auto-fetch race', async () => {
    // Create a completed single-turn session with events in the EventLog.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    fake.exit(0)
    await new Promise(r => setTimeout(r, 100))

    // Connect a NEW SSE client (simulating page load).
    const callOrder: Array<{ callback: string; lastSeqSnapshot: number }> = []
    let lastSeq = 0

    const client = new SSEClient({
      url: `${baseUrl}/session/s1/events`,
      onEvent: (event) => {
        lastSeq = event.seq
        callOrder.push({ callback: 'event', lastSeqSnapshot: lastSeq })
      },
      onConnected: () => {
        callOrder.push({ callback: 'connected', lastSeqSnapshot: lastSeq })
      },
      onDisconnected: () => {},
      onReset: () => {},
      onError: () => {},
      getLastSeq: () => lastSeq,
    })

    client.start()
    await waitFor(() => callOrder.some(e => e.callback === 'event'))

    const connectedEntry = callOrder.find(e => e.callback === 'connected')
    expect(connectedEntry).toBeDefined()

    // onConnected fires BEFORE the first onEvent. At that moment,
    // lastSeq is still 0 — which is what triggers the auto-fetch.
    // The fix defers the fetch by 50ms so SSE replay events arrive first.
    const connectedIdx = callOrder.findIndex(e => e.callback === 'connected')
    const firstEventIdx = callOrder.findIndex(e => e.callback === 'event')
    expect(connectedIdx).toBeLessThan(firstEventIdx)
    expect(connectedEntry!.lastSeqSnapshot).toBe(0)

    client.stop()
  })

  it('deferred auto-fetch is skipped when SSE replay delivers events', async () => {
    // Create a completed two-turn session.
    await manager.start('s1', { prompt: 'turn 1' })
    let fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    fake.exit(0)
    await new Promise(r => setTimeout(r, 100))

    await manager.send('s1', 'turn 2')
    fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    fake.exit(0)
    await new Promise(r => setTimeout(r, 100))

    // Simulate the useSession flow: SSE + deferred auto-fetch.
    let state = initialState
    let lastSeq = 0
    let autoFetchStarted = false
    let autoFetchSkipped = false

    const client = new SSEClient({
      url: `${baseUrl}/session/s1/events`,
      onEvent: (event) => {
        lastSeq = event.seq
        state = reducer(state, { type: 'EVENT', event })
      },
      onConnected: () => {
        state = reducer(state, { type: 'CONNECTED' })

        // Mirrors the fixed useSession onConnected logic:
        // yield 50ms, then check if SSE events arrived.
        if (lastSeq === 0) {
          autoFetchStarted = true
          void (async () => {
            await new Promise(r => setTimeout(r, 50))
            if (lastSeq > 0) {
              autoFetchSkipped = true
              return
            }
            // Would fetch history here, but SSE should deliver events first
          })()
        }
      },
      onDisconnected: () => {
        state = reducer(state, { type: 'DISCONNECTED' })
      },
      onReset: () => {},
      onError: () => {},
      getLastSeq: () => lastSeq,
    })

    client.start()

    // Wait for events + the 50ms deferral to resolve
    await waitFor(() => autoFetchSkipped || state.events.length > 0, 3000)
    await new Promise(r => setTimeout(r, 100))

    // The auto-fetch was initiated (lastSeq was 0 at onConnected time)
    // but skipped after 50ms because SSE replay updated lastSeq.
    expect(autoFetchStarted).toBe(true)
    expect(autoFetchSkipped).toBe(true)

    // SSE delivered events, no duplicates
    expect(state.events.length).toBeGreaterThan(0)
    expect(countDuplicateSeqs(state.events)).toEqual([])

    client.stop()
  })
})

// ===========================================================================
// End-to-end: dual SSE connections + reducer dedup
// ===========================================================================

describe('Dual SSE connections with reducer dedup', () => {
  it('two active SSE connections — reducer rejects duplicate events', async () => {
    // Two SSE connections to the same session deliver every event twice
    // at the transport level. The reducer's seq dedup is the last line
    // of defense — it must reject the duplicate.

    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await new Promise(r => setTimeout(r, 50))

    // Shared state — both clients dispatch to the same reducer,
    // just like the real useSession where both clients close over
    // the same tracedDispatch.
    let state = initialState
    let lastSeq = 0

    function onEvent(event: SessionEvent) {
      state = reducer(state, { type: 'EVENT', event })
      lastSeq = Math.max(lastSeq, event.seq)
    }

    function makeClient(): SSEClient {
      return new SSEClient({
        url: `${baseUrl}/session/s1/events`,
        onEvent,
        onConnected: () => { state = reducer(state, { type: 'CONNECTED' }) },
        onDisconnected: () => { state = reducer(state, { type: 'DISCONNECTED' }) },
        onReset: () => {},
        onError: () => {},
        getLastSeq: () => lastSeq,
      })
    }

    // Connect client #1
    const client1 = makeClient()
    client1.start()
    await waitFor(() => state.events.length >= 3)

    // Connect client #2 WITHOUT stopping client #1 (the race window).
    const client2 = makeClient()
    client2.start()
    await new Promise(r => setTimeout(r, 200))

    // Clear state for the new event test — only care about live events
    const seqsBefore = state.events.length
    state = reducer(state, { type: 'RESET', events: state.events, sessionId: 's1' })

    // Emit a new event. Both clients receive it at the transport level.
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await new Promise(r => setTimeout(r, 300))

    // The reducer must have rejected the duplicate — no duplicate seqs.
    const duplicates = countDuplicateSeqs(state.events)
    expect(duplicates).toEqual([])

    client1.stop()
    client2.stop()
  })
})
