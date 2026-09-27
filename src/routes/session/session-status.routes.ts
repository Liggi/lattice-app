import type { Provider } from '@/types/unified-messages.js';
import { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import type { ActiveConversationRegistry, ActiveConversation } from '@/services/process/active-conversation-registry.js';
import type { SessionInfoService } from '@/services/sessions/session-info-service.js';
import { getEventStorage } from '@/harness/event-message-reader.js';
import type { SqliteEventStorageAdapter } from '@/harness/sqlite-event-storage.js';
import { deriveSessionStatusFromEvents, type RunFailure } from '@/harness/derive-session-status.js';
import type { PendingWork } from '@/harness/derive-pending-work.js';
import { deriveScheduledWakeup } from '@liggi/agent-ui-harness/protocol';
import { foldDecisions, isOpenDecision } from '@/types/decisions.js';
import { projectNeedsYou, projectWorkerTasks, projectWorkingOn, type NeedsYouItem } from '@/services/sessions/project-needs-you.js';

interface SessionStatusRoutesDeps {
  activeConversationRegistry: ActiveConversationRegistry;
  sessionInfoService: SessionInfoService;
  harnessSessionManager?: {
    hasSession(sessionId: string): boolean;
    getStatus(sessionId: string): string;
    getSessionIds(): string[];
  };
}

interface SessionStatusInfo {
  status: 'ongoing' | 'idle' | 'stopping' | 'completed' | 'pending';
  /** Latest status-bearing harness event, independent of conversation metadata writes. */
  lastActivityAt: string | null;
  provider: Provider | null;
  streamingId: string | null;
  startedAt: string | null;
  runVersion: number | null;
  // Phase 3 additions — nullable for backwards compatibility
  segmentId: string | null;
  providerSessionId: string | null;
  transitionReason: string | null;
  /**
   * Outstanding work that will wake the session without user input. Derived
   * from the event log only — the registry has no view of background tasks.
   */
  pendingWork: PendingWork | null;
  /** When pendingWork is a scheduled wake-up: when it fires, epoch ms. */
  wakeAt?: number | null;
  /**
   * A context compaction is in flight. Event-log derived; absent on
   * registry-only answers.
   */
  compacting?: boolean;
  /** The latest turn or run ended in an error; null once new work starts. */
  failure?: RunFailure | null;
  /**
   * The turn is running but held on the user's answer to its question card,
   * as a Codex turn is after request_user_input_async. Shown as waiting on
   * the user, not as working.
   */
  awaitingAnswer?: boolean;
  /** On a coordinator: its threads Jev judges need the user now, highest first. */
  needsYou?: NeedsYouItem[];
  /** On a coordinator: the project's Working on line, without thread references. */
  workingOn?: string | null;
  workerTasks?: Record<string, string> | null;
  lastTurnUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
}

const logger = createLogger('SessionStatusRoutes');

const COMPLETED_STATUS: SessionStatusInfo = {
  status: 'completed',
  lastActivityAt: null,
  provider: null,
  streamingId: null,
  startedAt: null,
  runVersion: null,
  segmentId: null,
  providerSessionId: null,
  transitionReason: null,
  pendingWork: null,
};

function isUnifiedConversationId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith('conv-');
}

function parseRequestedConversationIds(queryValue: unknown): string[] | null {
  const raw = Array.isArray(queryValue)
    ? queryValue.join(',')
    : typeof queryValue === 'string'
      ? queryValue
      : '';

  if (!raw) {
    return null;
  }

  const deduped = new Set<string>();
  for (const candidate of raw.split(',')) {
    const trimmed = candidate.trim();
    if (!isUnifiedConversationId(trimmed)) {
      continue;
    }
    deduped.add(trimmed);
  }

  return Array.from(deduped);
}

function inferProviderFromEvents(events: Array<{ type: string; data: unknown }>): Provider | null {
  for (const event of events) {
    if (event.type !== 'run:start') continue;
    const data = event.data as { config?: { extra?: { provider?: unknown } } };
    if (data.config?.extra?.provider === 'codex') return 'codex';
  }
  return null;
}

// Status is derived from the EVENT LOG — the single source of truth — for
// every id, on both the requested-ids path and the no-ids listing. The
// registry contributes only metadata (streamingId, segment ids, provider) and
// the 'pending' answer for a just-registered session whose spawn has not yet
// produced events. It holds no status opinion of its own: a parallel registry
// status machine desynced from the event log three separate ways on
// 2026-08-28 (follow-up sends, task:notification revivals, bare run:ready
// wakeup revivals) before it was removed.
//
// The derivation cache below is keyed by conversationId and gated on the
// session's max event seq: the expensive 200-event window read + derive only
// runs when a session has actually produced new events. Steady state for an
// idle session is a single index-seek (maxSeq) per poll. Bounded by the
// number of distinct conversations ever requested in this process lifetime.
interface CachedEventStatus {
  seq: number;
  status: SessionStatusInfo['status'];
  providerFromEvents: Provider | null;
  lastActivityAt: string | null;
  pendingWork: PendingWork | null;
  wakeAt: number | null;
  compacting: boolean;
  failure: RunFailure | null;
  awaitingAnswer: boolean;
}
const eventStatusCache = new Map<string, CachedEventStatus>();

