import { Router, type Request, type Response } from 'express';
import { getCostTracker } from '../../services/infrastructure/cost-tracker.js';
import { asStreamingId, truncateId } from '@/types/index.js';
import type { DebugRouteContext } from './debug-route-utils.js';
import { buildEventSummary, findFullSessionId } from './debug-route-utils.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import { parsePositiveIntQuery } from '@/utils/query-helpers.js';
import { getSessionTimeline } from '../../services/process/session-timeline.js';
import { InsightAuditRepository } from '@/services/insights/insight-audit-repository.js';

export function createDebugSessionRoutes(context: DebugRouteContext): Router {
  const router = Router();
  const {
    statusManager,
    options,
    sessionInfoService,
    logger,
    getAllActiveStreamingIds,
    resolveSessionIdForStreamingId,
  } = context;

  /**
   * GET /api/debug/sessions/:sessionId/events
   * Returns structured session events with a compact summary.
   *
   * Query params:
   *   traceId: filter to a specific trace
   *   limit: max events (default 200)
   *   since: ISO timestamp (inclusive)
   *   types: comma-separated event types
   */
  router.get('/sessions/:sessionId/events', (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const traceId = (req.query.traceId as string | undefined) || undefined;
    const limit = parsePositiveIntQuery(req.query.limit);
    const since = req.query.since as string | undefined;
    const types = req.query.types
      ? String(req.query.types).split(',').map(t => t.trim()).filter(Boolean)
      : undefined;

    const events = sessionInfoService.getSessionEvents({
      sessionId,
      traceId,
      limit,
      since,
      types,
    });

    const summary = buildEventSummary(events, traceId ?? null);

    logger.debug('Debug session events requested', {
      sessionId: sessionId.slice(0, 8),
      traceId: traceId ? traceId.slice(0, 8) : undefined,
      eventCount: events.length,
    });

    res.json({
      sessionId,
      traceId: summary.traceId,
      summary,
      events,
    });
  });

  /**
   * GET /api/debug/sessions/:sessionId/diagnostic
   * Comprehensive diagnostic view of a session's state across all systems.
   */
  router.get('/sessions/:sessionId/diagnostic', asyncHandler(async (req: Request, res: Response) => {
        const { sessionId } = req.params;
        const fullSessionId = sessionId.length === 8
          ? await findFullSessionId(sessionId, sessionInfoService)
          : sessionId;

        if (!fullSessionId) {
          res.status(404).json({ error: 'Session not found', sessionIdPrefix: sessionId });
          return;
        }

        const diagnostic: SessionDiagnostic = {
          sessionId: fullSessionId,
          sessionIdShort: truncateId(fullSessionId),
          checkedAt: new Date().toISOString(),
          statusManager: null,
          database: null,
          daemon: null,
          recentEvents: [],
          diagnosis: [],
        };

        if (statusManager) {
          // Try to find the active conversation by conversationId or providerSessionId
          let ac = statusManager.get(fullSessionId)
            || statusManager.getByProviderSessionId(fullSessionId);

          // If not found and it's a conv-* ID, it should have been found by .get()
          // If not found and it's a provider session ID, try by streaming ID too
          if (!ac) {
            ac = statusManager.getByStreamingId(fullSessionId);
          }

          diagnostic.statusManager = {
            isActive: !!ac,
            streamingId: ac?.run?.streamingId || null,
            hasContext: !!ac,
            contextModel: ac?.segment.model || null,
            contextTraceId: ac?.traceId || null,
          };
        }

        const dbSession = sessionInfoService.getSessionInfoSync(fullSessionId);
        if (dbSession) {
          diagnostic.database = {
            exists: true,
            archived: dbSession.archived,
            pinned: dbSession.pinned,
            customName: dbSession.custom_name || null,
            workspace: dbSession.workspace,
            createdAt: dbSession.created_at,
            updatedAt: dbSession.updated_at,
          };
        } else {
          diagnostic.database = { exists: false };
        }

        {
          try {
            const activeStreamingIds = getAllActiveStreamingIds();
            const matchingStreamingId = activeStreamingIds.find(
              (sid: string) => {
                const resolvedSessionId = resolveSessionIdForStreamingId(sid);
                if (resolvedSessionId === fullSessionId) {
                  return true;
                }
                if (!resolvedSessionId || !fullSessionId.startsWith('conv-')) {
                  return false;
                }

                const contextLogical = statusManager
                  ?.getByProviderSessionId(resolvedSessionId)
                  ?.conversationId;
                if (contextLogical === fullSessionId) {
                  return true;
                }

                const mappedConversationId = sessionInfoService
                  .getSessionInfoSync(resolvedSessionId)
                  ?.conversation_id;
                return mappedConversationId === fullSessionId;
              }
            );

            diagnostic.daemon = {
              hasActiveProcess: !!matchingStreamingId,
              streamingId: matchingStreamingId || null,
              totalActiveProcesses: activeStreamingIds.length,
            };
          } catch {
            diagnostic.daemon = { error: 'Failed to query daemon' };
          }
        }

        // SessionTimeline milestones
        const timeline = getSessionTimeline();
        const milestones = timeline.getTimeline(fullSessionId);
        if (milestones.length > 0) {
          diagnostic.timeline = milestones.slice(-20).map(m => ({
            milestone: m.milestone,
            timestamp: new Date(m.timestamp).toISOString(),
            deltaFromPrevMs: m.deltaFromPrevMs,
            ...(m.fields && Object.keys(m.fields).length > 0 ? { fields: m.fields } : {}),
          }));
          const gaps = timeline.getGaps(fullSessionId).filter(g => g.durationMs > 5000);
          if (gaps.length > 0) {
            diagnostic.timelineGaps = gaps.map(g => ({
              after: g.from,
              before: g.to,
              gapMs: g.durationMs,
            }));
          }
        }

        const events = sessionInfoService.getSessionEvents({
          sessionId: fullSessionId,
          limit: 20,
        });
        diagnostic.recentEvents = events.map(e => ({
          type: e.eventType,
          timestamp: e.timestamp,
          provider: e.provider || undefined,
          streamingId: e.streamingId ? truncateId(e.streamingId) : undefined,
        }));

        const d = diagnostic;
        const daemonHasProcess = d.daemon && 'hasActiveProcess' in d.daemon && d.daemon.hasActiveProcess;

        if (d.database?.exists && !d.database.archived &&
            d.statusManager && !d.statusManager.isActive &&
            d.daemon && !daemonHasProcess) {
          diagnostic.diagnosis.push({
            level: 'info',
            message: 'Session is completed (not active in any system)',
          });
        }

        if (d.statusManager?.isActive && d.daemon && !daemonHasProcess) {
          diagnostic.diagnosis.push({
            level: 'warning',
            message: 'StatusManager thinks session is active but daemon has no process - possible orphan',
          });
        }

        if (!d.database?.exists && (d.statusManager?.isActive || daemonHasProcess)) {
          diagnostic.diagnosis.push({
            level: 'warning',
            message: 'Session is active but has no database entry',
          });
        }

        if (diagnostic.streamBuffer?.isOrphan) {
          diagnostic.diagnosis.push({
            level: 'warning',
            message: `Stream buffer is orphaned: ${diagnostic.streamBuffer.bufferEventCount} events buffered for ${Math.round((diagnostic.streamBuffer.bufferAgeMs ?? 0) / 1000)}s with no connected clients (SSE client connection race)`,
          });
        }

        if (diagnostic.streamBuffer && !diagnostic.streamBuffer.isOrphan &&
            diagnostic.streamBuffer.hasBuffer && diagnostic.streamBuffer.connectedClients === 0) {
          diagnostic.diagnosis.push({
            level: 'info',
            message: 'Stream buffer active with no clients (within normal startup window)',
          });
        }

        logger.info('Session diagnostic requested', {
          sessionId: truncateId(fullSessionId),
          isActive: d.statusManager?.isActive,
          hasDbEntry: d.database?.exists,
          hasDaemonProcess: daemonHasProcess,
          diagnosisCount: d.diagnosis.length,
        });

        res.json(diagnostic);
  }));

  /**
   * GET /api/debug/active-sessions
   * Quick overview of all sessions the system thinks are active.
   */
  router.get('/active-sessions', (_req: Request, res: Response) => {
    const result: ActiveSessionsOverview = {
      checkedAt: new Date().toISOString(),
      statusManager: null,
      daemon: null,
    };

    if (statusManager) {
      const stats = statusManager.getStats();
      result.statusManager = {
        count: stats.activeCount,
        sessions: stats.activeSessions.map(s => ({
          sessionId: truncateId(s.claudeSessionId),
          streamingId: truncateId(s.streamingId ?? ''),
        })),
      };
    }

    {
      try {
        const activeStreamingIds = getAllActiveStreamingIds();
        result.daemon = {
          count: activeStreamingIds.length,
          sessions: activeStreamingIds.map((sid: string) => ({
            sessionId: (() => {
              const resolvedSessionId = resolveSessionIdForStreamingId(sid);
              return resolvedSessionId ? truncateId(resolvedSessionId) : null;
            })(),
            streamingId: truncateId(sid),
          })),
        };
      } catch {
        result.daemon = { error: 'Failed to query daemon' };
      }
    }

    logger.info('Active sessions overview requested', {
      statusManagerCount: result.statusManager?.count ?? 0,
      daemonCount: (result.daemon && 'count' in result.daemon) ? result.daemon.count : 0,
    });

    res.json(result);
  });

  /**
   * GET /api/debug/state-reconciliation
   * Cross-references "active" state across:
   *   - ActiveConversationRegistry (in-memory)
   *   - Process managers (daemon/direct, plus any additional streaming IDs via getAdditionalActiveStreamingIds)
   *   - Codex session DB (codex_sessions.status)
   */
  router.get('/state-reconciliation', (_req: Request, res: Response) => {
    const checkedAt = new Date().toISOString();

    const claudeActiveStreamingIds = statusManager?.getActiveStreamingIds() ?? [];
    const additionalActiveStreamingIds = options.getAdditionalActiveStreamingIds?.() ?? [];
    const daemonActiveStreamingIds = Array.from(new Set([...claudeActiveStreamingIds, ...additionalActiveStreamingIds]));
    const daemonActiveStreamingIdSet = new Set(daemonActiveStreamingIds);

    const claudeActiveSet = new Set<string>(claudeActiveStreamingIds);

    const report: StateReconciliationReport = {
      checkedAt,
      statusManager: null,
      daemon: {
        count: daemonActiveStreamingIds.length,
        sessions: daemonActiveStreamingIds.map(streamingId => {
          const provider = claudeActiveSet.has(streamingId) ? 'claude' : 'unknown';
          const statusManagerSessionId = statusManager?.getSessionIdForStreaming(asStreamingId(streamingId)) || null;
          const resolvedSessionId = resolveSessionIdForStreamingId(streamingId);
          return {
            provider,
            streamingId,
            streamingIdShort: truncateId(streamingId),
            sessionId: resolvedSessionId,
            sessionIdShort: resolvedSessionId ? truncateId(resolvedSessionId) : null,
            statusManagerSessionId,
            statusManagerSessionIdShort: statusManagerSessionId ? truncateId(statusManagerSessionId) : null,
          };
        }),
      },
      codexDb: null,
      divergences: {
        statusManagerActiveButNoDaemon: [],
        daemonActiveButNoStatusManager: [],
        codexDbRunningButNoDaemon: [],
        codexDbRunningButNoStatusManager: [],
        codexDaemonActiveButDbMissingOrNotRunning: [],
        activeMissingSessionInfo: [],
      },
      summary: {
        statusManagerCount: 0,
        daemonCount: daemonActiveStreamingIds.length,
        codexDbRunningCount: null,
        divergenceCount: 0,
      },
    };

    if (statusManager) {
      const stats = statusManager.getStats();
      report.summary.statusManagerCount = stats.activeCount;

      report.statusManager = {
        count: stats.activeCount,
        sessions: stats.activeSessions.map(s => {
          const ac = statusManager.getByProviderSessionId(s.claudeSessionId);
          return {
            sessionId: s.claudeSessionId,
            sessionIdShort: truncateId(s.claudeSessionId),
            streamingId: s.streamingId ?? '',
            streamingIdShort: truncateId(s.streamingId ?? ''),
            hasContext: !!ac,
            contextTraceId: ac?.traceId || null,
            contextModel: ac?.segment.model || null,
            logicalSessionId: ac?.conversationId || null,
          };
        }),
      };

      report.divergences.statusManagerActiveButNoDaemon = report.statusManager.sessions
        .filter(s => !daemonActiveStreamingIdSet.has(s.streamingId))
        .map(s => ({
          sessionId: s.sessionId,
          sessionIdShort: s.sessionIdShort,
          streamingId: s.streamingId,
          streamingIdShort: s.streamingIdShort,
          contextTraceId: s.contextTraceId,
        }));

      report.divergences.daemonActiveButNoStatusManager = report.daemon.sessions
        .filter(s => !s.statusManagerSessionId)
        .map(s => ({
          provider: s.provider,
          streamingId: s.streamingId,
          streamingIdShort: s.streamingIdShort,
          resolvedSessionId: s.sessionId,
          resolvedSessionIdShort: s.sessionIdShort,
        }));

      for (const s of report.statusManager.sessions) {
        const candidateId = s.logicalSessionId || s.sessionId;
        const info = sessionInfoService.getSessionInfoSync(candidateId);
        if (!info) {
          report.divergences.activeMissingSessionInfo.push({
            sessionId: candidateId,
            sessionIdShort: truncateId(candidateId),
            streamingId: s.streamingId,
            streamingIdShort: s.streamingIdShort,
          });
        }
      }
    }

    report.summary.divergenceCount = Object.values(report.divergences).reduce(
      (sum, arr) => sum + arr.length,
      0
    );

    logger.info('State reconciliation requested', {
      statusManagerCount: report.summary.statusManagerCount,
      daemonCount: report.summary.daemonCount,
      codexDbRunningCount: report.summary.codexDbRunningCount,
      divergenceCount: report.summary.divergenceCount,
    });

    res.json(report);
  });

  /**
   * GET /api/debug/sessions/:sessionId/audit-trail
   * Returns full insight audit trail for dev tools debugging.
   */
  router.get('/sessions/:sessionId/audit-trail', asyncHandler(async (req: Request, res: Response) => {
        const { sessionId } = req.params;
        const limit = parsePositiveIntQuery(req.query.limit, { defaultValue: 100 }) ?? 100;
        const eventTypes = req.query.eventTypes
          ? String(req.query.eventTypes).split(',').map(t => t.trim()).filter(Boolean)
          : undefined;
        const triggers = req.query.triggers
          ? String(req.query.triggers).split(',').map(t => t.trim()).filter(Boolean)
          : undefined;
        const since = req.query.since as string | undefined;

        const fullSessionId = sessionId.length === 8
          ? await findFullSessionId(sessionId, sessionInfoService)
          : sessionId;

        if (!fullSessionId) {
          res.status(404).json({ error: 'Session not found', sessionIdPrefix: sessionId });
          return;
        }

        const events = InsightAuditRepository.getInstance().getFullAuditForSession(fullSessionId, {
          limit,
          eventTypes,
          triggers,
          since,
        });

        logger.debug('Audit trail requested', {
          sessionId: truncateId(fullSessionId),
          eventCount: events.length,
        });

        res.json({
          sessionId: fullSessionId,
          sessionIdShort: truncateId(fullSessionId),
          eventCount: events.length,
          events,
        });
  }));

  /**
   * GET /api/debug/sessions/:sessionId/costs
   * Returns LLM cost breakdown for a session.
   */
  router.get('/sessions/:sessionId/costs', asyncHandler(async (req: Request, res: Response) => {
        const { sessionId } = req.params;

        const fullSessionId = sessionId.length === 8
          ? await findFullSessionId(sessionId, sessionInfoService)
          : sessionId;

        if (!fullSessionId) {
          res.status(404).json({ error: 'Session not found', sessionIdPrefix: sessionId });
          return;
        }

        const costTracker = getCostTracker();
        const costs = costTracker.getSessionCosts(fullSessionId);

        logger.debug('Session costs requested', {
          sessionId: truncateId(fullSessionId),
          totalCost: costs.estimatedCostUsd.toFixed(4),
          calls: costs.calls,
        });

        res.json({
          sessionId: fullSessionId,
          sessionIdShort: truncateId(fullSessionId),
          ...costs,
        });
  }));

  return router;
}

