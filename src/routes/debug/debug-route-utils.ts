import { SessionInfoService } from '../../services/sessions/session-info-service.js';
import { ConversationService } from '../../services/sessions/conversation-service.js';
import { createLogger, type Logger } from '../../services/infrastructure/logger.js';
import type { ActiveConversationRegistry } from '../../services/process/active-conversation-registry.js';
import { asStreamingId, truncateId } from '@/types/index.js';

export type SessionEvent = ReturnType<SessionInfoService['getSessionEvents']>[number];

export interface SessionEventSummary {
  traceId: string | null;
  eventCount: number;
  providers: string[];
  traceIds: string[];
  firstEventAt: string | null;
  lastEventAt: string | null;
  counts: Record<string, number>;
  durationsMs: {
    toStreamConnect: number | null;
    toFirstMessage: number | null;
    toSessionEnd: number | null;
  };
  anomalies: {
    overlappingStreams: number;
    duplicateMessageCompletes: number;
    missingContextTransfer: boolean;
  };
}

export interface DebugRouteOptions {
  /**
   * Optional provider-specific active session IDs (e.g., Codex manager).
   */
  getAdditionalActiveStreamingIds?: () => string[];
  /**
   * Optional resolver for streamingId -> conversation/session ID when
   * StatusManager does not track that provider.
   */
  resolveSessionIdForStreamingId?: (streamingId: string) => string | null | undefined;
}

export function buildEventSummary(events: SessionEvent[], traceId?: string | null): SessionEventSummary {
  const providers = new Set<string>();
  const traceIds = new Set<string>();
  const counts: Record<string, number> = {};
  const streamDepth: Map<string, number> = new Map();
  let overlappingStreams = 0;
  let duplicateMessageCompletes = 0;
  const messageIds = new Set<string>();

  for (const event of events) {
    if (event.provider) providers.add(event.provider);
    if (event.traceId) traceIds.add(event.traceId);
    counts[event.eventType] = (counts[event.eventType] || 0) + 1;

    if (event.eventType === 'stream_connect' && event.streamingId) {
      const next = (streamDepth.get(event.streamingId) || 0) + 1;
      streamDepth.set(event.streamingId, next);
      if (next > 1) overlappingStreams += 1;
    }

    if (event.eventType === 'stream_disconnect' && event.streamingId) {
      const next = (streamDepth.get(event.streamingId) || 0) - 1;
      streamDepth.set(event.streamingId, Math.max(0, next));
    }

    if (event.eventType === 'message_complete' && event.messageId) {
      if (messageIds.has(event.messageId)) {
        duplicateMessageCompletes += 1;
      } else {
        messageIds.add(event.messageId);
      }
    }
  }

  const firstEventAt = events[0]?.timestamp || null;
  const lastEventAt = events[events.length - 1]?.timestamp || null;

  const switchEvent = events.find(e => e.eventType === 'switch_initiated' || e.eventType === 'session_start') || null;
  const streamConnect = events.find(e => e.eventType === 'stream_connect') || null;
  const firstMessage = events.find(e => e.eventType === 'message_start' || e.eventType === 'message_complete') || null;
  const sessionEnd = events.find(e => e.eventType === 'session_end') || null;

  const toMs = (start?: string | null, end?: string | null) => {
    if (!start || !end) return null;
    const delta = new Date(end).getTime() - new Date(start).getTime();
    return Number.isFinite(delta) ? delta : null;
  };

  const contextTransfers = counts.context_transfer_recorded || 0;
  const missingContextTransfer = !!switchEvent && contextTransfers === 0;

  const resolvedTraceId = traceId || (events.find(e => e.traceId)?.traceId ?? null);

  return {
    traceId: resolvedTraceId,
    eventCount: events.length,
    providers: Array.from(providers),
    traceIds: Array.from(traceIds),
    firstEventAt,
    lastEventAt,
    counts,
    durationsMs: {
      toStreamConnect: toMs(switchEvent?.timestamp, streamConnect?.timestamp),
      toFirstMessage: toMs(switchEvent?.timestamp, firstMessage?.timestamp),
      toSessionEnd: toMs(switchEvent?.timestamp, sessionEnd?.timestamp),
    },
    anomalies: {
      overlappingStreams,
      duplicateMessageCompletes,
      missingContextTransfer,
    },
  };
}

export interface DebugRouteContext {
  statusManager?: ActiveConversationRegistry;
  options: DebugRouteOptions;
  sessionInfoService: SessionInfoService;
  conversationService: ConversationService;
  logger: Logger;
  getAllActiveStreamingIds: () => string[];
  resolveSessionIdForStreamingId: (streamingId: string) => string | null;
  getActiveStoreSessionIds: () => string[];
  resolveConversation: (id: string) => Promise<{
    conversationId: string | null;
    resolvedFrom: 'conversationId' | 'providerSessionId' | 'sessionPrefix' | null;
    matchedSegmentId: string | null;
    conversation: ReturnType<ConversationService['getConversation']>;
  }>;
  resolveSegmentConversationLink: (
    segment: { provider: string; providerSessionId: string },
  ) => {
    linkageSource: 'session-info' | 'none';
    linkedConversationId: string | null;
    linkedConversationIdShort: string | null;
    sessionInfo: ReturnType<SessionInfoService['getSessionInfoSync']>;
  };
}

