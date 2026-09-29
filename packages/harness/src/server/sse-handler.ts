import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionManager } from './session-manager.js'
import type { SessionEvent } from '../protocol/events.js'

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'private, no-cache, no-store, no-transform, must-revalidate, max-age=0',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const

const HEARTBEAT_INTERVAL_MS = 10_000

export interface SSEHandlerOptions {
  heartbeatMs?: number
  /** Rewrites each event just before it is written to the stream; the event in the log is untouched. */
  transformEvent?: (sessionId: string, event: SessionEvent) => SessionEvent
}

/**
 * Creates an SSE handler for a SessionManager.
 *
 * The handler expects:
 * - `sessionId` extracted from the URL (passed via options or parsed from path)
 * - `after` query parameter for replay (the last seq the client has)
 *
 * Usage:
 *   const handler = createSSEHandler(manager)
 *   // In your router:
 *   handler(req, res, sessionId)
 */
export function createSSEHandler(
  manager: SessionManager,
  options?: SSEHandlerOptions,
) {
  const heartbeatMs = options?.heartbeatMs ?? HEARTBEAT_INTERVAL_MS
  const transform = options?.transformEvent ?? ((_sessionId: string, event: SessionEvent) => event)

  return function handleSSE(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const afterSeq = Number(url.searchParams.get('after') ?? '0')

    res.writeHead(200, SSE_HEADERS)

    let log = manager.getLog(sessionId)
    if (!log) {
      log = manager.recoverFromStorage(sessionId)
    }

    if (!log) {
      // No session in memory or storage — genuinely new or unknown session.
      res.write(`event: reset\ndata: ${JSON.stringify({ reason: 'no_session' })}\n\n`)
      res.end()
      return
    }

    // Check if requested events have been evicted
    if (log.needsReset(afterSeq)) {
      res.write(`event: reset\ndata: ${JSON.stringify({ reason: 'events_evicted' })}\n\n`)
      res.end()
      return
    }

    // An incoherent client cursor forces a server-declared reset. A client
    // reconnecting with afterSeq from a stale cache against a recovered session
    // can have a cursor past the stored tail (seq restart) or a gap larger than
    // the tail window. A plain since(afterSeq) head read would silently clip the
    // newest events or return nothing; the client would keep a stale/gapped list
    // forever. Serve the same tail-window replay as a cold load and tell the
    // client to rebuild from it.
    const forcedReset = log.reconnectNeedsReset(afterSeq)
    const effectiveAfterSeq = forcedReset ? 0 : afterSeq

    // Replay missed events.
    //
    // For reconnections (afterSeq > 0): replay everything since their last
    // seq. With storage-backed EventLog, log.since() reads from disk for
    // evicted events, so the client always gets the full gap.
    //
    // For initial connections (afterSeq = 0): scope to the most recent turn
    // to keep the initial SSE payload small. Older turns are available via
    // the HTTP history endpoint (/events?before=SEQ&limit=N) on scroll-up.
    const missed = log.since(effectiveAfterSeq)
    let replayStart = 0

    if (effectiveAfterSeq === 0 && missed.length > 0) {
      // Initial connection — scope to most recent turn.
      // Find the last turn:end, then scan backwards to find where that
      // turn started (previous turn:end/run:end, or the beginning).
      let lastTurnEnd = -1
      for (let i = missed.length - 1; i >= 0; i--) {
        if (missed[i].type === 'turn:end') {
          // Skip turn:ends from empty turns (e.g., compact boundary sequences).
          // After compact, two consecutive turn:ends create a "turn" with no
          // renderable content — scoping to it would clip all pre-compact messages.
          let hasContent = false
          for (let j = i - 1; j >= 0; j--) {
            const jt = missed[j].type
            if (jt === 'content' || jt === 'input:sent') { hasContent = true; break }
            if (jt === 'turn:end' || jt === 'run:end') break
          }
          if (hasContent) {
            lastTurnEnd = i
            break
          }
        }
      }

      if (lastTurnEnd >= 0) {
        for (let i = lastTurnEnd - 1; i >= 0; i--) {
          const t = missed[i].type
          if (t === 'turn:end' || t === 'run:end') {
            replayStart = i + 1
            break
          }
        }
      }
      // If no turn:end (still streaming, or killed mid-turn),
      // replay everything — it's all one turn.
    }

    const replayedCount = missed.length - replayStart

    // Tell the client whether SSE replay was scoped (clipped older turns).
    // The client uses this signal in two ways:
    //   1. As the hydration checkpoint — receiving replay_meta is what
    //      releases the `hydrationPhase` gate from 'hydrating' to 'ready'
    //      via the `onReplayMeta` callback in use-session.ts.
    //   2. To trigger a `/history` fetch when older events are likely
    //      missing from the client's events array.
    //
    // Emitted FIRST, before the replay events. The client kicks off its
    // /history fetch on receiving replay_meta — emitting it up front lets
    // /history run in parallel with the SSE replay instead of strictly
    // after it. On slow networks this collapses SSE_replay + history_fetch
    // into max(SSE_replay, history_fetch) and removes the visible "stops
    // for a bit" pause between scoped events rendering and PREPEND_HISTORY
    // merging in older turns. Verified via chrome-devtools MCP under Slow 3G.
    //
    // Emitted unconditionally (on every connection, not just initial cold
    // loads). Previously this was gated on `afterSeq === 0`, which left
    // reconnects with no path to release the hydration gate — a mid-replay
    // disconnect on a flaky network would leave the tab pinned at
    // 'hydrating' forever, clamping latticeStatus to 'idle' and showing
    // only the most recent turn (whatever the initial scoped replay
    // delivered before the drop).
    //
    // `scoped` semantics:
    //   - cold load (afterSeq === 0): true iff this response clipped
    //     older turns from the initial replay (current behavior).
    //   - reconnect (afterSeq > 0): always true. The server can't tell
    //     whether a previous initial-replay clipped events the client
    //     never recovered from, so we defensively trigger a /history
    //     fetch on every reconnect. The fetch is cheap (deduped on the
    //     client via PREPEND_HISTORY's seq filter) and closes the
    //     "different positions on refresh" symptom of the reconnect wedge.
    //
    // See test/client/use-session-reconnect-wedge.test.ts and
    // test/server/sse-handler.test.ts for the regression contracts.
    // For a cold/forced-reset (after=0) replay, the response is scoped whenever
    // it clips older events. Turn-boundary scanning catches the common case
    // (replayStart > 0), but if the whole tail window is a single giant turn
    // with no prior boundary, replayStart stays 0 while the window still clips
    // everything before its first event. Detect that directly: if the first
    // replayed event isn't seq 1, older events were truncated.
    const firstWindowSeq = missed[replayStart]?.seq ?? 0
    const scoped = effectiveAfterSeq === 0
      ? (replayStart > 0 || (firstWindowSeq > 1))
      : true
    const meta = { scoped, reset: forcedReset, totalEvents: missed.length, replayedCount }
    res.write(`event: replay_meta\ndata: ${JSON.stringify(meta)}\n\n`)

    for (let i = replayStart; i < missed.length; i++) {
      writeEvent(res, transform(sessionId, missed[i]))
    }

    // Diagnostic comment — visible in browser DevTools Network tab for SSE debugging.
    // Not a real event, so clients ignore it (SSE spec: lines starting with ':').
    const firstReplaySeq = replayedCount > 0 ? missed[replayStart].seq : null
    const lastReplaySeq = replayedCount > 0 ? missed[missed.length - 1].seq : null
    res.write(`: replay sessionId=${sessionId} afterSeq=${afterSeq} total=${missed.length} replayed=${replayedCount} seqRange=${firstReplaySeq ?? '-'}..${lastReplaySeq ?? '-'}\n\n`)

    // Stream live events
    const unsub = log.subscribe((event) => {
      writeEvent(res, transform(sessionId, event))
    })

    // Immediate ping — confirms to the client that the session is valid.
    // The client defers onConnected() until receiving a non-reset message;
    // this comment ensures onConnected() fires promptly even when there
    // are no events to replay (idle session, no new data yet).
    res.write(`: ok\n\n`)

    // Heartbeat — SSE comment keeps proxies/load balancers from killing idle connections
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`)
    }, heartbeatMs)

    // Cleanup on disconnect
    const cleanup = () => {
      unsub()
      clearInterval(heartbeat)
    }

    req.on('close', cleanup)
    req.on('error', cleanup)
  }
}

function writeEvent(res: ServerResponse, event: { seq: number; type: string }): void {
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}
