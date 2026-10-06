import type { Provider } from '@/types/unified-messages';
import type {
  ConversationDetailsResponse,
  ContentBlockParam,
  PendingWork,
  SessionInsights,
  UnifiedConversationSummary,
} from '../../types';
import type { CodexThreadGoal } from '@/services/process/codex-app-server-types';
import type { WorkersResponse } from '@/types/worker-events';
import { API_TIMEOUT_MS } from '../../config/connection';
import { sendClientTelemetry } from '../client-telemetry';
import { reportMilestone } from '../../utils/timeline-reporter';
import {
  ApiCore,
  generateTraceId,
  isApiTimeoutError,
  resolveConversationDetailsFallbackLimit,
} from './core';

const SESSION_STATUS_CACHE_KEY_PREFIX = 'conversation:session-status:';
const SESSION_STATUS_CACHE_TTL_MS = 750;

export class ConversationApi extends ApiCore {
  async getConversationDetails(
    sessionId: string,
    options?: { limit?: number; before?: string; traceId?: string; timeout?: number }
  ): Promise<ConversationDetailsResponse> {
    this.assertUnifiedConversationId(sessionId);
    const basePath = '/api/conv';

    const traceId = options?.traceId || generateTraceId();
    const startTime = performance.now();
    const sessionIdShort = sessionId.slice(0, 8);

    const requestDetails = async (limitOverride?: number): Promise<ConversationDetailsResponse> => {
      const params = new URLSearchParams();
      const effectiveLimit = limitOverride ?? options?.limit;
      if (effectiveLimit) params.set('limit', String(effectiveLimit));
      if (options?.before) params.set('before', options.before);
      const queryString = params.toString();
      const url = `${basePath}/${sessionId}${queryString ? `?${queryString}` : ''}`;

      return this.apiCall<ConversationDetailsResponse>(url, {
        headers: { 'X-Trace-Id': traceId },
        timeout: options?.timeout,
      });
    };

    try {
      const result = await requestDetails();

      const durationMs = Math.round(performance.now() - startTime);
      if (durationMs > 1000) {
        sendClientTelemetry({
          component: 'ApiService',
          event: 'conversation-details-slow',
          severity: 'warn',
          traceId,
          details: {
            sessionId: sessionIdShort,
            providerRoute: sessionId.startsWith('conv-') ? 'unified' : 'legacy',
            durationMs,
            timeoutMs: options?.timeout ?? API_TIMEOUT_MS,
            messageCount: result.messages?.length ?? 0,
            limit: options?.limit ?? null,
            beforeProvided: Boolean(options?.before),
          },
        });
      }

      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime);

      const fallbackLimit = isApiTimeoutError(error)
        ? resolveConversationDetailsFallbackLimit(options?.limit)
        : null;

      if (!fallbackLimit) {
        throw error;
      }

      sendClientTelemetry({
        component: 'ApiService',
        event: 'conversation-details-fallback-start',
        severity: 'warn',
        traceId,
        details: {
          sessionId: sessionIdShort,
          originalLimit: options?.limit ?? null,
          fallbackLimit,
          beforeProvided: Boolean(options?.before),
          timeoutMs: options?.timeout ?? API_TIMEOUT_MS,
          initialDurationMs: durationMs,
        },
      });

      const fallbackStartTime = performance.now();
      try {
        const fallbackResult = await requestDetails(fallbackLimit);
        const fallbackDurationMs = Math.round(performance.now() - fallbackStartTime);
        sendClientTelemetry({
          component: 'ApiService',
          event: 'conversation-details-fallback-success',
          severity: 'warn',
          traceId,
          details: {
            sessionId: sessionIdShort,
            fallbackLimit,
            fallbackDurationMs,
            messageCount: fallbackResult.messages?.length ?? 0,
            hasMore: fallbackResult.hasMore ?? null,
            oldestMessageId: fallbackResult.oldestMessageId ?? null,
          },
        });

        return fallbackResult;
      } catch (fallbackError) {
        sendClientTelemetry({
          component: 'ApiService',
          event: 'conversation-details-fallback-failed',
          severity: 'error',
          traceId,
          details: {
            sessionId: sessionIdShort,
            fallbackLimit,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          },
        });
        throw fallbackError;
      }
    }
  }

  /** Workers a coordinator has dispatched, folded from its event log (see `src/types/worker-events.ts`). */
  async getWorkers(conversationId: string): Promise<WorkersResponse> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${encodeURIComponent(conversationId)}/workers`);
  }

  /** Heartbeat while this coordinator's panel is open; worker activity lines are written only then. */
  async watchWorkers(conversationId: string): Promise<void> {
    this.assertUnifiedConversationId(conversationId);
    await this.apiCall(`/api/conv/${encodeURIComponent(conversationId)}/workers/watch`, { method: 'POST' });
  }

  async getConversationStatus(sessionId: string): Promise<{
    sessionId: string;
    status: 'completed' | 'ongoing' | 'idle' | 'pending';
    lastActivityAt: string | null;
    provider?: Provider | null;
    streamingId: string | null;
    startedAt: string | null;
  }> {
    this.assertUnifiedConversationId(sessionId);
    const response = await this.getSessionsStatus([sessionId]);
    const details = response.sessions[sessionId] ?? {
      status: 'completed' as const,
      lastActivityAt: null,
      provider: null,
      streamingId: null,
      startedAt: null,
    };

    return {
      sessionId,
      status: details.status,
      lastActivityAt: details.lastActivityAt,
      provider: details.provider,
      streamingId: details.streamingId,
      startedAt: details.startedAt,
    };
  }

  /**
   * `fresh` skips the short response cache and any request already in flight.
   * A refetch prompted by a pushed change needs it: an answer fetched a moment
   * before the change would otherwise be handed back unchanged.
   */
  async getSessionsStatus(
    conversationIds?: string[],
    options?: { fresh?: boolean },
  ): Promise<{
    sessions: Record<string, {
      status: 'completed' | 'ongoing' | 'idle' | 'pending';
      lastActivityAt: string | null;
      provider: Provider | null;
      streamingId: string | null;
      startedAt: string | null;
      runVersion: number | null;
      segmentId: string | null;
      providerSessionId: string | null;
      transitionReason: string | null;
      pendingWork: PendingWork | null;
    }>;
    serverTime: string;
  }> {
    const sanitizedConversationIds = (conversationIds ?? [])
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    const normalizedConversationIds = [...sanitizedConversationIds].sort();

    const query = normalizedConversationIds.length > 0
      ? `?ids=${encodeURIComponent(normalizedConversationIds.join(','))}`
      : '';
    const cacheKey = `${SESSION_STATUS_CACHE_KEY_PREFIX}${normalizedConversationIds.join(',')}`;

    if (options?.fresh) this.invalidateCachedGet(cacheKey);
    return this.cachedGet(cacheKey, SESSION_STATUS_CACHE_TTL_MS, () => this.apiCall(`/api/sessions/status${query}`));
  }

  async createConversation(params: {
    /** Omitted for a coordinator: the server starts it on the configured coordinator provider. */
    provider?: Provider;
    message: string;
    workingDirectory: string;
    model?: string;
    permissionMode?: string;
    workspace?: string;
    systemPrompt?: string;
    initialContent?: ContentBlockParam[];
    goalObjective?: string;
    goalTokenBudget?: number;
    reasoningEffort?: string;
    /** Start as a coordinator: the server prepends the `front` preamble and the session delegates to workers. */
    coordinator?: boolean;
  }): Promise<{
    conversationId: string;
    segmentId: string;
    streamingId: string;
    streamUrl: string;
    sessionId: string;
    provider: Provider;
    cwd: string;
    model: string;
    permissionMode?: string;
    threadId?: string;
    mcpServers?: Array<{ name: string; status: string }>;
  }> {
    const startTime = performance.now();
    const response = await this.apiCall<{
      conversationId: string;
      segmentId: string;
      streamingId: string;
      streamUrl: string;
      sessionId: string;
      provider: Provider;
      cwd: string;
      model: string;
      permissionMode?: string;
      threadId?: string;
      mcpServers?: Array<{ name: string; status: string }>;
    }>('/api/conv/create', {
      method: 'POST',
      body: JSON.stringify(params),
      keepalive: true,
      timeout: 65000,
    });

    reportMilestone(response.conversationId, 'client.create_response_received', {
      durationMs: Math.round(performance.now() - startTime),
    });

    return response;
  }

  async resumeConversation(conversationId: string, params: {
    message: string;
    model?: string;
    permissionMode?: string;
    initialContent?: ContentBlockParam[];
  }): Promise<{
    conversationId: string;
    segmentId: string;
    streamingId: string;
    streamUrl: string;
    sessionId: string;
    provider: Provider;
    cwd: string;
    model: string;
    threadId?: string;
    mcpServers?: Array<{ name: string; status: string }>;
  }> {
    const startTime = performance.now();
    const response = await this.apiCall<{
      conversationId: string;
      segmentId: string;
      streamingId: string;
      streamUrl: string;
      sessionId: string;
      provider: Provider;
      cwd: string;
      model: string;
      threadId?: string;
      mcpServers?: Array<{ name: string; status: string }>;
    }>(`/api/conv/${conversationId}/resume`, {
      method: 'POST',
      body: JSON.stringify(params),
      keepalive: true,
      timeout: 65000,
    });

    reportMilestone(response.conversationId, 'client.resume_response_received', {
      durationMs: Math.round(performance.now() - startTime),
    });

    return response;
  }

  async getUnifiedConversation(conversationId: string): Promise<{
    conversationId: string;
    createdAt: string;
    updatedAt: string;
    workingDirectory: string;
    workspace?: string;
    latestProvider: Provider;
    segments: Array<{
      segmentId: string;
      provider: Provider;
      providerSessionId: string;
      sequenceNumber: number;
      model?: string;
      streamingId?: string;
      status: string;
      startedAt: string;
      endedAt?: string;
    }>;
  }> {
    return this.apiCall(`/api/conv/${conversationId}`);
  }

  async getCodexGoal(conversationId: string): Promise<{ goal: CodexThreadGoal | null }> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${conversationId}/goal`);
  }

  async updateCodexGoal(conversationId: string, params: {
    objective?: string;
    status?: CodexThreadGoal['status'];
    tokenBudget?: number | null;
  }): Promise<{ goal: CodexThreadGoal }> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${conversationId}/goal`, {
      method: 'PUT',
      body: JSON.stringify(params),
    });
  }

  async pauseCodexGoal(conversationId: string): Promise<{ goal: CodexThreadGoal }> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${conversationId}/goal/pause`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async resumeCodexGoal(conversationId: string): Promise<{ goal: CodexThreadGoal }> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${conversationId}/goal/resume`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async clearCodexGoal(conversationId: string): Promise<{ cleared: boolean }> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${conversationId}/goal`, {
      method: 'DELETE',
    });
  }

  async listUnifiedConversations(options?: {
    includeIdentityImage?: boolean;
    archived?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{
    conversations: UnifiedConversationSummary[];
    total: number;
    hasMore?: boolean;
    nextCursor?: string | null;
  }> {
    const searchParams = new URLSearchParams();
    if (options?.includeIdentityImage !== undefined) {
      searchParams.set('includeIdentityImage', String(options.includeIdentityImage));
    }
    if (options?.archived !== undefined) {
      searchParams.set('archived', String(options.archived));
    }
    if (typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
      searchParams.set('limit', String(Math.floor(options.limit)));
    }
    if (typeof options?.cursor === 'string' && options.cursor.trim().length > 0) {
      searchParams.set('cursor', options.cursor);
    }
    const query = searchParams.toString();
    return this.apiCall(query ? `/api/conv?${query}` : '/api/conv');
  }

  async getUnifiedConversationIdentityImage(conversationId: string): Promise<{
    conversationId: string;
    identityImage: string | null;
  }> {
    return this.apiCall(`/api/conv/${conversationId}/identity-image`);
  }

  /** Stop the running turn; `ended` says whether that turn ended, whatever the session went on to do. */
  async stopTurn(conversationId: string): Promise<{ ok: boolean; ended: boolean }> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/harness/${conversationId}/stop`, { method: 'POST' });
  }

  async unifiedForceKillConversation(conversationId: string): Promise<{ success: boolean; error?: string }> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${conversationId}/force-kill`, { method: 'POST' });
  }

  async unifiedUpdateConversation(
    conversationId: string,
    updates: {
      customName?: string;
      pinned?: boolean;
      archived?: boolean;
      continuationSessionId?: string;
      initialCommitHead?: string;
      pausedReason?: string | null;
      permissionMode?: string;
      slept?: boolean;
    }
  ): Promise<{
    success: boolean;
    sessionId: string;
    updatedFields: Record<string, unknown>;
    pinCharacterStatus?: 'created' | 'existing' | 'gemini_not_configured';
    analysisEligibility?: { eligible: boolean; reason?: string };
  }> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${conversationId}/update`, {
      method: 'PUT',
      body: JSON.stringify(updates),
      // A first pin can synchronously create a Gemini portrait. Re-pins and
      // all other metadata updates remain fast, but share the safe ceiling.
      timeout: updates.pinned === true ? 60_000 : undefined,
    });
  }

  async unifiedBranchConversation(conversationId: string, afterTurn: number, timestamp?: string): Promise<{
    success: boolean;
    conversationId: string;
    newSessionId: string;
    turnCount: number;
    messageCount: number;
  }> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${conversationId}/branch`, {
      method: 'POST',
      body: JSON.stringify({ afterTurn, timestamp }),
    });
  }

  async unifiedGetInsights(conversationId: string, quick = true): Promise<SessionInsights> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${conversationId}/insights?quick=${quick}`);
  }

  async unifiedRefreshInsights(conversationId: string): Promise<{ success: boolean; conversationId: string; mission: string | null }> {
    this.assertUnifiedConversationId(conversationId);
    return this.apiCall(`/api/conv/${conversationId}/insights/refresh`, { method: 'POST' });
  }

  async unifiedActivityCheck(
    sessionIds: string[],
    knownMtimes?: Record<string, number>,
    previouslyActiveSessionIds?: string[]
  ): Promise<{
    mtimes: Record<string, number>;
    activeSessionIds: string[];
    insightMtimes?: Record<string, number>;
  }> {
    return this.apiCall('/api/conv/activity-check', {
      method: 'POST',
      body: JSON.stringify({ sessionIds, knownMtimes, previouslyActiveSessionIds }),
    });
  }

  async getConversationIdentityImage(conversationIdOrLegacyId: string): Promise<{
    conversationId: string;
    identityImage: string | null;
  }> {
    const conversationId = await this.resolveCanonicalConversationId(conversationIdOrLegacyId);
    return this.getUnifiedConversationIdentityImage(conversationId);
  }

  async getLastContextTransfer(
    conversationId: string,
    toProvider: 'claude'
  ): Promise<{
    id: string;
    fromProvider: 'claude';
    transferredAt: string;
    sourceLastMessageId: string | null;
  } | null> {
    return this.apiCall(`/api/context-transfers/${conversationId}/last?toProvider=${toProvider}`);
  }

}
