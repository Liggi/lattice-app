/**
 * Hydration trace ingestion route.
 *
 * Diagnostic for mobile cold-load / SSE-reconnect symptoms where the chat view
 * "rewinds" to an older history state and shows a thinking indicator before
 * catching up to the live state. The hydrationPhase gate is supposed to
 * suppress exactly this; the hypothesis is that on iOS Chrome tab-suspension
 * the gate isn't re-engaging when the SSE connection re-establishes.
 *
 * The client (useHarnessSession) posts structured trace events here on every
 * relevant transition (hydrationPhase, connected, latticeStatus,
 * visibilitychange) plus one snapshot per page-load. Each line is logged with
 * the tag "HYDRATION_TRACE" so it can be grepped out of server.log.
 *
 * Filter to one mobile session by traceId (per-tab random short id stamped on
 * every payload). The endpoint is fire-and-forget — it returns 204 without a
 * body so sendBeacon works on visibility-hidden.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '@/services/infrastructure/logger.js';
import { deriveStatus, deriveProcessAlive } from '@liggi/agent-ui-harness/protocol';
import { getEventStorage } from '@/harness/event-message-reader.js';

const logger = createLogger('HydrationTrace');

/**
 * For each trace event, look up the server's actual harness event log for the
 * conversation and compute what status/lastSeq the server would derive *right
 * now*. Lets us spot client-stale cases at a glance: if the client logged
 * latticeStatus="streaming" but the server says status="idle", we have the bug.
 *
 * Failures are swallowed — this is best-effort enrichment.
 */
function snapshotServerTruth(conversationId: string | null | undefined): {
  serverStatus?: string;
  serverProcessAlive?: boolean;
  serverLastSeq?: number;
  serverLastType?: string;
  serverTotalEvents?: number;
  serverFetchError?: string;
} {
  if (!conversationId) return {};
  try {
    const storage = getEventStorage();
    const tail = storage.readTail(conversationId, 200);
    if (tail.length === 0) return { serverTotalEvents: 0 };
    const last = tail[tail.length - 1];
    return {
      serverStatus: deriveStatus(tail),
      serverProcessAlive: deriveProcessAlive(tail),
      serverLastSeq: storage.maxSeq(conversationId),
      serverLastType: last.type,
      serverTotalEvents: storage.count(conversationId),
    };
  } catch (err) {
    return { serverFetchError: err instanceof Error ? err.message : String(err) };
  }
}

interface TracePayload {
  traceId?: string;
  conversationId?: string | null;
  kind?: string;
  prev?: unknown;
  next?: unknown;
  hydrationPhase?: string;
  latticeStatus?: string;
  rawStatus?: string;
  connected?: boolean;
  processAlive?: boolean;
  visibility?: string;
  eventCount?: number;
  lastEventSeq?: number | null;
  lastEventType?: string | null;
  isMobile?: boolean;
  userAgent?: string;
  ts?: string;
  pageLoadAt?: string;
  notes?: string;
}

export function createDebugHydrationTraceRoutes(): Router {
  const router = Router();

  router.post('/hydration-trace', (req: Request, res: Response) => {
    // Accept either a single object or an array (sendBeacon may batch).
    const body: unknown = req.body;
    const events: TracePayload[] = Array.isArray(body) ? (body as TracePayload[]) : [body as TracePayload];

    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      const serverTruth = snapshotServerTruth(e.conversationId);
      // Compute the divergence flag inline so it's grep-able in one column.
      // 'mismatch' means client said streaming/initializing but server says idle —
      // i.e. exactly the user-reported "stopped session showing as active" bug.
      const clientThinksActive = e.latticeStatus === 'streaming' || e.latticeStatus === 'initializing';
      const serverThinksIdle = serverTruth.serverStatus === 'idle';
      const divergence = clientThinksActive && serverThinksIdle ? 'CLIENT_STALE_ACTIVE' : 'ok';
      logger.info('HYDRATION_TRACE', {
        traceId: e.traceId,
        conv: e.conversationId,
        kind: e.kind,
        prev: e.prev,
        next: e.next,
        hydrationPhase: e.hydrationPhase,
        latticeStatus: e.latticeStatus,
        rawStatus: e.rawStatus,
        connected: e.connected,
        processAlive: e.processAlive,
        visibility: e.visibility,
        eventCount: e.eventCount,
        lastEventSeq: e.lastEventSeq,
        lastEventType: e.lastEventType,
        // Server-side truth at the moment the trace landed.
        serverStatus: serverTruth.serverStatus,
        serverProcessAlive: serverTruth.serverProcessAlive,
        serverLastSeq: serverTruth.serverLastSeq,
        serverLastType: serverTruth.serverLastType,
        serverTotalEvents: serverTruth.serverTotalEvents,
        serverFetchError: serverTruth.serverFetchError,
        divergence,
        isMobile: e.isMobile,
        userAgent: e.userAgent,
        ts: e.ts,
        pageLoadAt: e.pageLoadAt,
        notes: e.notes,
      });
    }

    // 204 No Content — sendBeacon discards the response, regular fetch
    // doesn't need anything back either.
    res.status(204).end();
  });

  return router;
}
