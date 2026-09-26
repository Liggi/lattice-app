import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { useActivityStream, useActivityStreamSubscription } from '../contexts/ActivityStreamContext';
import type { NeedsYouItem, PendingWork, RunFailure } from '../types';
import type { Provider } from '@/types/unified-messages';

export interface SessionStatusInfo {
  status: 'ongoing' | 'idle' | 'completed' | 'pending';
  provider: Provider | null;
  streamingId: string | null;
  startedAt: string | null;
  runVersion: number | null;
  segmentId: string | null;
  providerSessionId: string | null;
  transitionReason: string | null;
  /**
   * Outstanding work that will wake the session without user input. Optional
   * because the optimistic setters below build a status locally, before any
   * poll has told us what the event log says.
   */
  pendingWork?: PendingWork | null;
  /** A context compaction is in flight (event-log derived). */
  compacting?: boolean;
  /** The latest turn or run ended in an error (event-log derived). */
  failure?: RunFailure | null;
  needsYou?: NeedsYouItem[];
  /** On a project: its Working on line. */
  workingOn?: string | null;
  /** On a project: each worker's task, keyed by worker conversation id. */
  workerTasks?: Record<string, string> | null;
  /** When a scheduled wake-up fires, epoch ms. */
  wakeAt?: number | null;
  lastTurnUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
}

const COMPLETED_STATUS: SessionStatusInfo = {
  status: 'completed',
  provider: null,
  streamingId: null,
  startedAt: null,
  runVersion: null,
  segmentId: null,
  providerSessionId: null,
  transitionReason: null,
  pendingWork: null,
};

export const sessionStatusKeys = {
  all: ['session-status'] as const,
  one: (conversationId: string) => ['session-status', conversationId] as const,
};

export function useSessionStatus(conversationId: string | undefined): {
  status: SessionStatusInfo['status'];
  provider: SessionStatusInfo['provider'];
  streamingId: SessionStatusInfo['streamingId'];
  startedAt: SessionStatusInfo['startedAt'];
  runVersion: SessionStatusInfo['runVersion'];
  segmentId: SessionStatusInfo['segmentId'];
  providerSessionId: SessionStatusInfo['providerSessionId'];
  transitionReason: SessionStatusInfo['transitionReason'];
  pendingWork: SessionStatusInfo['pendingWork'];
  compacting: boolean;
  lastTurnUsage: SessionStatusInfo['lastTurnUsage'];
  isOngoing: boolean;
  isIdle: boolean;
  isCompleted: boolean;
  isFetching: boolean;
  isLoading: boolean;
  dataUpdatedAt: number;
  setOptimisticOngoing: (options?: { streamingId?: string | null; provider?: Provider }) => void;
  setOptimisticCompleted: () => void;
} {
  const queryClient = useQueryClient();
  const { connectionState, isConnected } = useActivityStream();
  const previousConnectionStatusRef = useRef(connectionState.status);
  const normalizedConversationId = (conversationId || '').trim();
  const enabled = normalizedConversationId.startsWith('conv-');

  const query = useQuery({
    queryKey: sessionStatusKeys.one(normalizedConversationId),
    queryFn: async (): Promise<SessionStatusInfo> => {
      if (!enabled) {
        return COMPLETED_STATUS;
      }

      const response = await api.getSessionsStatus([normalizedConversationId]);
      const result = response.sessions[normalizedConversationId] ?? COMPLETED_STATUS;
      // eslint-disable-next-line no-console
      console.debug(`[status:query] ${normalizedConversationId.slice(0, 12)} fetched=${result.status} sid=${result.streamingId?.slice(0, 8) ?? '-'}`);
      return result;
    },
    enabled,
    // With the activity stream connected, session transitions arrive as push
    // events (invalidated below) and the bulk poll in ConversationsContext
    // write-throughs into this cache — the interval is only a safety net.
    // Without the stream, fall back to the old 5s poll.
    refetchInterval: enabled ? (isConnected ? 60_000 : 5_000) : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  useActivityStreamSubscription({ type: 'activity' }, (event) => {
    if (!enabled) return;

    const payload = event as {
      type?: string;
      sessionId?: string;
    };

    if (payload.sessionId !== normalizedConversationId) return;

    if (payload.type === 'session-started' || payload.type === 'session-ended' || payload.type === 'session-idle') {
      void queryClient.invalidateQueries({ queryKey: sessionStatusKeys.one(normalizedConversationId) });
    }
  });

  useEffect(() => {
    if (!enabled) return;

    const previousStatus = previousConnectionStatusRef.current;
    const currentStatus = connectionState.status;
    previousConnectionStatusRef.current = currentStatus;

    if (currentStatus === 'connected' && previousStatus && previousStatus !== 'connected') {
      // eslint-disable-next-line no-console
      console.debug(`[DETAIL-TRACE] status-reconnect invalidating session-status for ${normalizedConversationId?.slice(0, 12)} (${previousStatus}→${currentStatus})`);
      void queryClient.invalidateQueries({ queryKey: sessionStatusKeys.one(normalizedConversationId) });
    }
  }, [connectionState.status, enabled, normalizedConversationId, queryClient]);

  const setOptimisticOngoing = (options?: { streamingId?: string | null; provider?: Provider }): void => {
    if (!enabled) return;
    queryClient.setQueryData<SessionStatusInfo>(sessionStatusKeys.one(normalizedConversationId), {
      status: 'ongoing',
      provider: options?.provider ?? 'claude',
      streamingId: options?.streamingId ?? null,
      startedAt: new Date().toISOString(),
      runVersion: null,
      segmentId: null,
      providerSessionId: null,
      transitionReason: null,
      pendingWork: null,
    });
  };

  const setOptimisticCompleted = (): void => {
    if (!enabled) return;
    const prev = queryClient.getQueryData<SessionStatusInfo>(sessionStatusKeys.one(normalizedConversationId));
    queryClient.setQueryData<SessionStatusInfo>(sessionStatusKeys.one(normalizedConversationId), {
      ...COMPLETED_STATUS,
      lastTurnUsage: prev?.lastTurnUsage,
    });
  };

  return {
    status: query.data?.status ?? 'completed',
    provider: query.data?.provider ?? null,
    streamingId: query.data?.streamingId ?? null,
    startedAt: query.data?.startedAt ?? null,
    runVersion: query.data?.runVersion ?? null,
    segmentId: query.data?.segmentId ?? null,
    providerSessionId: query.data?.providerSessionId ?? null,
    transitionReason: query.data?.transitionReason ?? null,
    pendingWork: query.data?.pendingWork ?? null,
    compacting: query.data?.compacting ?? false,
    lastTurnUsage: query.data?.lastTurnUsage ?? null,
    isOngoing: query.data?.status === 'ongoing',
    isIdle: query.data?.status === 'idle',
    isCompleted: query.data?.status !== 'ongoing' && query.data?.status !== 'idle',
    isFetching: query.isFetching,
    isLoading: query.isLoading,
    dataUpdatedAt: query.dataUpdatedAt,
    setOptimisticOngoing,
    setOptimisticCompleted,
  };
}
