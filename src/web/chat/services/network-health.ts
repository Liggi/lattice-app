import { sendBrowserIncident } from './browser-incidents'

type ApiOutcomeStatus = 'success' | 'slow' | 'http_error' | 'failed' | 'timeout'
type StreamStatus = 'connecting' | 'open' | 'error' | 'closed'
type StreamKind = 'activity' | 'claude'

interface PendingApiRequest {
  id: string
  method: string
  path: string
  timeoutMs: number
  startedAtMs: number
}

interface RecentApiOutcome {
  at: string
  status: ApiOutcomeStatus
  method: string
  path: string
  durationMs: number
  timeoutMs: number
  error?: string
  /**
   * The request's timer fired long after its budget — the signature of a
   * suspended tab (timers freeze, then all fire at once on wake), not a
   * network or server fault. Kept in telemetry for honesty, excluded from
   * stall detection. Live example 2026-08-28: a wake burst reported
   * durationMs ≈ 79 minutes against 30s budgets.
   */
  suspectedTabSuspension?: boolean
}

interface StreamSnapshot {
  key: string
  kind: StreamKind
  sessionId?: string
  streamingId?: string
  status: StreamStatus
  lastStateAtMs: number
  connectedAtMs?: number
  lastEventAtMs?: number
  lastError?: string
}

interface StreamIdentity {
  key: string
  kind: StreamKind
  sessionId?: string
  streamingId?: string
}

interface StallTrigger {
  source: 'api' | 'stream'
  reason: string
  method?: string
  path?: string
  status?: ApiOutcomeStatus
  streamKind?: StreamKind
  streamKey?: string
}

export const SUSPECTED_TAB_NETWORK_STALL_EVENT = 'lattice:suspected-tab-network-stall'

/**
 * A timeout should fire at ≈ its budget. A duration that overshoots by
 * minutes means the timer did not run on schedule — the tab was suspended
 * and every pending request fired at once on wake. Exported so the request
 * layer can stamp the same verdict onto the telemetry it ships to the
 * server: without it, the server log (and `pnpm warn-audit`) cannot tell a
 * wake burst from a real outage. Live example 2026-08-28 15:22 UTC: 32
 * "timeouts" in two seconds reporting 166–360s against 20–30s budgets.
 */
export function isSuspectedTabSuspension(durationMs: number, timeoutMs: number): boolean {
  return durationMs > timeoutMs * 3 && durationMs - timeoutMs > 60_000
}

const RECENT_OUTCOME_WINDOW_MS = 20_000
const STALL_INCIDENT_COOLDOWN_MS = 60_000
const MAX_RECENT_OUTCOMES = 40
const MAX_PENDING_REQUESTS_IN_INCIDENT = 12
const MAX_STREAMS_IN_INCIDENT = 12

class NetworkHealthMonitor {
  private pendingRequests = new Map<string, PendingApiRequest>()
  private recentOutcomes: RecentApiOutcome[] = []
  private streams = new Map<string, StreamSnapshot>()
  private lastStallIncidentAtMs = 0
  private requestCounter = 0

  beginApiRequest(input: {
    method: string
    path: string
    timeoutMs: number
  }): string {
    const id = `req-${Date.now().toString(36)}-${this.requestCounter++}`
    this.pendingRequests.set(id, {
      id,
      method: input.method,
      path: input.path,
      timeoutMs: input.timeoutMs,
      startedAtMs: Date.now(),
    })
    return id
  }

  finishApiRequest(
    requestId: string,
    input: {
      status: ApiOutcomeStatus
      durationMs: number
      error?: string
      method: string
      path: string
      timeoutMs: number
    }
  ): void {
    this.pendingRequests.delete(requestId)

    const suspectedTabSuspension = isSuspectedTabSuspension(input.durationMs, input.timeoutMs)

    this.pushOutcome({
      at: new Date().toISOString(),
      status: input.status,
      method: input.method,
      path: input.path,
      durationMs: input.durationMs,
      timeoutMs: input.timeoutMs,
      error: input.error,
      ...(suspectedTabSuspension ? { suspectedTabSuspension } : {}),
    })

    if ((input.status === 'timeout' || input.status === 'failed') && !suspectedTabSuspension) {
      this.maybeReportSuspectedStall({
        source: 'api',
        reason: input.status === 'timeout' ? 'request-timeout' : 'request-failed',
        method: input.method,
        path: input.path,
        status: input.status,
      })
    }
  }

  noteStreamConnecting(identity: StreamIdentity): void {
    this.upsertStream(identity, { status: 'connecting' })
  }

  noteStreamOpen(identity: StreamIdentity): void {
    this.upsertStream(identity, {
      status: 'open',
      connectedAtMs: Date.now(),
      lastError: undefined,
    })
  }

  noteStreamActivity(key: string): void {
    const existing = this.streams.get(key)
    if (!existing) return
    existing.lastEventAtMs = Date.now()
    if (existing.status !== 'open') {
      existing.status = 'open'
      existing.lastStateAtMs = existing.lastEventAtMs
    }
  }

  noteStreamError(identity: StreamIdentity, error: string): void {
    this.upsertStream(identity, {
      status: 'error',
      lastError: error,
    })
    this.maybeReportSuspectedStall({
      source: 'stream',
      reason: 'stream-error',
      streamKind: identity.kind,
      streamKey: identity.key,
    })
  }

