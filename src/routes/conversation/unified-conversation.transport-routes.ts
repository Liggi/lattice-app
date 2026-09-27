import type { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { RequestWithRequestId } from '@/types/express.js';
import type { ActiveConversationRegistry } from '@/services/process/active-conversation-registry.js';
import type { ConversationService } from '@/services/sessions/conversation-service.js';
import type { InsightsEngine } from '@/services/insights/insights-engine.js';
import type { ConversationIdResolutionService } from '@/services/sessions/conversation-id-resolution-service.js';
import type { SessionInfoService } from '@/services/sessions/session-info-service.js';
import type { SessionActivityWatcher } from '@/services/sessions/session-activity-watcher.js';
import type { TeamWatcherService } from '@/services/teams/team-watcher-service.js';
import type { PermissionTracker } from '@/services/permission-tracker.js';
import type { ConversationMessage, PermissionRequest } from '@/types/index.js';
import { PendingQuestionService } from '@/services/pending-question-service.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { eventsToUnifiedMessages, getEventStorage } from '@/harness/event-message-reader.js';
import { getWorkerActivityService } from '@/services/sessions/worker-activity.js';
import { onStatusChanged } from '@/services/sessions/session-status-changes.js';
import type { SqliteEventStorageAdapter } from '@/harness/sqlite-event-storage.js';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import type Anthropic from '@anthropic-ai/sdk';

const logger = createLogger('UnifiedConversationTransportRoutes');

/**
 * How many harness events to read per conversation when seeding activity state
 * on connect.
 *
 * The seed exists so a freshly-connected tab renders the sidebar's mini action
 * log straight away rather than waiting for the next live activity event — an
 * idle session never produces one. `extractRecentActions` walks backwards and
 * stops at 14 actions, so only the newest handful of messages can ever matter.
 *
 * The seed used to call `historyReader.fetchConversationDirect(conv-*)`, which
 * was the single most expensive thing this endpoint did. A conv-* ID never
 * names a file under ~/.claude/projects (Claude writes provider-UUID
 * transcripts), so every call paid a full projects-directory scan, missed, and
 * then fell through to reading the event log with `read()`'s default limit of
 * 10000 and rebuilding every message — once per conversation, for up to 50
 * conversations, synchronously, on every tab connect and reconnect. Measured
 * against the 50 busiest conversations in the live store: 920 ms of directory
 * scanning + SQLite + JSON.parse before message assembly even starts.
 *
 * The window is measured in events but the thing that has to be sufficient is
 * *messages*, and the ratio between them is not stable: streamed text arrives
 * as one `content` event per delta, all sharing a messageId, so 199 events can
 * merge into a single message. The read therefore grows (see
 * SEED_ACTIVITY_MESSAGE_TARGET) rather than trusting one fixed size. Measured
 * against 201 live conversations, scoring each against the actions derived from
 * that conversation's complete log: the old whole-history read was right 76.6%
 * of the time at 44.2 ms per conversation; a flat 200-event window is right
 * 67.7% at 2.6 ms; growing to a 4000 ceiling is right 99.0%.
 */
const SEED_ACTIVITY_MIN_WINDOW = 200;
const SEED_ACTIVITY_MAX_WINDOW = 4000;

/**
 * Messages to assemble before the window stops growing. `extractRecentActions`
 * stops at 14 actions and most messages yield at least one, so this leaves
 * headroom for the messages that yield none (a turn of pure thinking blocks).
 */
const SEED_ACTIVITY_MESSAGE_TARGET = 40;

/**
 * Newest messages of a conversation, assembled from a bounded tail of its
 * harness event log, in the shape `InsightsEngine.extractRecentActions` reads.
 *
 * The block mapping mirrors ClaudeHistoryReader's event-storage fallback — the
 * path every conv-* seed actually took — so the actions extracted downstream
 * are the same kind.
 *
 * The window is `readStatusWindow`, not a raw `readTail`, because a raw tail is
 * not a tail of *messages*: a codex session interleaves `codex:rateLimits`
 * events densely enough that 400 raw events can hold a single message, which
 * emptied the seed for those sessions when this was first written that way.
 * `readStatusWindow` filters to the types carrying status or content — a
 * superset of the three types `eventsToUnifiedMessages` reads, plus the
 * `run:start` it reads the provider from.
 *
 * Where the window edge splits a multi-event message the oldest assembled
 * message can be missing earlier fragments; harmless here, because actions are
 * read from the newest end.
 */
export function readSeedActivityMessages(
  storage: Pick<SqliteEventStorageAdapter, 'readStatusWindow'>,
  conversationId: string,
  limits: { minWindow?: number; maxWindow?: number; messageTarget?: number } = {},
): ConversationMessage[] {
  const maxWindow = limits.maxWindow ?? SEED_ACTIVITY_MAX_WINDOW;
  const messageTarget = limits.messageTarget ?? SEED_ACTIVITY_MESSAGE_TARGET;
  let window = Math.min(limits.minWindow ?? SEED_ACTIVITY_MIN_WINDOW, maxWindow);

  for (;;) {
    const events = storage.readStatusWindow(conversationId, window);
    const messages = toSeedMessages(events, conversationId);
    // A short page means the window already covers the whole session, so
    // growing it cannot find more.
    const coveredWholeSession = events.length < window;
    if (coveredWholeSession || messages.length >= messageTarget || window >= maxWindow) {
      return messages;
    }
    window = Math.min(window * 4, maxWindow);
  }
}

function toSeedMessages(
  events: readonly SessionEvent[],
  conversationId: string,
): ConversationMessage[] {
  if (events.length === 0) {
    return [];
  }

  return eventsToUnifiedMessages(events).map((unified, index): ConversationMessage => ({
    uuid: unified.id || `seed-${index}`,
    type: unified.role === 'user' ? 'user' : 'assistant',
    message: {
      role: unified.role,
      content: unified.content.flatMap((block): Anthropic.ContentBlockParam[] => {
        if (block.type === 'text') {
          return [{ type: 'text' as const, text: block.text }];
        }
        if (block.type === 'tool_use') {
          return [{
            type: 'tool_use' as const,
            id: block.id || `tool-${index}`,
            name: block.name || 'unknown',
            input: block.input ?? {},
          }];
        }
        if (block.type === 'tool_result') {
          return [{
            type: 'text' as const,
            text: typeof block.output === 'string' ? block.output : JSON.stringify(block.output ?? ''),
          }];
        }
        return [];
      }),
    } as Anthropic.MessageParam,
    timestamp: unified.timestamp,
    sessionId: conversationId,
    provider: unified.provider,
  }));
}

export interface UnifiedConversationTransportRoutesContext {
  activeConversationRegistry: ActiveConversationRegistry;
  conversationService: ConversationService;
  sessionInfoService: SessionInfoService;
  insightsEngine: InsightsEngine;
  conversationIdResolutionService: ConversationIdResolutionService;
  permissionTracker: PermissionTracker;
}

export function registerUnifiedConversationTransportRoutes(
  router: Router,
  context: UnifiedConversationTransportRoutesContext
): void {
  const {
    activeConversationRegistry,
    conversationService,
    sessionInfoService,
    insightsEngine,
    conversationIdResolutionService,
    permissionTracker,
  } = context;

  // ==========================================================================
  // GET /resolve/:id — Resolve legacy session IDs into unified conv-* IDs
  // ==========================================================================
  router.get('/resolve/:id', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestedId = req.params.id;
    const traceId = typeof req.headers['x-trace-id'] === 'string'
      ? req.headers['x-trace-id']
      : `resolve-${Date.now().toString(36)}`;
    const payload = await conversationIdResolutionService.resolveConversationId({
      requestedId,
      traceId,
    });
    res.json(payload);
  }));

  // ==========================================================================
  // GET /activity-stream — Unified SSE stream for activity + lifecycle updates
  // ==========================================================================
  router.get('/activity-stream', (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    logger.debug('Unified activity stream client connected', { requestId });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let cleanupCalled = false;
    let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
    let watcher: SessionActivityWatcher | null = null;
    let teamWatcher: TeamWatcherService | null = null;

    type ActivityHandler = (update: { sessionId: string; recentActions: Array<{ tool: string; timestamp: number }>; timestamp: number }) => void;
    type InsightsHandler = (update: { sessionId: string; conversationId?: string; type: 'generated' | 'patched'; timestamp: number; identityImage?: string; traceId?: string }) => void;
    type SessionStartedHandler = (data: { streamingId: string; claudeSessionId: string; logicalSessionId?: string; runVersion?: number }) => void;
    type SessionEndedHandler = (data: { streamingId: string; claudeSessionId: string; logicalSessionId?: string; runVersion?: number }) => void;
    type TeamUpdatedHandler = (data: { teamName: string; leadSessionId: string; memberCount: number; tasks: { pending: number; in_progress: number; completed: number }; config: unknown; timestamp: number }) => void;
    type TeamRemovedHandler = (data: { teamName: string; timestamp: number }) => void;
    type TeamInboxUpdateHandler = (data: {
      teamName: string;
      agentName: string;
      newMessages: Array<{ from: string; summary?: string; timestamp?: string; text: string }>;
      newMessageCount: number;
      totalMessages: number;
      unreadCount: number;
      latestTimestamp: string | null;
      timestamp: number;
    }) => void;
    type ApiHealthHandler = (data: { type: string; creditsExhausted: boolean; since: string | null; timestamp: number }) => void;

    let onActivity: ActivityHandler | null = null;
    let onInsights: InsightsHandler | null = null;
    let onSessionStarted: SessionStartedHandler | null = null;
    let onSessionEnded: SessionEndedHandler | null = null;
    let onSessionIdle: ((data: { streamingId: string; claudeSessionId: string; logicalSessionId?: string; runVersion?: number }) => void) | null = null;
    let onTeamUpdated: TeamUpdatedHandler | null = null;
    let onTeamRemoved: TeamRemovedHandler | null = null;
    let onTeamInboxUpdate: TeamInboxUpdateHandler | null = null;
    let onApiHealth: ApiHealthHandler | null = null;
    const resolveUnifiedSessionId = (rawSessionId: string, logicalSessionId?: string): string => {
      const explicitLogical = logicalSessionId?.trim();
      if (explicitLogical && explicitLogical.startsWith('conv-')) {
        return explicitLogical;
      }

      if (rawSessionId.startsWith('conv-')) {
        return rawSessionId;
      }

      const contextLogical = activeConversationRegistry
        .getByProviderSessionId(rawSessionId)
        ?.conversationId
        ?.trim();
      if (contextLogical && contextLogical.startsWith('conv-')) {
        return contextLogical;
      }

      const mappedConversationId = typeof sessionInfoService.getSessionInfoSync === 'function'
        ? sessionInfoService.getSessionInfoSync(rawSessionId)?.conversation_id?.trim()
        : null;
      if (mappedConversationId && mappedConversationId.startsWith('conv-')) {
        return mappedConversationId;
      }

      return explicitLogical || rawSessionId;
    };

    const cleanup = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;

      logger.debug('Unified activity stream client disconnected', { requestId });

      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
      }

      if (watcher) {
        if (onActivity) watcher.off('activity', onActivity);
        if (onInsights) watcher.off('insights', onInsights);
        if (onApiHealth) watcher.off('api-health', onApiHealth);
      }

      if (teamWatcher) {
        if (onTeamUpdated) teamWatcher.off('team-updated', onTeamUpdated);
        if (onTeamRemoved) teamWatcher.off('team-removed', onTeamRemoved);
        if (onTeamInboxUpdate) teamWatcher.off('team-inbox-update', onTeamInboxUpdate);
      }

      if (onSessionStarted) {
        activeConversationRegistry.off('session-started', onSessionStarted);
      }

      if (onSessionEnded) {
        activeConversationRegistry.off('session-ended', onSessionEnded);
      }

      if (onSessionIdle) {
        activeConversationRegistry.off('session-idle', onSessionIdle);
      }

      permissionTracker.off('permission_request', onPermissionRequest);
      permissionTracker.off('permission_updated', onPermissionUpdated);
      pendingQuestionService.off('changed', onPendingQuestionsChanged);
      getWorkerActivityService().off('changed', onWorkerActivity);
      offStatusChanged();
    };

    req.on('close', cleanup);

    // Permission and pending-question pushes let the client relax its polls
    // for both to slow safety-net intervals. Attached synchronously (unlike
    // the watcher handlers below) so they survive a failed watcher import.
    const pendingQuestionService = PendingQuestionService.getInstance();

    const writePermissionEvent = (type: 'permission-request' | 'permission-updated', request: PermissionRequest): void => {
      // Clients skip events attributed to other sessions, so an ID that fails
      // to resolve must go out as null ("unattributed — check") rather than as
      // a raw streamingId no client would claim.
      const resolved = request.conversationId
        ?? resolveUnifiedSessionId(request.sessionId ?? request.streamingId);
      res.write(`data: ${JSON.stringify({
        type,
        requestId: request.id,
        sessionId: resolved.startsWith('conv-') ? resolved : null,
        status: request.status,
        toolName: request.toolName,
        // An escalated worker request is also asked in its coordinator's thread.
        coordinator: request.escalation ? request.coordinator ?? null : null,
        timestamp: Date.now(),
      })}\n\n`);
    };
    const onPermissionRequest = (request: PermissionRequest): void => {
      writePermissionEvent('permission-request', request);
    };
    const onPermissionUpdated = (request: PermissionRequest): void => {
      writePermissionEvent('permission-updated', request);
    };
    permissionTracker.on('permission_request', onPermissionRequest);
    permissionTracker.on('permission_updated', onPermissionUpdated);

    // Compacting, armed work and a project's asks change without a turn
    // starting or ending; this tells the client to refetch the status.
    const offStatusChanged = onStatusChanged((sessionId) => {
      res.write(`data: ${JSON.stringify({ type: 'session-status-changed', sessionId, timestamp: Date.now() })}\n\n`);
    });

    // A worker's activity line changes inside the worker's session, which the
    // coordinator's panel is not subscribed to. The frame names the
    // coordinator so its panel refetches /workers; the phrase itself stays on
    // the endpoint rather than being pushed twice.
    const onWorkerActivity = (data: { coordinator: string; worker: string }): void => {
      res.write(`data: ${JSON.stringify({
        type: 'worker-activity',
        sessionId: data.coordinator,
        worker: data.worker,
        timestamp: Date.now(),
      })}\n\n`);
    };
    const workerActivityService = getWorkerActivityService();
    workerActivityService.on('changed', onWorkerActivity);

    const onPendingQuestionsChanged = (data: { sessionId: string | null }): void => {
      res.write(`data: ${JSON.stringify({
        type: 'pending-questions-changed',
        sessionId: data.sessionId ? resolveUnifiedSessionId(data.sessionId) : null,
        timestamp: Date.now(),
      })}\n\n`);
    };
    pendingQuestionService.on('changed', onPendingQuestionsChanged);

    import('@/services/sessions/session-activity-watcher.js').then(async ({ getSessionActivityWatcher }) => {
      if (cleanupCalled) return;

      watcher = getSessionActivityWatcher();
      watcher.start();

      onActivity = (update) => {
        // The watcher derives its sessionId from the JSONL filename, i.e. the
        // provider session UUID. Every other handler here — and the seed below
        // — emits conv-* IDs, and the client keys its recentActions map on
        // conv-*, so a raw UUID could never match anything it holds. Resolve at
        // the emit boundary like the sibling handlers do. Unlike the permission
        // events, an unattributed activity event carries nothing the client can
        // act on (its handler needs the sessionId to index the update), so drop
        // it rather than sending a null-id payload.
        const sessionId = resolveUnifiedSessionId(update.sessionId);
        if (!sessionId.startsWith('conv-')) {
          return;
        }
        res.write(`data: ${JSON.stringify({
          type: 'activity',
          sessionId,
          recentActions: update.recentActions,
          timestamp: update.timestamp,
        })}\n\n`);
      };
      watcher.on('activity', onActivity);

      onInsights = (update) => {
        const { type: insightType, ...rest } = update;
        res.write(`data: ${JSON.stringify({ type: 'insights', insightType, ...rest })}\n\n`);
      };
      watcher.on('insights', onInsights);

      onApiHealth = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      watcher.on('api-health', onApiHealth);

      onSessionStarted = (data) => {
        const sessionId = resolveUnifiedSessionId(data.claudeSessionId, data.logicalSessionId);
        res.write(`data: ${JSON.stringify({
          type: 'session-started',
          sessionId,
          streamingId: data.streamingId,
          runVersion: data.runVersion ?? null,
          timestamp: Date.now()
        })}\n\n`);
      };
      activeConversationRegistry.on('session-started', onSessionStarted);

      onSessionEnded = (data) => {
        const sessionId = resolveUnifiedSessionId(data.claudeSessionId, data.logicalSessionId);
        res.write(`data: ${JSON.stringify({
          type: 'session-ended',
          sessionId,
          streamingId: data.streamingId,
          runVersion: data.runVersion ?? null,
          timestamp: Date.now()
        })}\n\n`);
      };
      activeConversationRegistry.on('session-ended', onSessionEnded);

      // Session idle — process completed a turn but stays alive for follow-up stdin input
      onSessionIdle = (data: { streamingId: string; claudeSessionId: string; logicalSessionId?: string; runVersion?: number }) => {
        const sessionId = resolveUnifiedSessionId(data.claudeSessionId, data.logicalSessionId);
        res.write(`data: ${JSON.stringify({
          type: 'session-idle',
          sessionId,
          streamingId: data.streamingId,
          runVersion: data.runVersion ?? null,
          timestamp: Date.now(),
        })}\n\n`);
      };
      activeConversationRegistry.on('session-idle', onSessionIdle);

      keepAliveInterval = setInterval(() => {
        res.write(`data: ${JSON.stringify({ type: 'ping', timestamp: Date.now() })}\n\n`);
      }, 30000);

      import('@/services/teams/team-watcher-service.js').then(({ getTeamWatcherService }) => {
        if (cleanupCalled) return;

        teamWatcher = getTeamWatcherService();
        teamWatcher.start();

        onTeamUpdated = (data) => {
          res.write(`data: ${JSON.stringify({
            type: 'team-updated',
            teamName: data.teamName,
            leadSessionId: data.leadSessionId,
            memberCount: data.memberCount,
            tasks: data.tasks,
            config: data.config,
            timestamp: data.timestamp
          })}\n\n`);
        };
        teamWatcher.on('team-updated', onTeamUpdated);

        onTeamRemoved = (data) => {
          res.write(`data: ${JSON.stringify({
            type: 'team-removed',
            teamName: data.teamName,
            timestamp: data.timestamp
          })}\n\n`);
        };
        teamWatcher.on('team-removed', onTeamRemoved);

        onTeamInboxUpdate = (data) => {
          res.write(`data: ${JSON.stringify({
            type: 'team-inbox-update',
            teamName: data.teamName,
            agentName: data.agentName,
            newMessageCount: data.newMessageCount,
            totalMessages: data.totalMessages,
            unreadCount: data.unreadCount,
            latestTimestamp: data.latestTimestamp,
            messages: data.newMessages.map((message) => ({
              from: message.from,
              summary: message.summary,
              timestamp: message.timestamp,
              textLength: message.text.length,
            })),
            timestamp: data.timestamp,
          })}\n\n`);
        };
        teamWatcher.on('team-inbox-update', onTeamInboxUpdate);
      }).catch((error: unknown) => {
        logger.warn('Unified activity stream failed to initialize team watcher', { requestId, error });
      });

      res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

      // Send active-sessions FIRST — this is cheap (in-memory CSM lookup) and
      // unblocks the frontend from showing correct "Live" status immediately.
      // The heavier seeding (JSONL reads, insights) follows after.
      try {
        if (cleanupCalled) return;
        const activeSessionIds = Array.from(new Set(
          activeConversationRegistry
            .getActiveProviderSessionIds()
            .map((id) => resolveUnifiedSessionId(String(id)))
            .filter((id) => id.startsWith('conv-'))
        ));
        const activeStreamingMap: Record<string, string> = {};
        const activeRunVersionMap: Record<string, number> = {};
        for (const ac of activeConversationRegistry.getAll()) {
          const resolvedSessionId = ac.conversationId;
          if (!resolvedSessionId.startsWith('conv-')) {
            continue;
          }

          const sid = ac.run?.streamingId;
          if (!sid || activeStreamingMap[resolvedSessionId]) {
            continue;
          }
          activeStreamingMap[resolvedSessionId] = sid;
          const runVersion = ac.run?.runVersion;
          if (typeof runVersion === 'number') {
            activeRunVersionMap[resolvedSessionId] = runVersion;
          }
        }
        res.write(`data: ${JSON.stringify({
          type: 'active-sessions',
          sessionIds: activeSessionIds,
          streamingIds: activeStreamingMap,
          runVersions: activeRunVersionMap,
          timestamp: Date.now(),
        })}\n\n`);
      } catch (error) {
        logger.warn('Failed to send active-sessions on connect', { error });
      }

      try {
        if (cleanupCalled) return;
        const seededConversationIds = conversationService
          .listConversations({ limit: 50, archived: false })
          .conversations
          .map((conversation) => conversation.conversationId);

        const seedStorage = (() => {
          try { return getEventStorage(); } catch { return null; }
        })();

        for (const seededConversationId of seedStorage ? seededConversationIds : []) {
          if (cleanupCalled || !seedStorage) return;
          try {
            const messages = readSeedActivityMessages(seedStorage, seededConversationId);
            if (messages.length === 0) continue;
            const recentActions = insightsEngine.extractRecentActions(messages, 14);
            if (recentActions.length === 0) continue;

            res.write(`data: ${JSON.stringify({
              type: 'activity',
              sessionId: seededConversationId,
              recentActions,
              timestamp: Date.now(),
            })}\n\n`);
          } catch (error) {
            logger.debug('Failed to seed unified activity state for conversation', {
              conversationId: seededConversationId.slice(0, 8),
              error,
            });
          }
          // The bounded read is synchronous. Yield between conversations so a
          // 50-conversation seed interleaves with other requests instead of
          // holding the event loop for the whole batch.
          await new Promise((resolve) => setImmediate(resolve));
        }

        const cachedInsights = await insightsEngine.getCachedInsightsForSessions(seededConversationIds);
        const insightsTimestamps: Record<string, string> = {};
        for (const [conversationId, insights] of cachedInsights.entries()) {
          const lastInsightUpdate = insights.patchedAt || insights.computedAt;
          if (lastInsightUpdate) {
            insightsTimestamps[conversationId] = lastInsightUpdate;
          }
        }
        if (Object.keys(insightsTimestamps).length > 0) {
          res.write(`data: ${JSON.stringify({ type: 'insights-status', timestamps: insightsTimestamps })}\n\n`);
        }
      } catch (error) {
        logger.warn('Failed to seed unified activity stream state', { error });
      }

      try {
        if (cleanupCalled) return;
        const { anthropicService } = await import('@/services/insights/anthropic-service.js');
        if (anthropicService.creditsExhausted) {
          res.write(`data: ${JSON.stringify({
            type: 'api-health',
            creditsExhausted: true,
            since: anthropicService.creditsExhaustedSince,
            timestamp: Date.now()
          })}\n\n`);
        }
      } catch (error) {
        logger.debug('Failed to seed API health status', { error });
      }
    }).catch((error: unknown) => {
      logger.error('Unified activity stream failed to initialize watcher', { requestId, error });
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to initialize activity watcher' })}\n\n`);
    });
  });

}
