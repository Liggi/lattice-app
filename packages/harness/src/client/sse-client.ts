import type { SessionEvent } from '../protocol/events.js'
import { getBytes, getLines, getMessages } from './sse-parser.js'

/** Metadata sent by the server after SSE replay to indicate whether older
 *  events were clipped (scoped to the most recent turn). */
export interface ReplayMeta {
  /** True when the server only replayed the most recent turn's events. */
  scoped: boolean
  /** True when the server declared a reset: the client's reconnect cursor was
   *  incoherent (past the stored tail, or a gap too large to replay), so this
   *  response is a tail-window rebuild, not an incremental resume. The client
   *  must clear existing event state before applying the replay. */
  reset?: boolean
  /** Total number of events available for this session. */
  totalEvents: number
  /** Number of events actually sent in the replay. */
  replayedCount: number
}

export interface SSEClientOptions {
  url: string
  onEvent: (event: SessionEvent) => void
  onConnected: () => void
  onDisconnected: () => void
  onReset: () => void
  onError: (message: string) => void
  getLastSeq: () => number
  /** Called when the server sends replay metadata after the initial SSE replay.
   *  Use `meta.scoped` to decide whether to proactively fetch older history. */
  onReplayMeta?: (meta: ReplayMeta) => void
}

const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30_000
const MAX_RETRIES = 10

/**
 * If no data (events or heartbeats) arrives within this window, assume the
 * connection is dead and force a reconnect. The server sends heartbeat
 * comments every 10s, so 25s ≈ 2.5× the interval — generous enough to
 * tolerate network jitter, tight enough to catch zombie connections from
 * sleep/wake cycles or network switches.
 */
const HEARTBEAT_TIMEOUT_MS = 25_000

/**
 * Manages an SSE connection with automatic reconnection and tab visibility handling.
 */
export class SSEClient {
  private controller: AbortController | null = null
  private options: SSEClientOptions
  private running = false
  private looping = false
  private visibilityHandler: (() => void) | null = null
  private connectionEstablished = false
  /** Wall-clock time of the last byte received. The heartbeat watchdog
   *  can't be trusted across a background freeze — timers don't run while
   *  the page is frozen — so the visibility handler checks this instead. */
  private lastDataAt = 0

  constructor(options: SSEClientOptions) {
    this.options = options
  }

  /** Start the SSE connection with reconnection and tab visibility handling. */
  start(): void {
    if (this.running) return
    this.running = true
    this.connectLoop()
    this.setupVisibilityHandler()
  }

  /** Stop the SSE connection and all reconnection attempts. */
  stop(): void {
    this.running = false
    this.looping = false
    this.controller?.abort()
    this.controller = null
    this.teardownVisibilityHandler()
  }

  private async connectLoop(): Promise<void> {
    if (this.looping) return
    this.looping = true

    try {
      let attempt = 0

      while (this.running) {
        this.connectionEstablished = false
        this.controller = new AbortController()

        try {
          const result = await this.connect(this.controller.signal)

          if (result === 'no_session') {
            // Server has no session — this can happen after a deploy (server
            // restarted, in-memory harness state lost). Retry with backoff
            // instead of giving up — the session may be recreated when the
            // daemon reconnects or the user sends a message.
            //
            // No onDisconnected() needed here — connect() only fires
            // onConnected() after receiving a non-reset message, so for
            // no_session responses, onConnected() was never called.
            attempt++
            if (attempt >= MAX_RETRIES) {
              this.running = false
              return
            }
            const delay = Math.min(INITIAL_RETRY_MS * 2 ** attempt, MAX_RETRY_MS)
            await sleep(delay)
            continue
          }

          // Clean disconnect (server closed normally) — reset attempt counter
          attempt = 0
        } catch (err) {
          if (!this.running) return

          // Tab hidden — don't burn retries in the background.
          // The visibility handler restarts the loop when the tab returns.
          if (typeof document !== 'undefined' && document.hidden) {
            return
          }

          // Connection was healthy before interruption (e.g. heartbeat
          // timeout, network glitch mid-stream) — not a sign of a broken
          // server, so forgive the error instead of accumulating retries.
          if (this.connectionEstablished) {
            attempt = 0
          } else {
            attempt++
          }

          if (attempt >= MAX_RETRIES) {
            this.options.onError(`Connection failed after ${MAX_RETRIES} retries`)
            this.running = false
            return
          }

          const delay = Math.min(INITIAL_RETRY_MS * 2 ** attempt, MAX_RETRY_MS)
          await sleep(delay)
        }

        if (this.running) {
          this.options.onDisconnected()
        }
      }
    } finally {
      this.looping = false
    }
  }