  noteStreamClosed(identity: StreamIdentity, reason?: string): void {
    this.upsertStream(identity, {
      status: 'closed',
      lastError: reason,
    })
  }

  private upsertStream(identity: StreamIdentity, patch: Partial<StreamSnapshot>): void {
    const nowMs = Date.now()
    const existing = this.streams.get(identity.key)
    const next: StreamSnapshot = {
      key: identity.key,
      kind: identity.kind,
      sessionId: identity.sessionId,
      streamingId: identity.streamingId,
      status: patch.status ?? existing?.status ?? 'closed',
      lastStateAtMs: nowMs,
      connectedAtMs: patch.connectedAtMs ?? existing?.connectedAtMs,
      lastEventAtMs: patch.lastEventAtMs ?? existing?.lastEventAtMs,
      lastError: patch.lastError ?? existing?.lastError,
    }
    this.streams.set(identity.key, next)
    this.pruneStreams()
  }

  private pushOutcome(outcome: RecentApiOutcome): void {
    const cutoffMs = Date.now() - RECENT_OUTCOME_WINDOW_MS
    this.recentOutcomes.push(outcome)
    this.recentOutcomes = this.recentOutcomes
      .filter((item) => Date.parse(item.at) >= cutoffMs)
      .slice(-MAX_RECENT_OUTCOMES)
  }

  private pruneStreams(): void {
    const cutoffMs = Date.now() - (30 * 60 * 1000)
    for (const [key, stream] of this.streams.entries()) {
      if (stream.status === 'closed' && stream.lastStateAtMs < cutoffMs) {
        this.streams.delete(key)
      }
    }
  }

  private maybeReportSuspectedStall(trigger: StallTrigger): void {
    if (typeof window === 'undefined') return

    const nowMs = Date.now()
    if (nowMs - this.lastStallIncidentAtMs < STALL_INCIDENT_COOLDOWN_MS) {
      return
    }

    const recent = this.recentOutcomes.filter((outcome) => nowMs - Date.parse(outcome.at) <= RECENT_OUTCOME_WINDOW_MS)
    const failingRecent = recent.filter(
      (outcome) => (outcome.status === 'timeout' || outcome.status === 'failed') && !outcome.suspectedTabSuspension,
    )
    const distinctFailingPaths = new Set(failingRecent.map((outcome) => `${outcome.method} ${outcome.path}`))
    const timeoutCount = failingRecent.filter((outcome) => outcome.status === 'timeout').length
    const pendingRequests = Array.from(this.pendingRequests.values())
    const oldestPendingAgeMs = pendingRequests.reduce((maxAge, request) => {
      const ageMs = nowMs - request.startedAtMs
      return ageMs > maxAge ? ageMs : maxAge
    }, 0)

    const shouldReport =
      (timeoutCount >= 2 && distinctFailingPaths.size >= 2)
      || (failingRecent.length >= 4 && distinctFailingPaths.size >= 3)
      || (pendingRequests.length >= 6 && oldestPendingAgeMs >= 10_000 && failingRecent.length >= 2)

    if (!shouldReport) {
      return
    }

    this.lastStallIncidentAtMs = nowMs

    const streamSummaries = Array.from(this.streams.values())
      .sort((a, b) => b.lastStateAtMs - a.lastStateAtMs)
      .slice(0, MAX_STREAMS_IN_INCIDENT)
      .map((stream) => ({
        key: stream.key,
        kind: stream.kind,
        sessionId: stream.sessionId,
        streamingId: stream.streamingId,
        status: stream.status,
        connectedAgeMs: stream.connectedAtMs ? nowMs - stream.connectedAtMs : null,
        lastEventAgeMs: stream.lastEventAtMs ? nowMs - stream.lastEventAtMs : null,
        lastStateAgeMs: nowMs - stream.lastStateAtMs,
        lastError: stream.lastError,
      }))

    const pendingSummaries = pendingRequests
      .sort((a, b) => a.startedAtMs - b.startedAtMs)
      .slice(0, MAX_PENDING_REQUESTS_IN_INCIDENT)
      .map((request) => ({
        method: request.method,
        path: request.path,
        ageMs: nowMs - request.startedAtMs,
        timeoutMs: request.timeoutMs,
      }))

    sendBrowserIncident({
      type: 'suspected-tab-network-stall',
      severity: 'error',
      message: 'Burst of client request failures suggests browser-tab transport stall',
      details: {
        trigger,
        visibilityState: document.visibilityState,
        online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
        pendingRequestCount: pendingRequests.length,
        oldestPendingRequestAgeMs: oldestPendingAgeMs || 0,
        pendingRequests: pendingSummaries,
        recentApiOutcomes: recent.slice(-12),
        streamHealth: streamSummaries,
      },
    })

    window.dispatchEvent(new CustomEvent(SUSPECTED_TAB_NETWORK_STALL_EVENT, {
      detail: {
        trigger,
        pendingRequestCount: pendingRequests.length,
        oldestPendingRequestAgeMs: oldestPendingAgeMs || 0,
        recentApiOutcomes: recent.slice(-12),
        streamHealth: streamSummaries,
      },
    }))
  }
}

let instance: NetworkHealthMonitor | null = null

export function getNetworkHealthMonitor(): NetworkHealthMonitor {
  if (!instance) {
    instance = new NetworkHealthMonitor()
  }
  return instance
}
