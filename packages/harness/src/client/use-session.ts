import { useReducer, useEffect, useRef, useMemo, useCallback, useState } from 'react'
import { deriveStatus, deriveActivity, deriveProcessAlive, deriveUsage } from '../protocol/derive.js'
import type { Status, Activity, TurnUsage } from '../protocol/derive.js'
import type { SessionEvent } from '../protocol/events.js'
import { SSEClient } from './sse-client.js'

/**
 * Maximum number of events retained in the client-side events array.
 * Matches the server-side EventLog DEFAULT_MAX_SIZE (2000).
 * Older events are evicted from the front to keep memory bounded.
 */
export const MAX_CLIENT_EVENTS = 2000

/** Maximum number of reducer actions retained in the diagnostic trace. */
const MAX_ACTION_TRACE = 50
const MAX_CACHED_SESSIONS = 20

interface CachedSessionState {
  events: SessionEvent[]
  lastSeq: number
  hydrationPhase: HydrationPhase
}

const sessionCache = new Map<string, CachedSessionState>()

function trimEvents(events: SessionEvent[]): SessionEvent[] {
  return events.length > MAX_CLIENT_EVENTS
    ? events.slice(events.length - MAX_CLIENT_EVENTS)
    : events
}

function readCachedSession(sessionId: string | null): CachedSessionState | null {
  if (!sessionId) return null
  const cached = sessionCache.get(sessionId)
  if (!cached) return null

  // Refresh insertion order for simple LRU eviction.
  sessionCache.delete(sessionId)
  sessionCache.set(sessionId, cached)
  return cached
}

function writeCachedSession(
  sessionId: string | null,
  state: State,
  hydrationPhase: HydrationPhase,
): void {
  if (!sessionId) return
  sessionCache.set(sessionId, {
    events: trimEvents(state.events),
    lastSeq: state.lastSeq,
    hydrationPhase,
  })

  while (sessionCache.size > MAX_CACHED_SESSIONS) {
    const oldest = sessionCache.keys().next().value
    if (!oldest) break
    sessionCache.delete(oldest)
  }
}

function initialStateForSession(sessionId: string | null): State {
  const cached = readCachedSession(sessionId)
  if (!cached) return { ...initialState, sessionId }
  return {
    events: cached.events,
    lastSeq: cached.lastSeq,
    connected: false,
    error: null,
    sessionId,
  }
}

// ---- Action trace (diagnostic) ----

export interface ActionTraceEntry {
  /** Reducer action type */
  action: Action['type']
  /** Wall-clock timestamp */
  ts: number
  /** Action-specific detail for diagnostics */
  detail?: string
}

/** Circular buffer of recent reducer actions for diagnosing state anomalies. */
class ActionTrace {
  private entries: ActionTraceEntry[] = []

  record(action: Action): void {
    let detail: string | undefined
    switch (action.type) {
      case 'EVENT':
        detail = `seq=${action.event.seq} type=${action.event.type}`
        break
      case 'RESET':
        detail = `count=${action.events.length} seqRange=${action.events[0]?.seq ?? '-'}..${action.events.at(-1)?.seq ?? '-'}`
        break
      case 'PREPEND_HISTORY':
        detail = `count=${action.events.length} seqRange=${action.events[0]?.seq ?? '-'}..${action.events.at(-1)?.seq ?? '-'}`
        break
      case 'ERROR':
        detail = action.message
        break
    }
    this.entries.push({ action: action.type, ts: Date.now(), detail })
    if (this.entries.length > MAX_ACTION_TRACE) {
      this.entries.splice(0, this.entries.length - MAX_ACTION_TRACE)
    }
  }

  snapshot(): ActionTraceEntry[] {
    return [...this.entries]
  }
}

// ---- Public types ----

export interface SessionOptions {
  baseUrl: string
  onEvent?: (event: SessionEvent) => void
  onStatusChange?: (from: Status, to: Status) => void
  onReset?: () => SessionEvent[] | Promise<SessionEvent[]>
}

export interface HistoryPage {
  events: SessionEvent[]
  hasMore: boolean
}