/** Test seam: the cache is module-level and outlives individual routers. */
export function __resetStatusCachesForTests(): void {
  eventStatusCache.clear();
}

function deriveCached(
  storage: SqliteEventStorageAdapter,
  conversationId: string,
): CachedEventStatus | null {
  const seq = storage.maxSeq(conversationId);
  if (seq === 0) {
    // No events yet — nothing to derive from.
    return null;
  }
  const cached = eventStatusCache.get(conversationId);
  if (cached && cached.seq === seq) {
    return cached;
  }
  const events = storage.readStatusWindow(conversationId, 200);
  const derived = deriveSessionStatusFromEvents(events);
  const latestEventTimestamp = events.at(-1)?.timestamp;
  const entry: CachedEventStatus = {
    seq,
    status: derived.status,
    providerFromEvents: inferProviderFromEvents(events),
    lastActivityAt: typeof latestEventTimestamp === 'number' && Number.isFinite(latestEventTimestamp)
      ? new Date(latestEventTimestamp).toISOString()
      : null,
    pendingWork: derived.pendingWork,
    wakeAt: derived.pendingWork === 'scheduled_wakeup' ? deriveScheduledWakeup(events)?.expectedAt ?? null : null,
    compacting: derived.compacting,
    failure: derived.failure,
    awaitingAnswer: derived.status === 'ongoing'
      && [...foldDecisions(storage.readDecisionEvents(conversationId)).values()].some(isOpenDecision),
  };
  eventStatusCache.set(conversationId, entry);
  return entry;
}

export function createSessionStatusRoutes(deps: SessionStatusRoutesDeps): Router {
  const {
    activeConversationRegistry,
    sessionInfoService,
    harnessSessionManager,
  } = deps;

  const router = Router();

  router.get('/status', asyncHandler(async (req, res) => {
    const requestedIds = parseRequestedConversationIds(req.query.ids);

    const storage = (() => {
      try { return getEventStorage(); } catch { return null; }
    })();

    // Which ids to answer for: the explicit request, or — for the no-ids
    // listing — everything currently live (registry entries + harness
    // sessions).
    let ids: string[];
    if (requestedIds !== null) {
      ids = requestedIds;
    } else {
      const live = new Set<string>();
      for (const ac of activeConversationRegistry.getAll()) {
        if (isUnifiedConversationId(ac.conversationId)) live.add(ac.conversationId);
      }
      if (harnessSessionManager) {
        for (const sessionId of harnessSessionManager.getSessionIds()) {
          if (isUnifiedConversationId(sessionId)) live.add(sessionId);
        }
      }
      ids = Array.from(live);
    }

    const buildAnswer = (
      derived: CachedEventStatus | null,
      registryEntry: ActiveConversation | undefined,
    ): SessionStatusInfo => {
      if (!derived && !registryEntry) {
        return COMPLETED_STATUS;
      }
      return {
        // Registered but no events yet means a spawn is in flight.
        status: derived?.status ?? 'pending',
        lastActivityAt: derived?.lastActivityAt ?? registryEntry?.run?.startedAt ?? null,
        pendingWork: derived?.pendingWork ?? null,
        wakeAt: derived?.wakeAt ?? null,
        compacting: derived?.compacting ?? false,
        failure: derived?.failure ?? null,
        awaitingAnswer: derived?.awaitingAnswer ?? false,
        provider: registryEntry?.segment.provider ?? derived?.providerFromEvents ?? null,
        streamingId: registryEntry?.run?.streamingId ?? null,
        startedAt: registryEntry?.run?.startedAt ?? null,
        runVersion: registryEntry?.run?.runVersion ?? null,
        segmentId: registryEntry?.segment.segmentId ?? null,
        providerSessionId: registryEntry?.segment.providerSessionId ?? null,
        transitionReason: registryEntry?.segment.transitionReason ?? null,
      };
    };

    const responseSessions: Record<string, SessionStatusInfo> = {};
    for (const conversationId of ids) {
      const registryEntry = activeConversationRegistry.get(conversationId);
      let derived: CachedEventStatus | null = null;
      if (storage) {
        try {
          derived = deriveCached(storage, conversationId);
        } catch (err) {
          logger.warn('failed to read events for status derivation', {
            conversationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      responseSessions[conversationId] = buildAnswer(derived, registryEntry);

      try {
        const needsYou = projectNeedsYou(conversationId);
        if (needsYou) {
          responseSessions[conversationId].needsYou = needsYou;
          responseSessions[conversationId].workingOn = projectWorkingOn(conversationId);
          responseSessions[conversationId].workerTasks = projectWorkerTasks(conversationId);
        }
      } catch (err) {
        logger.warn('failed to read whether a project needs the user', {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const info = sessionInfoService.getSessionInfoSync(conversationId);
      if (info?.last_turn_usage) {
        responseSessions[conversationId].lastTurnUsage = info.last_turn_usage;
      }
    }

    res.json({
      sessions: responseSessions,
      serverTime: new Date().toISOString(),
    });
  }));

  return router;
}
