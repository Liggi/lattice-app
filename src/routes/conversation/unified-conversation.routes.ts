/**
 * Unified Conversation Routes
 *
 * First-class conversation abstraction that maps to one or more provider segments.
 * Each conversation has a stable `conv-*` ID that never changes across provider switches.
 *
 * ROUTES:
 *   POST   /create                  - Create new conversation + first segment
 *   POST   /:conversationId/resume  - Resume latest segment with new message
 *   GET    /                        - List conversations (for sidebar)
 *   GET    /:conversationId         - Get conversation details + segments
 */

import { Router } from 'express';
import type { ClaudeHistoryReader } from '@/services/sessions/claude-history-reader.js';
import type { ActiveConversationRegistry } from '@/services/process/active-conversation-registry.js';
import { SessionInfoService } from '@/services/sessions/session-info-service.js';
import { ConversationService, type Conversation, type ConversationSegment, type Provider } from '@/services/sessions/conversation-service.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { ConversationIdResolutionService } from '@/services/sessions/conversation-id-resolution-service.js';
import { registerUnifiedConversationControlRoutes } from './unified-conversation.control-routes.js';
import { registerUnifiedConversationLifecycleRoutes } from './unified-conversation.lifecycle-routes.js';
import { registerUnifiedConversationQueryRoutes } from './unified-conversation.query-routes.js';
import { registerUnifiedConversationTransportRoutes } from './unified-conversation.transport-routes.js';
import { InsightsEngine } from '@/services/insights/insights-engine.js';
import type { PermissionTracker } from '@/services/permission-tracker.js';


const logger = createLogger('UnifiedConversationRoutes');

function generateTraceId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface UnifiedConversationRoutesDeps {
  historyReader: ClaudeHistoryReader;
  activeConversationRegistry: ActiveConversationRegistry;
  sessionInfoService: SessionInfoService;
  permissionTracker: PermissionTracker;
}

export function createUnifiedConversationRoutes(deps: UnifiedConversationRoutesDeps): Router {
  const {
    historyReader, activeConversationRegistry,
    sessionInfoService, permissionTracker,
  } = deps;
  const conversationService = ConversationService.getInstance();
  const insightsEngine = InsightsEngine.getInstance();
  const conversationIdResolutionService = new ConversationIdResolutionService({
    conversationService,
    sessionInfoService,
    historyReader,
    activeConversationRegistry,
  });
  const router = Router();

  const findRuntimeActiveSegment = (conversation: Conversation): ConversationSegment | null => {
    // Registry is authoritative for which segment is active.
    const registryEntry = activeConversationRegistry.get(conversation.conversationId);
    if (registryEntry) {
      const matched = conversation.segments.find(s => s.segmentId === registryEntry.segment.segmentId);
      if (matched) return matched;

      // Segment ID mismatch (e.g. queue dispatch registered a synthetic ID).
      // Fall back to the latest active segment for this provider so the stop
      // flow can still resolve the streamingId from the registry.
      const fallback = conversation.segments.find(
        s => s.provider === registryEntry.segment.provider && s.status === 'active'
      ) ?? conversation.segments[conversation.segments.length - 1];
      if (fallback) {
        logger.warn('[CONV] findRuntimeActiveSegment: segment ID mismatch, using fallback', {
          conversationId: conversation.conversationId,
          registrySegmentId: registryEntry.segment.segmentId,
          fallbackSegmentId: fallback.segmentId,
        });
        return fallback;
      }
    }

    return null;
  };

  const getLatestSegmentForFallback = (conversation: Conversation): ConversationSegment | null => {
    if (conversation.segments.length === 0) return null;
    return conversation.segments[conversation.segments.length - 1];
  };

  registerUnifiedConversationLifecycleRoutes(router, {
    activeConversationRegistry,
    sessionInfoService,
    conversationService,
    generateTraceId,
  });

  registerUnifiedConversationQueryRoutes(router, {
    conversationService,
    sessionInfoService,
    historyReader,
    activeConversationRegistry,
    insightsEngine,
    findRuntimeActiveSegment,
    getLatestSegmentForFallback,
  });

  registerUnifiedConversationTransportRoutes(router, {
    activeConversationRegistry,
    conversationService,
    sessionInfoService,
    insightsEngine,
    conversationIdResolutionService,
    permissionTracker,
  });


  /**
   * Resolve a conv-* conversationId to the active streamingId for process control.
   * For Claude sessions, looks up the latest segment's providerSessionId then queries
   * ActiveConversationRegistry.
   * Returns null if no active process is found.
   */
  function resolveActiveStreamingId(conversationId: string): {
    streamingId: string;
    provider: Provider;
  } | null {
    const conversation = conversationService.getConversation(conversationId);
    if (!conversation) return null;

    const activeSegment = findRuntimeActiveSegment(conversation);
    if (!activeSegment) return null;

    if (activeSegment.provider === 'claude' || activeSegment.provider === 'codex') {
      const registryEntry = activeConversationRegistry.get(conversationId);
      const streamingId = registryEntry?.run?.streamingId ?? null;
      if (!streamingId) return null;
      return { streamingId, provider: activeSegment.provider };
    }

    return null;
  }

  /**
   * Resolve a conv-* conversationId to the provider session ID.
   *
   * Claude continues to use the canonical conv-* ID for app-owned metadata.
   * Codex needs its app-server threadId for /goal and thread lifecycle calls,
   * which is stored as the segment providerSessionId after run:ready.
   */
  function resolveProviderSessionId(conversationId: string): string {
    const latest = conversationService.getLatestSegment(conversationId);
    if (latest?.provider === 'codex' && latest.providerSessionId && !latest.providerSessionId.startsWith('pending-')) {
      return latest.providerSessionId;
    }
    return conversationId;
  }

  /**
   * Resolve a conv-* conversationId to the ID that names its transcript file
   * on disk — the latest segment's providerSessionId for ANY provider.
   *
   * This is a different question from resolveProviderSessionId above, which
   * answers "what ID do provider APIs key by" and deliberately returns the
   * conv-* ID for Claude. Transcript files are always named by the provider
   * session UUID, so using the API resolver for file lookups made every
   * Claude conversation's mtime check miss.
   */
  function resolveTranscriptSessionId(conversationId: string): string {
    const latest = conversationService.getLatestSegment(conversationId);
    if (latest?.providerSessionId && !latest.providerSessionId.startsWith('pending-')) {
      return latest.providerSessionId;
    }
    return conversationId;
  }

  registerUnifiedConversationControlRoutes(router, {
    activeConversationRegistry,
    sessionInfoService,
    historyReader,
    insightsEngine,
    resolveActiveStreamingId,
    resolveProviderSessionId,
    resolveTranscriptSessionId,
    conversationService,
  });

  // --- Backfill initial_prompt for existing conversations ---
  const backfillInitialPrompts = async (): Promise<void> => {
    const missing = conversationService.getConversationsMissingPrompt();
    if (missing.length === 0) return;

    logger.info(`[CONV] Backfilling initial_prompt for ${missing.length} conversations`);
    let filled = 0;
    for (const { conversationId, providerSessionId } of missing) {
      const prompt = await historyReader.getFirstUserPrompt(providerSessionId);
      if (prompt) {
        conversationService.updateInitialPrompt(conversationId, prompt);
        filled++;
      }
    }
    logger.info(`[CONV] Backfilled initial_prompt for ${filled}/${missing.length} conversations`);
  };

  backfillInitialPrompts().catch((err: unknown) => {
    logger.error('[CONV] Failed to backfill initial_prompt', err);
  });

  return router;
}