/**
 * Hydration phase for a session handle.
 *
 * - `hydrating`: the client is still catching up on session state. The
 *   initial SSE replay may not have arrived yet, or the follow-up history
 *   backfill triggered by scoped replay metadata is still in flight.
 *   Consumers should treat messages/events arriving in this phase as
 *   "catch-up," not as live events — in particular, entry animations and
 *   scroll-up pagination should be suppressed.
 * - `ready`: the session is caught up and awaiting either live events from
 *   the server or explicit user action. Arrivals after this point are
 *   semantically "live" and may be animated.
 *
 * The transition fires once, after both (a) SSE has connected and (b) every
 * hydration-phase backfill task known to this hook has resolved.
 */
export type HydrationPhase = 'hydrating' | 'ready'

export interface SessionHandle {
  status: Status
  activity: Activity
  error: string | null
  events: SessionEvent[]
  connected: boolean
  /** See {@link HydrationPhase}. Transitions `hydrating` → `ready` once after
   *  initial SSE replay and any scoped backfill resolve. Does not flip back
   *  on reconnect — a brief drop doesn't reset "catch-up" semantics. */
  hydrationPhase: HydrationPhase
  /** Whether the CLI process is alive, derived from the event log.
   *  Distinct from `connected` (SSE transport) — the process can die
   *  while the SSE stays connected to the EventLog. */
  processAlive: boolean
  /** Most recent turn's token usage (input/output/cache tokens + cost).
   *  Derived from the latest `turn:end` event carrying usage data. */
  usage: TurnUsage | null
  /** Diagnostic trace of recent reducer actions. Read-only snapshot for
   *  anomaly detection (e.g., duplicate message diagnosis). */
  actionTrace: ActionTraceEntry[]
  send: (input: string, extra?: Record<string, unknown>) => Promise<void>
  /** Compact the current provider context without creating a user message. */
  compact: () => Promise<void>
  stop: () => Promise<void>
  /** Force the SSE client to reconnect. Call after creating a harness session
   *  (e.g., after resume) so the client picks up the new session's events. */
  reconnect: () => void
  /** Push a synthetic event into the local event stream. Useful for optimistic
   *  updates (e.g., showing a user message immediately before the server echoes
   *  it back via SSE). The event is treated identically to a server-delivered event. */
  injectEvent: (event: SessionEvent) => void
  /** Load older events from the server's persistent storage.
   *  Events are prepended to the front of the events array.
   *  Returns { hasMore } indicating if more history is available. */
  fetchHistory: (opts?: { limit?: number }) => Promise<{ hasMore: boolean }>
}

// ---- Reducer ----

interface State {
  events: SessionEvent[]
  lastSeq: number
  connected: boolean
  error: string | null
  /** Which session `events` belong to. Set by RESET, carried by every other
   *  action. The cache-write effect compares this to the current sessionId so
   *  a stale-state render on the first commit after a session switch can't
   *  write session A's events under session B's key. */
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
      // Dedup by identity, not by seq watermark. Initial replay and the
      // replay_meta-triggered history fetch intentionally run in parallel; the
      // history page can contain higher seqs before lower, still-novel SSE
      // replay events arrive. A seq watermark would drop that replay prefix and
      // leave the UI showing only the newest slice of long Codex turns.
      if (state.events.some(e => e.seq === action.event.seq)) return state

      if (action.event.seq > state.lastSeq) {
        const next = [...state.events, action.event]
        const trimmed = trimEvents(next)
        return {
          ...state,
          events: trimmed,
          lastSeq: action.event.seq,
        }
      }