interface SessionDiagnostic {
  sessionId: string;
  sessionIdShort: string;
  checkedAt: string;
  statusManager: {
    isActive: boolean;
    streamingId: string | null;
    hasContext: boolean;
    contextModel: string | null;
    contextTraceId: string | null;
  } | null;
  database: {
    exists: true;
    archived: boolean;
    pinned: boolean;
    customName: string | null;
    workspace: string;
    createdAt: string;
    updatedAt: string;
  } | { exists: false } | null;
  daemon: {
    hasActiveProcess: boolean;
    streamingId: string | null;
    totalActiveProcesses: number;
  } | { error: string } | null;
  streamBuffer?: {
    streamingId: string;
    hasBuffer: boolean;
    bufferEventCount: number;
    bufferAgeMs: number | null;
    bufferReason: 'startup' | 'disconnect' | null;
    isOrphan: boolean;
    connectedClients: number;
  } | null;
  timeline?: Array<{
    milestone: string;
    timestamp: string;
    deltaFromPrevMs: number | null;
    fields?: Record<string, unknown>;
  }>;
  timelineGaps?: Array<{
    after: string;
    before: string;
    gapMs: number;
  }>;
  recentEvents: Array<{
    type: string;
    timestamp: string;
    provider?: string;
    streamingId?: string;
  }>;
  diagnosis: Array<{
    level: 'info' | 'warning' | 'error';
    message: string;
  }>;
}