export function createDebugRouteContext(
  statusManager?: ActiveConversationRegistry,
  options: DebugRouteOptions = {},
): DebugRouteContext {
  const sessionInfoService = SessionInfoService.getInstance();
  const conversationService = ConversationService.getInstance();
  const logger = createLogger('DebugRoutes');

  const getAllActiveStreamingIds = (): string[] => {
    const registryStreamingIds = statusManager?.getActiveStreamingIds() ?? [];
    const additionalActiveStreamingIds = options.getAdditionalActiveStreamingIds?.() ?? [];
    return Array.from(new Set([...registryStreamingIds, ...additionalActiveStreamingIds]));
  };

  const resolveSessionIdForStreamingId = (streamingId: string): string | null => {
    const trackedSessionId = statusManager?.getSessionIdForStreaming(asStreamingId(streamingId));
    if (trackedSessionId) {
      return trackedSessionId;
    }

    const resolvedSessionId = options.resolveSessionIdForStreamingId?.(streamingId);
    return resolvedSessionId || null;
  };

  const getActiveStoreSessionIds = (): string[] => {
    const ids = new Set<string>();
    for (const sessionId of statusManager?.getActiveProviderSessionIds() ?? []) {
      if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
        ids.add(sessionId);
      }
    }

    const additionalStreamingIds = options.getAdditionalActiveStreamingIds?.() ?? [];
    for (const streamingId of additionalStreamingIds) {
      const resolvedSessionId = resolveSessionIdForStreamingId(streamingId);
      if (resolvedSessionId) {
        ids.add(resolvedSessionId);
      }
    }

    return Array.from(ids);
  };

  const resolveConversation = async (id: string): Promise<{
    conversationId: string | null;
    resolvedFrom: 'conversationId' | 'providerSessionId' | 'sessionPrefix' | null;
    matchedSegmentId: string | null;
    conversation: ReturnType<ConversationService['getConversation']>;
  }> => {
    const asConversation = conversationService.getConversation(id);
    if (asConversation) {
      return {
        conversationId: asConversation.conversationId,
        resolvedFrom: 'conversationId',
        matchedSegmentId: null,
        conversation: asConversation,
      };
    }

    const byProvider = conversationService.getConversationByProviderSession(id);
    if (byProvider) {
      return {
        conversationId: byProvider.conversation.conversationId,
        resolvedFrom: 'providerSessionId',
        matchedSegmentId: byProvider.matchedSegmentId,
        conversation: byProvider.conversation,
      };
    }

    if (id.length === 8) {
      const full = await sessionInfoService.resolveSessionId(id);
      if (full) {
        const asFullConversation = conversationService.getConversation(full);
        if (asFullConversation) {
          return {
            conversationId: asFullConversation.conversationId,
            resolvedFrom: 'sessionPrefix',
            matchedSegmentId: null,
            conversation: asFullConversation,
          };
        }

        const byFullProvider = conversationService.getConversationByProviderSession(full);
        if (byFullProvider) {
          return {
            conversationId: byFullProvider.conversation.conversationId,
            resolvedFrom: 'sessionPrefix',
            matchedSegmentId: byFullProvider.matchedSegmentId,
            conversation: byFullProvider.conversation,
          };
        }
      }
    }

    return {
      conversationId: null,
      resolvedFrom: null,
      matchedSegmentId: null,
      conversation: null,
    };
  };

  const resolveSegmentConversationLink = (
    segment: { provider: string; providerSessionId: string },
  ): {
    linkageSource: 'session-info' | 'none';
    linkedConversationId: string | null;
    linkedConversationIdShort: string | null;
    sessionInfo: ReturnType<SessionInfoService['getSessionInfoSync']>;
  } => {
    const info = sessionInfoService.getSessionInfoSync(segment.providerSessionId);
    if (info) {
      const linkedConversationId = info.conversation_id || null;
      return {
        linkageSource: 'session-info',
        linkedConversationId,
        linkedConversationIdShort: linkedConversationId ? truncateId(linkedConversationId) : null,
        sessionInfo: info,
      };
    }

    return {
      linkageSource: 'none',
      linkedConversationId: null,
      linkedConversationIdShort: null,
      sessionInfo: null,
    };
  };

  return {
    statusManager,
    options,
    sessionInfoService,
    conversationService,
    logger,
    getAllActiveStreamingIds,
    resolveSessionIdForStreamingId,
    getActiveStoreSessionIds,
    resolveConversation,
    resolveSegmentConversationLink,
  };
}

export async function findFullSessionId(
  prefix: string,
  sessionInfoService: SessionInfoService
): Promise<string | null> {
  return sessionInfoService.resolveSessionId(prefix);
}