      const combined = [...state.events, action.event]
      combined.sort((a, b) => a.seq - b.seq)
      const trimmed = trimEvents(combined)
      const maxSeq = trimmed.at(-1)?.seq ?? state.lastSeq
      return {
        ...state,
        events: trimmed,
        lastSeq: Math.max(state.lastSeq, maxSeq),
      }
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
      // Merge older events, deduping by seq and sorting by seq ascending.
      // Sort is defensive: if the history fetch returns events that
      // interleave with existing events (e.g., new events written to
      // storage between SSE replay and fetch), plain prepend would
      // produce out-of-order state.
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

// ---- Hook ----

export function useSession(
  sessionId: string | null,
  options: SessionOptions,
): SessionHandle {
  const [state, dispatch] = useReducer(reducer, sessionId, initialStateForSession)
  const clientRef = useRef<SSEClient | null>(null)
  const prevStatusRef = useRef<Status>('idle')
  const initialCachedState = readCachedSession(sessionId)
  const lastSeqRef = useRef(initialCachedState?.lastSeq ?? state.lastSeq)
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Diagnostic action trace — lives outside React state to avoid re-renders.
  const actionTraceRef = useRef(new ActionTrace())
  const tracedDispatch = useCallback((action: Action) => {
    actionTraceRef.current.record(action)
    dispatch(action)
  }, [])

  // History pagination state lives in refs, not in `fetchHistory`'s closure.
  // The previous implementation captured `state.events` in a useCallback dep,
  // which meant an IntersectionObserver firing with a stale callback could
  // request `/history?before=<old_seq>`, get only events the client already
  // had, and silently see no change after PREPEND_HISTORY's dedup — making
  // scroll-up "sometimes do nothing." Refs are read at call time, not at
  // closure-capture time.
  const earliestSeqRef = useRef(0)
  const historyInFlightRef = useRef<Promise<{ hasMore: boolean }> | null>(null)
  const fetchHistorySessionRef = useRef<string | null>(null)
  if (fetchHistorySessionRef.current !== sessionId) {
    fetchHistorySessionRef.current = sessionId
    earliestSeqRef.current = 0
    historyInFlightRef.current = null
  } else {
    earliestSeqRef.current = state.events[0]?.seq ?? 0
  }

  // Incrementing this key forces the SSE effect to re-run, creating a fresh client.
  const [connectKey, setConnectKey] = useState(0)

  // Track previous sessionId to distinguish session changes from reconnects.
  const prevSessionIdRef = useRef<string | null>(null)

  // Hydration phase — see HydrationPhase docs. Starts as 'hydrating' on every
  // new session and transitions to 'ready' exactly once, after SSE connects
  // and every known backfill task has resolved.
  const [hydrationPhase, setHydrationPhase] = useState<HydrationPhase>(
    initialCachedState?.hydrationPhase ?? 'hydrating',
  )
  const pendingHydrationTasksRef = useRef(0)
  // Latched signal: we've seen enough of the connect sequence that an empty
  // pendingTasks counter means hydration is genuinely done (rather than just
  // "nothing started yet"). Flipped true the first time we observe either
  // replay_meta OR the onConnected backfill IIFE resolving.
  const hydrationCheckpointReachedRef = useRef(false)
  const maybeFinishHydration = useCallback(() => {
    if (!hydrationCheckpointReachedRef.current) return
    if (pendingHydrationTasksRef.current > 0) return
    setHydrationPhase('ready')
  }, [])

  // Manage SSE connection lifecycle
  useEffect(() => {
    if (!sessionId) {
      tracedDispatch({ type: 'RESET', events: [], sessionId: null })
      lastSeqRef.current = 0
      prevSessionIdRef.current = null
      return
    }

    // Only reset events when switching to a different session, not on reconnect
    // (connectKey change). Reconnects should resume from where the client left off
    // so accumulated events survive across SSE connection cycles.
    const isNewSession = sessionId !== prevSessionIdRef.current
    prevSessionIdRef.current = sessionId

    if (isNewSession) {
      pendingHydrationTasksRef.current = 0
      const cached = readCachedSession(sessionId)
      if (cached) {
        tracedDispatch({ type: 'RESET', events: cached.events, sessionId })
        lastSeqRef.current = cached.lastSeq
        hydrationCheckpointReachedRef.current = true
        setHydrationPhase(cached.hydrationPhase)
      } else {
        tracedDispatch({ type: 'RESET', events: [], sessionId })
        lastSeqRef.current = 0
        // Every uncached new session starts unhydrated. We intentionally don't
        // flip this on reconnect — a dropped SSE shouldn't reset "catch-up"
        // semantics for events we already have locally.
        hydrationCheckpointReachedRef.current = false
        setHydrationPhase('hydrating')
      }
    }

    const client = new SSEClient({
      url: `${options.baseUrl}/${sessionId}/events`,
      onEvent: (event) => {
        lastSeqRef.current = Math.max(lastSeqRef.current, event.seq)
        tracedDispatch({ type: 'EVENT', event })
        optionsRef.current.onEvent?.(event)
      },
      onConnected: () => {
        tracedDispatch({ type: 'CONNECTED' })
        // If SSE connected but we have no events (server restart, all turns
        // completed), proactively fetch history from the storage endpoint.
        // Use before=MAX_SAFE_INTEGER to get the NEWEST events (tail), not
        // the oldest. This ensures the user sees the most recent conversation
        // state even if SSE replay failed to deliver events.
        //
        // This IIFE is a hydration task: we increment the pending counter up
        // front and decrement in the finally so hydrationPhase doesn't flip
        // to 'ready' until this catch-up attempt has resolved one way or
        // another. If replay_meta never arrives (older server), the
        // checkpoint below still fires from this finally.
        if (lastSeqRef.current === 0) {
          pendingHydrationTasksRef.current++
          void (async () => {
            let attemptedBackfill = false
            try {
              // Yield to let SSE replay events arrive first. onConnected fires
              // before onEvent for the first SSE message (sse-client.ts), so
              // lastSeqRef is always 0 here. SSE replay events are written
              // synchronously by the server and arrive in the same TCP segment
              // — 50ms is generous for them to be processed and update lastSeqRef.
              await new Promise(r => setTimeout(r, 50))
              if (lastSeqRef.current > 0) return

              attemptedBackfill = true
              try {
                const resp = await fetch(`${optionsRef.current.baseUrl}/${sessionId}/history?before=${Number.MAX_SAFE_INTEGER}&limit=200`)
                if (resp.ok) {
                  const data = await resp.json() as { events: SessionEvent[]; hasMore: boolean }
                  if (data.events.length > 0) {
                    // Re-check after await: if SSE events arrived during the
                    // fetch, don't RESET — that would wipe the live events.
                    if (lastSeqRef.current === 0) {
                      lastSeqRef.current = data.events.at(-1)?.seq ?? 0
                      tracedDispatch({ type: 'RESET', events: data.events, sessionId })
                    } else {
                      tracedDispatch({ type: 'PREPEND_HISTORY', events: data.events })
                    }
                  }
                }
              } catch {
                // History unavailable — no-op, session will populate on next message
              }
            } finally {
              pendingHydrationTasksRef.current--
              // Only mark hydration checkpoint reached when this IIFE actually
              // ran the history backfill. If SSE events started arriving within
              // the 50ms window we early-returned, the modern server always
              // emits `replay_meta` after the initial replay — defer setting
              // the checkpoint to onReplayMeta so hydrationPhase doesn't flip
              // 'ready' while the rest of the replay is still streaming.
              // (Without this gate, a large or chunked replay over slow
              // networks releases the gate mid-stream and the partial event
              // prefix derives as 'streaming', surfacing the "stopped session
              // shows as active" symptom.)
              if (attemptedBackfill) {
                hydrationCheckpointReachedRef.current = true
              }
              // Always poke the gate. On the early-return path we don't own
              // the checkpoint, but onReplayMeta may have set it while we
              // were in the 50ms window — and seen pending=1, no-op'd, and
              // never been called again. Our pending-- can be the last thing
              // keeping the phase from flipping to 'ready'. The gate predicate
              // (`!hydrationCheckpointReachedRef.current` returns) makes this
              // safe when the checkpoint isn't set yet.
              maybeFinishHydration()
            }
          })()
        }
      },
      onDisconnected: () => {
        tracedDispatch({ type: 'DISCONNECTED' })
      },
      onReset: async () => {
        // First try the consumer's custom reset handler
        const customEvents = (await optionsRef.current.onReset?.()) ?? []
        if (customEvents.length > 0) {
          lastSeqRef.current = customEvents.at(-1)?.seq ?? 0
          tracedDispatch({ type: 'RESET', events: customEvents, sessionId })
          return
        }
        // No custom handler — try loading from the history endpoint.
        // This handles server restart (no_session) when storage has events.
        // Use before=MAX_SAFE_INTEGER to get the newest events (tail).
        try {
          const resp = await fetch(`${optionsRef.current.baseUrl}/${sessionId}/history?before=${Number.MAX_SAFE_INTEGER}&limit=200`)
          if (resp.ok) {
            const data = await resp.json() as { events: SessionEvent[]; hasMore: boolean }
            if (data.events.length > 0) {
              lastSeqRef.current = data.events.at(-1)?.seq ?? 0
              tracedDispatch({ type: 'RESET', events: data.events, sessionId })
              return
            }
          }
        } catch {
          // History endpoint unavailable — fall through to empty reset
        }
        lastSeqRef.current = 0
        tracedDispatch({ type: 'RESET', events: [], sessionId })
      },
      onReplayMeta: (meta) => {
        // Receiving replay_meta always counts as crossing the hydration
        // checkpoint — the server has finished its initial replay. Whether
        // or not we need to backfill, this point pins down "SSE caught up."
        hydrationCheckpointReachedRef.current = true

        // Server declared a reset: our reconnect cursor was incoherent (past
        // the stored tail after a seq restart, or a gap too large to replay),
        // and this replay is a fresh tail-window rebuild. Clear existing event
        // state and drop the stale cache entry so the replayed tail + history
        // fetch rebuild the list instead of merging into a gapped one. The
        // reset arrives before the replay events, so clearing here means the
        // subsequent EVENT actions land in a fresh, empty list.
        if (meta.reset) {
          lastSeqRef.current = 0
          if (sessionId) sessionCache.delete(sessionId)
          tracedDispatch({ type: 'RESET', events: [], sessionId })
        }

        // Server scoped SSE replay to the most recent turn — older turns
        // weren't delivered. Proactively fetch them from the history endpoint
        // so the user sees the full conversation without needing to scroll up.
        if (!meta.scoped) {
          // No backfill needed; hydration may already be complete.
          maybeFinishHydration()
          return
        }
        pendingHydrationTasksRef.current++
        void (async () => {
          try {
            const resp = await fetch(
              `${optionsRef.current.baseUrl}/${sessionId}/history?before=${Number.MAX_SAFE_INTEGER}&limit=200`,
            )
            if (resp.ok) {
              const data = await resp.json() as { events: SessionEvent[]; hasMore: boolean }
              if (data.events.length > 0) {
                tracedDispatch({ type: 'PREPEND_HISTORY', events: data.events })
              }
            }
          } catch {
            // History unavailable — scroll-up pagination still works as fallback
          } finally {
            pendingHydrationTasksRef.current--
            maybeFinishHydration()
          }
        })()
      },
      onError: (message) => {
        tracedDispatch({ type: 'ERROR', message })
      },
      getLastSeq: () => lastSeqRef.current,
    })

    clientRef.current = client
    client.start()

    return () => {
      client.stop()
      clientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, options.baseUrl, connectKey])

  useEffect(() => {
    // On the first render after a session switch, `state` still holds the
    // previous session's events (the SSE effect's RESET hasn't re-rendered yet),
    // while `sessionId` is already the new one. Writing here would poison the new
    // session's cache entry. `state.sessionId` is set by RESET, so it names the
    // session `state.events` actually belong to — guard the write on the match.
    if (state.sessionId !== sessionId) return
    writeCachedSession(sessionId, state, hydrationPhase)
  }, [sessionId, state, hydrationPhase])

  useEffect(() => {
    lastSeqRef.current = Math.max(lastSeqRef.current, state.lastSeq)
  }, [state.lastSeq])

  // Derive status, activity, process liveness, and usage from events
  const status = useMemo(() => deriveStatus(state.events), [state.events])
  const activity = useMemo(() => deriveActivity(state.events), [state.events])
  const processAlive = useMemo(() => deriveProcessAlive(state.events), [state.events])
  const usage = useMemo(() => deriveUsage(state.events), [state.events])

  // Fire onStatusChange when status changes
  useEffect(() => {
    if (prevStatusRef.current !== status) {
      optionsRef.current.onStatusChange?.(prevStatusRef.current, status)
      prevStatusRef.current = status
    }
  }, [status])

  // Actions
  const send = useCallback(
    async (input: string, extra?: Record<string, unknown>) => {
      if (!sessionId) return
      const resp = await fetch(`${optionsRef.current.baseUrl}/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, ...extra }),
      })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: 'Send failed' })) as { error?: string }
        throw new Error(body.error || `Send failed (${resp.status})`)
      }
    },
    [sessionId],
  )

  const stop = useCallback(async () => {
    if (!sessionId) return
    await fetch(`${optionsRef.current.baseUrl}/${sessionId}/stop`, {
      method: 'POST',
    })
  }, [sessionId])

  const compact = useCallback(async () => {
    if (!sessionId) return
    const resp = await fetch(`${optionsRef.current.baseUrl}/${sessionId}/compact`, {
      method: 'POST',
    })
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: 'Compaction failed' })) as { error?: string }
      throw new Error(body.error || `Compaction failed (${resp.status})`)
    }
  }, [sessionId])

  const reconnect = useCallback(() => {
    setConnectKey((k) => k + 1)
  }, [])

  const injectEvent = useCallback((event: SessionEvent) => {
    lastSeqRef.current = Math.max(lastSeqRef.current, event.seq)
    tracedDispatch({ type: 'EVENT', event })
  }, [tracedDispatch])

  const fetchHistory = useCallback(
    (opts?: { limit?: number }): Promise<{ hasMore: boolean }> => {
      // Coalesce concurrent calls: an IntersectionObserver can fire several
      // times before React commits `isLoadingMore` in a product-side guard.
      if (historyInFlightRef.current) return historyInFlightRef.current

      const requestSessionId = sessionId

      const promise = (async (): Promise<{ hasMore: boolean }> => {
        if (!requestSessionId) return { hasMore: false }

        const earliestSeq = earliestSeqRef.current
        if (earliestSeq <= 1) return { hasMore: false }

        const limit = opts?.limit ?? 50
        const url = `${optionsRef.current.baseUrl}/${requestSessionId}/history?before=${earliestSeq}&limit=${limit}`
        const resp = await fetch(url)
        if (!resp.ok) return { hasMore: false }

        const data = await resp.json() as HistoryPage

        // Discard responses that arrive after a session change.
        if (requestSessionId !== fetchHistorySessionRef.current) {
          return { hasMore: false }
        }

        if (data.events.length > 0) {
          // Advance the cursor synchronously so a follow-up call made before
          // React renders the prepended page still asks for the next-older page.
          const pageEarliestSeq = data.events.reduce(
            (min, event) => Math.min(min, event.seq),
            earliestSeq,
          )
          if (earliestSeqRef.current === 0 || pageEarliestSeq < earliestSeqRef.current) {
            earliestSeqRef.current = pageEarliestSeq
          }
          tracedDispatch({ type: 'PREPEND_HISTORY', events: data.events })
        }

        return { hasMore: data.hasMore }
      })()

      historyInFlightRef.current = promise
      const clearInFlight = () => {
        if (historyInFlightRef.current === promise) {
          historyInFlightRef.current = null
        }
      }
      void promise.then(clearInFlight, clearInFlight)
      return promise
    },
    [sessionId, tracedDispatch],
  )

  // Snapshot action trace — stable reference, reads from ref on access
  const actionTrace = useMemo(() => actionTraceRef.current.snapshot(), [state.events, state.connected])

  return {
    status,
    activity,
    error: state.error,
    events: state.events,
    connected: state.connected,
    hydrationPhase,
    processAlive,
    usage,
    actionTrace,
    send,
    compact,
    stop,
    reconnect,
    injectEvent,
    fetchHistory,
  }
}