interface ActiveSessionsOverview {
  checkedAt: string;
  statusManager: {
    count: number;
    sessions: Array<{ sessionId: string; streamingId: string }>;
  } | null;
  daemon: {
    count: number;
    sessions: Array<{ sessionId: string | null; streamingId: string }>;
  } | { error: string } | null;
}

interface StateReconciliationReport {
  checkedAt: string;
  statusManager: {
    count: number;
    sessions: Array<{
      sessionId: string;
      sessionIdShort: string;
      streamingId: string;
      streamingIdShort: string;
      hasContext: boolean;
      contextTraceId: string | null;
      contextModel: string | null;
      logicalSessionId: string | null;
    }>;
  } | null;
  daemon: {
    count: number;
    sessions: Array<{
      provider: 'claude' | 'codex' | 'unknown';
      streamingId: string;
      streamingIdShort: string;
      sessionId: string | null;
      sessionIdShort: string | null;
      statusManagerSessionId: string | null;
      statusManagerSessionIdShort: string | null;
    }>;
  };
  codexDb: {
    runningCount: number;
    runningSessions: Array<{
      streamingId: string;
      streamingIdShort: string;
      conversationId: string | null;
      conversationIdShort: string | null;
      threadId: string;
      threadIdShort: string;
      status: string;
      model: string | null;
      workingDirectory: string;
      createdAt: string;
    }>;
  } | { error: string } | null;
  divergences: {
    statusManagerActiveButNoDaemon: Array<{
      sessionId: string;
      sessionIdShort: string;
      streamingId: string;
      streamingIdShort: string;
      contextTraceId: string | null;
    }>;
    daemonActiveButNoStatusManager: Array<{
      provider: 'claude' | 'codex' | 'unknown';
      streamingId: string;
      streamingIdShort: string;
      resolvedSessionId: string | null;
      resolvedSessionIdShort: string | null;
    }>;
    codexDbRunningButNoDaemon: Array<{
      streamingId: string;
      streamingIdShort: string;
      conversationId: string | null;
      conversationIdShort: string | null;
      threadIdShort: string;
      createdAt: string;
    }>;
    codexDbRunningButNoStatusManager: Array<{
      streamingId: string;
      streamingIdShort: string;
      conversationId: string | null;
      conversationIdShort: string | null;
    }>;
    codexDaemonActiveButDbMissingOrNotRunning: Array<{
      streamingId: string;
      streamingIdShort: string;
      dbStatus: string | null;
    }>;
    activeMissingSessionInfo: Array<{
      sessionId: string;
      sessionIdShort: string;
      streamingId: string;
      streamingIdShort: string;
    }>;
  };
  summary: {
    statusManagerCount: number;
    daemonCount: number;
    codexDbRunningCount: number | null;
    divergenceCount: number;
  };
}
