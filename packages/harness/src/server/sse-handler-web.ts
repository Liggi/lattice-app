import type { SessionManager } from './session-manager.js'
import type { SessionEvent } from '../protocol/events.js'

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'private, no-cache, no-store, no-transform, must-revalidate, max-age=0',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const

const HEARTBEAT_INTERVAL_MS = 10_000

export interface WebSSEHandlerOptions {
  heartbeatMs?: number
}

/**
 * Creates a Web API compatible SSE handler for a SessionManager.
 *
 * Returns a `Response` with a `ReadableStream` body — works in Next.js App
 * Router, Deno, Bun, and any runtime that supports the Web Streams API.
 *
 * Same replay logic as `createSSEHandler` (Node.js http version):
 * - Storage recovery for sessions after server restart
 * - Reconnect replay from `after` seq
 * - Initial connection scoped to most recent turn
 * - Heartbeat comments to prevent proxy timeouts
 *
 * Usage (Next.js App Router):
 *   const handler = createWebSSEHandler(manager)
 *   export async function GET(req: Request, { params }) {
 *     return handler(req, params.sessionId)
 *   }
 */
export function createWebSSEHandler(
  manager: SessionManager,
  options?: WebSSEHandlerOptions,
) {
  const heartbeatMs = options?.heartbeatMs ?? HEARTBEAT_INTERVAL_MS

  return function handleWebSSE(
    req: Request,
    sessionId: string,
  ): Response {
    const url = new URL(req.url)
    const afterSeq = Number(url.searchParams.get('after') ?? '0')
    const encoder = new TextEncoder()

    let log = manager.getLog(sessionId)

    if (!log) {
      log = manager.recoverFromStorage(sessionId)
    }

    if (!log) {
      const body = encoder.encode(
        `event: reset\ndata: ${JSON.stringify({ reason: 'no_session' })}\n\n`,
      )
      return new Response(body, { headers: SSE_HEADERS })
    }

    if (log.needsReset(afterSeq)) {
      const body = encoder.encode(
        `event: reset\ndata: ${JSON.stringify({ reason: 'events_evicted' })}\n\n`,
      )
      return new Response(body, { headers: SSE_HEADERS })
    }

    const stream = new ReadableStream({
      start(controller) {
        const write = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            // Stream closed — controller.enqueue throws after close/error
          }
        }

        const writeEvent = (event: SessionEvent) => {
          write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        }

        // Replay missed events — same scoping logic as createSSEHandler
        const missed = log!.since(afterSeq)
        let replayStart = 0

        if (afterSeq === 0 && missed.length > 0) {
          // Initial connection — scope to most recent turn
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
        }

        const replayedCount = missed.length - replayStart
        for (let i = replayStart; i < missed.length; i++) {
          writeEvent(missed[i])
        }

        // Diagnostic comment
        const firstReplaySeq = replayedCount > 0 ? missed[replayStart].seq : null
        const lastReplaySeq = replayedCount > 0 ? missed[missed.length - 1].seq : null
        write(`: replay sessionId=${sessionId} afterSeq=${afterSeq} total=${missed.length} replayed=${replayedCount} seqRange=${firstReplaySeq ?? '-'}..${lastReplaySeq ?? '-'}\n\n`)

        // Live subscription
        const unsub = log!.subscribe(writeEvent)

        // Immediate ping
        write(`: ok\n\n`)

        // Heartbeat
        const heartbeat = setInterval(() => {
          write(`: heartbeat\n\n`)
        }, heartbeatMs)

        // Cleanup on disconnect
        const cleanup = () => {
          unsub()
          clearInterval(heartbeat)
        }

        // AbortSignal from the request — fires when client disconnects
        if (req.signal) {
          req.signal.addEventListener('abort', () => {
            cleanup()
            try { controller.close() } catch { /* already closed */ }
          })
        }
      },
    })

    return new Response(stream, { headers: SSE_HEADERS })
  }
}