  private async connect(signal: AbortSignal): Promise<'ok' | 'no_session'> {
    const afterSeq = this.options.getLastSeq()
    const url = `${this.options.url}?after=${afterSeq}`

    const response = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal,
    })

    if (!response.ok) {
      throw new Error(`SSE connect failed: ${response.status}`)
    }

    if (!response.body) {
      throw new Error('SSE response has no body')
    }

    // Don't fire onConnected() eagerly on HTTP 200 — the server may
    // immediately send a no_session reset and close the stream. Firing
    // onConnected then onDisconnected in rapid succession causes a
    // visible Connected→Idle flash. Instead, defer until we receive the
    // first real (non-reset) event, proving the session actually exists.
    let connectedFired = false
    let gotNoSession = false

    // Heartbeat timeout: if the server stops sending data (heartbeats or
    // events), the TCP connection may be zombie (sleep/wake, network switch).
    // Abort to trigger a reconnect via the connectLoop catch handler.
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
    const resetHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer)
      heartbeatTimer = setTimeout(() => {
        this.controller?.abort()
      }, HEARTBEAT_TIMEOUT_MS)
    }
    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer)
        heartbeatTimer = null
      }
    }

    try {
      await getBytes(
        response.body,
        getLines(
          getMessages(
            () => {}, // onId — we track seq ourselves
            () => {}, // onRetry — we manage our own retry logic
            (msg) => {
              this.lastDataAt = Date.now()
              resetHeartbeat()

              if (msg.event === 'reset') {
                try {
                  const parsed = msg.data ? JSON.parse(msg.data) as { reason?: string } : {}
                  if (parsed.reason === 'no_session') {
                    gotNoSession = true
                  }
                } catch { /* non-JSON reset data */ }
                this.options.onReset()
                return
              }
              // Any non-reset message (including empty messages from server
              // comments like `: ok`) proves the session exists. Fire
              // onConnected once, before processing the event data.
              if (!connectedFired) {
                connectedFired = true
                this.connectionEstablished = true
                this.options.onConnected()
              }
              // Replay metadata — server signals whether older events were
              // clipped. Not a session event, so don't dispatch to onEvent.
              if (msg.event === 'replay_meta') {
                if (msg.data && this.options.onReplayMeta) {
                  try {
                    this.options.onReplayMeta(JSON.parse(msg.data) as ReplayMeta)
                  } catch { /* skip */ }
                }
                return
              }
              if (!msg.data) return
              try {
                const event = JSON.parse(msg.data) as SessionEvent
                this.options.onEvent(event)
              } catch {
                // Malformed SSE data — skip
              }
            },
          ),
        ),
      )
    } finally {
      clearHeartbeat()
    }

    return gotNoSession ? 'no_session' : 'ok'
  }

  private setupVisibilityHandler(): void {
    if (typeof document === 'undefined') return

    this.visibilityHandler = () => {
      if (document.hidden) {
        // Tab hidden — proactively disconnect. The connectLoop exits
        // when it sees document.hidden, preserving the retry budget.
        this.controller?.abort()
      } else {
        // Tab visible again — start a fresh loop (attempt counter resets)
        if (this.running && !this.looping) {
          this.connectLoop()
        } else if (this.running && this.looping && Date.now() - this.lastDataAt > HEARTBEAT_TIMEOUT_MS) {
          // The loop is still parked on a read from a connection that died
          // while the page was frozen (phone backgrounding kills the TCP
          // stream without erroring the fetch). The heartbeat watchdog would
          // eventually catch it, but its timer was frozen too — abort now so
          // the catch handler reconnects immediately instead of after the
          // watchdog thaws.
          this.controller?.abort()
        }
      }
    }

    document.addEventListener('visibilitychange', this.visibilityHandler)
  }

  private teardownVisibilityHandler(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
