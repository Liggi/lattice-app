/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { useActivityStreamSubscription, useActivityStream } from './ActivityStreamContext';
import type { UnifiedConversationSummary, MiniAction } from '../types';
import { sessionStatusKeys, type SessionStatusInfo } from '../hooks/useSessionStatus';
import type { Provider } from '@/types/unified-messages';

type ConversationProvider = Provider;

interface RecentDirectory {
  lastDate: string;
  shortname: string;
}

// Minimal data needed to show an optimistic session card immediately
export interface OptimisticSession {
  conversationId: string;
  streamingId: string;
  workingDirectory: string;
  model: string;
  permissionMode: string;
  initialPrompt: string;
  workspace: string;
  provider?: ConversationProvider;
}

// Data for a session that's being launched (before API returns)
export interface PendingLaunch {
  tempId: string;  // Temporary ID for tracking
  workingDirectory: string;
  initialPrompt: string;
  model: string;
  permissionMode: string;
  workspace: string;
  provider: ConversationProvider;
}

interface ConversationsContextType {
  conversations: UnifiedConversationSummary[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  recentDirectories: Record<string, RecentDirectory>;
  activeFilters: ConversationFilters;
  setActiveFilters: (filters: ConversationFilters) => void;
  loadMoreConversations: (filters?: ConversationFilters) => Promise<void>;
  invalidateConversations: () => Promise<void>;
  addOptimisticSession: (session: OptimisticSession) => void;
  addPendingLaunch: (launch: PendingLaunch) => void;
  removePendingLaunch: (tempId: string) => void;
  recentActions: Record<string, MiniAction[]>;  // sessionId -> recent action array
  pendingInsightsUpdates: Set<string>;  // sessionIds waiting for insights patch
  setSessionOptimisticOngoing: (sessionId: string, provider?: ConversationProvider) => void;
  recentlyCompletedSessions: Set<string>;  // sessionIds that just finished (auto-clears)
}

interface ConversationFilters {
  archived?: boolean;
  pinned?: boolean;
  hasContinuation?: boolean;
}

const ConversationsContext = createContext<ConversationsContextType | undefined>(undefined);

// Query key factory for consistent cache keys
const conversationKeys = {
  all: ['conversations'] as const,
  list: (workspaceId: string, filters: ConversationFilters) => [...conversationKeys.all, 'list', workspaceId, filters] as const,
  details: (sessionId: string) => [...conversationKeys.all, 'details', sessionId] as const,
};

function isConversationListQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === conversationKeys.all[0] && queryKey[1] === 'list';
}

// With the activity stream connected, liveness arrives as push events and the
// heartbeat is only a safety net for anything the stream missed (e.g. external
// CLI sessions whose transcripts move without harness events). Without the
// stream, it is the sidebar's only liveness signal and runs tight.
const HEARTBEAT_INTERVAL_STREAMING_MS = 60_000;
const HEARTBEAT_INTERVAL_POLLING_MS = 10_000;
// Same split for the bulk status poll beside it.
const STATUS_POLL_STREAMING_MS = 30_000;
const STATUS_POLL_POLLING_MS = 5_000;
const FOCUS_REFRESH_THRESHOLD = 30 * 1000;   // 30 seconds away before refreshing on focus
const IDENTITY_IMAGE_FETCH_CONCURRENCY = 3;
const IDENTITY_IMAGE_FETCH_BATCH_SIZE = 12;
const IDENTITY_IMAGE_RETRY_DELAY_MS = 60_000;
const CONVERSATION_LIST_PAGE_SIZE = 50;

interface ConversationListQueryData {
  conversations: UnifiedConversationSummary[];
  hasMore: boolean;
  nextCursor: string | null;
  total: number;
}

export function getIdentityImageHydrationCandidates(
  conversations: UnifiedConversationSummary[],
  options: {
    inFlight: Set<string>;
    retryAfterBySessionId: Map<string, number>;
    now?: number;
    limit?: number;
  }
): string[] {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? IDENTITY_IMAGE_FETCH_BATCH_SIZE;
  const candidates: string[] = [];

  for (const conversation of conversations) {
    const { conversationId, identityImage } = conversation;

    if (identityImage) continue;
    if (!conversationId.startsWith('conv-')) continue;
    if (options.inFlight.has(conversationId)) continue;

    const retryAfter = options.retryAfterBySessionId.get(conversationId) || 0;
    if (retryAfter > now) continue;

    candidates.push(conversationId);
    if (candidates.length >= limit) break;
  }

  return candidates;
}

export function mergeIdentityImageIntoConversationList(
  conversations: UnifiedConversationSummary[],
  conversationId: string,
  identityImage: string
): UnifiedConversationSummary[] {
  let changed = false;

  const updatedConversations = conversations.map((conversation) => {
    if (conversation.conversationId !== conversationId) {
      return conversation;
    }

    if (conversation.identityImage) {
      return conversation;
    }

    changed = true;
    return {
      ...conversation,
      identityImage,
    };
  });

  return changed ? updatedConversations : conversations;
}

export function mergeIdentityImageCacheIntoConversationList(
  conversations: UnifiedConversationSummary[],
  identityImageBySessionId: Map<string, string>
): UnifiedConversationSummary[] {
  if (identityImageBySessionId.size === 0) {
    return conversations;
  }

  let changed = false;
  const merged = conversations.map((conversation) => {
    if (conversation.identityImage) {
      return conversation;
    }

    const cachedImage = identityImageBySessionId.get(conversation.conversationId);
    if (!cachedImage) {
      return conversation;
    }

    changed = true;
    return {
      ...conversation,
      identityImage: cachedImage,
    };
  });

  return changed ? merged : conversations;
}

export function mergeConversationPageIntoList(params: {
  existing: UnifiedConversationSummary[];
  incoming: UnifiedConversationSummary[];
  pinnedOnly?: boolean;
  identityImageBySessionId?: Map<string, string>;
}): UnifiedConversationSummary[] {
  const {
    existing,
    incoming,
    pinnedOnly = false,
    identityImageBySessionId = new Map<string, string>(),
  } = params;

  const filteredIncoming = pinnedOnly
    ? incoming.filter((conversation) => conversation.pinned)
    : incoming;

  if (filteredIncoming.length === 0 && identityImageBySessionId.size === 0) {
    return existing;
  }

  const mergedById = new Map(existing.map((conversation) => [conversation.conversationId, conversation]));
  for (const conversation of filteredIncoming) {
    mergedById.set(conversation.conversationId, conversation);
  }

  const mergedConversations = Array.from(mergedById.values());
  mergedConversations.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return mergeIdentityImageCacheIntoConversationList(mergedConversations, identityImageBySessionId);
}

export function ConversationsProvider({ children }: { children: ReactNode }): JSX.Element {
  const queryClient = useQueryClient();
  const activeWorkspaceId = 'main';
  const [activeFilters, setActiveFilters] = useState<ConversationFilters>({ archived: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const lastVisibleRef = React.useRef<number>(Date.now());

  // Heartbeat baselines. Refs so they outlive the heartbeat effect, which is
  // re-created every time the conversation list changes identity.
  const knownMtimesRef = React.useRef<Record<string, number>>({});
  const knownInsightMtimesRef = React.useRef<Record<string, number>>({});
  /** null until the first beat establishes a baseline. */
  const previousActiveSessionIdsRef = React.useRef<string[] | null>(null);
  const [recentActions, setRecentActions] = useState<Record<string, MiniAction[]>>({});
  // Session statuses from bulk polling the backend.
  // Single source of truth for session liveness in the frontend.
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, SessionStatusInfo>>({});
  const statusFetchInFlightRef = useRef(false);
  const statusRefetchRequestedRef = useRef(false);
  const [pendingInsightsUpdates, setPendingInsightsUpdates] = useState<Set<string>>(new Set());
  // Optimistic sessions that appear instantly before API confirms
  const [optimisticSessions, setOptimisticSessions] = useState<Map<string, UnifiedConversationSummary>>(new Map());
  // Pending launches that show "launching..." before API even returns
  const [pendingLaunches, setPendingLaunches] = useState<Map<string, UnifiedConversationSummary>>(new Map());
  // Sessions that just completed — used for transient notification badges in sidebar
  const [recentlyCompletedSessions, setRecentlyCompletedSessions] = useState<Set<string>>(new Set());
  const identityImageCacheRef = useRef<Map<string, string>>(new Map());
  const identityImageFetchInFlightRef = useRef<Set<string>>(new Set());
  const identityImageRetryAfterRef = useRef<Map<string, number>>(new Map());

  // One-way optimistic writer: marks a session as 'ongoing' so the sidebar
  // shows active state immediately on send. The next poll corrects if wrong.
  const setSessionOptimisticOngoing = useCallback((sessionId: string, provider?: ConversationProvider) => {
    if (!sessionId.startsWith('conv-')) return;
    setSessionStatuses(prev => {
      if (prev[sessionId]?.status === 'ongoing') return prev;
      const existing = prev[sessionId];
      return {
        ...prev,
        [sessionId]: {
          status: 'ongoing',
          provider: provider ?? existing?.provider ?? null,
          streamingId: existing?.streamingId ?? null,
          startedAt: new Date().toISOString(),
          runVersion: existing?.runVersion ?? null,
          segmentId: existing?.segmentId ?? null,
          providerSessionId: existing?.providerSessionId ?? null,
          transitionReason: existing?.transitionReason ?? null,
        },
      };
    });
  }, []);

  // Track stream connection state to detect reconnection
  const { connectionState } = useActivityStream();
  const prevConnectionStatusRef = useRef(connectionState.status);

  const invalidateConversationLists = useCallback(() => {
    void queryClient.invalidateQueries({
      predicate: (query) => isConversationListQueryKey(query.queryKey),
    });
  }, [queryClient]);

  const refetchConversationLists = useCallback(async () => {
    await queryClient.refetchQueries({
      predicate: (query) => isConversationListQueryKey(query.queryKey),
    });
  }, [queryClient]);

  // Refetch conversations when SSE reconnects after a disconnect
  // This handles events that were missed during disconnection (e.g., session-ended)
  useEffect(() => {
    const prevStatus = prevConnectionStatusRef.current;
    const currentStatus = connectionState.status;
    prevConnectionStatusRef.current = currentStatus;

    // Trigger refetch when recovering to connected from any non-initial state.
    // Covers: reconnecting→connected, disconnected→connected, and the
    // failed→idle→connecting→connected path (where prevStatus is 'connecting').
    if (currentStatus === 'connected' && prevStatus && prevStatus !== 'connected') {
      // Invalidate only conversation list queries to avoid refetching active detail views.
      invalidateConversationLists();
    }
  }, [connectionState.status, invalidateConversationLists]);

  // Debounced invalidation to prevent rapid-fire refetches during active streaming
  const pendingInvalidationsRef = useRef<{ lists: boolean; sessionIds: Set<string> }>({ lists: false, sessionIds: new Set() });
  const invalidationTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const debouncedInvalidate = useCallback((options?: { sessionId?: string; lists?: boolean }) => {
    const { sessionId, lists } = options || {};

    // Track what needs invalidation
    if (sessionId) {
      pendingInvalidationsRef.current.sessionIds.add(sessionId);
    }
    if (lists) {
      pendingInvalidationsRef.current.lists = true;
    }

    // Clear existing timeout and set a new one
    if (invalidationTimeoutRef.current) {
      clearTimeout(invalidationTimeoutRef.current);
    }

    invalidationTimeoutRef.current = setTimeout(() => {
      const { lists: shouldInvalidateLists, sessionIds } = pendingInvalidationsRef.current;

      if (shouldInvalidateLists) {
        invalidateConversationLists();
      }

      // Invalidate specific insight queries
      sessionIds.forEach(id => {
        void queryClient.invalidateQueries({ queryKey: ['insights', id] });
      });

      // Reset tracking
      pendingInvalidationsRef.current = { lists: false, sessionIds: new Set() };
      invalidationTimeoutRef.current = null;
    }, 500);
  }, [queryClient, invalidateConversationLists]);

  // Track known insights timestamps to detect missed updates on reconnect
  const knownInsightsTimestampsRef = useRef<Record<string, string>>({});

  // Ref to decouple the activity message handler from fetchSessionStatuses declaration order.
  // The ref is assigned after fetchSessionStatuses is defined (below).
  const triggerStatusRefetchRef = useRef<() => void>(() => {});

  // Handle activity stream messages via StreamProvider
  const handleActivityMessage = useCallback((data: unknown) => {
    const message = data as {
      type: string;
      sessionId?: string;
      conversationId?: string;
      streamingId?: string;
      sessionIds?: string[];
      streamingIds?: Record<string, string>;
      runVersion?: number | null;
      runVersions?: Record<string, number>;
      recentActions?: MiniAction[];
      timestamps?: Record<string, string>;
      identityImage?: string;
      insightType?: string;
    };

    switch (message.type) {
      case 'session-started': {
        const { sessionId, streamingId } = message;
        if (!sessionId || !sessionId.startsWith('conv-')) break;
        // eslint-disable-next-line no-console
        console.debug(`[status:sse] session-started ${sessionId.slice(0, 12)} sid=${streamingId?.slice(0, 8) ?? '-'}`);
        triggerStatusRefetchRef.current();
        invalidateConversationLists();
        break;
      }

      case 'session-idle': {
        const { sessionId: idleSessionId } = message;
        if (!idleSessionId || !idleSessionId.startsWith('conv-')) break;
        // eslint-disable-next-line no-console
        console.debug(`[status:sse] session-idle ${idleSessionId.slice(0, 12)}`);
        triggerStatusRefetchRef.current();
        invalidateConversationLists();
        break;
      }

      case 'insights-status': {
        // Server sent initial insights timestamps on connect
        const serverTimestamps = message.timestamps || {};

        // Compare with what we knew before - if any are newer, we missed updates
        let missedUpdates = false;
        for (const [sessionId, serverTime] of Object.entries(serverTimestamps)) {
          const knownTime = knownInsightsTimestampsRef.current[sessionId];
          if (knownTime && serverTime > knownTime) {
            missedUpdates = true;
          }
        }

        // Update our known timestamps
        knownInsightsTimestampsRef.current = serverTimestamps;

        // If we detected missed updates, refetch
        if (missedUpdates) {
          invalidateConversationLists();
        }
        break;
      }

      case 'session-status-changed': {
        // Compacting, armed work or a project's asks changed with no turn
        // starting or ending; the status endpoint has the new values.
        if (!message.sessionId?.startsWith('conv-')) break;
        triggerStatusRefetchRef.current();
        break;
      }

      case 'active-sessions': {
        // Server sends list of active sessions — trigger a status refetch.
        // eslint-disable-next-line no-console
        console.debug(`[status:sse] active-sessions received, triggering refetch`);
        triggerStatusRefetchRef.current();
        break;
      }

      case 'activity': {
        const { sessionId, recentActions: actions } = message;

        // Update recent actions array
        if (sessionId && actions && Array.isArray(actions)) {
          setRecentActions(prev => {
            if (actions.length > 0) {
              return { ...prev, [sessionId]: actions };
            } else {
              const updated = { ...prev };
              delete updated[sessionId];
              return updated;
            }
          });
        }
        break;
      }

      case 'insights': {
        // Insights were generated or patched - update cache surgically
        const { sessionId, conversationId, identityImage } = message as {
          sessionId?: string;
          conversationId?: string;
          identityImage?: string;
        };
        if (!sessionId && !conversationId) break;

        const targetSessionIds = new Set<string>();
        if (sessionId) targetSessionIds.add(sessionId);
        if (conversationId) targetSessionIds.add(conversationId);
        if (targetSessionIds.size === 0) break;

        // Clear pending indicator - insights have arrived
        setPendingInsightsUpdates(prev => {
          const next = new Set(prev);
          let changed = false;
          targetSessionIds.forEach((id) => {
            if (next.delete(id)) {
              changed = true;
            }
          });
          return changed ? next : prev;
        });

        // Track that we've seen this insights update
        const now = new Date().toISOString();
        targetSessionIds.forEach((id) => {
          knownInsightsTimestampsRef.current[id] = now;
        });

        // Update per-session insights caches with a fresh patchedAt timestamp.
        // This ensures "Xm ago" labels update immediately without waiting for refetch.
        targetSessionIds.forEach((id) => {

          queryClient.setQueryData(
            ['insights', id],
            (oldInsights: Record<string, unknown> | undefined) => {
              if (!oldInsights) {
                return oldInsights;
              }
              return { ...oldInsights, patchedAt: now };
            }
          );
        });

        // If identity image is included, update it in the cache immediately
        if (identityImage) {
          targetSessionIds.forEach((id) => {
            identityImageCacheRef.current.set(id, identityImage);
          });

          // Update all query caches that might contain this session
          queryClient.setQueriesData(
            { predicate: (query) => isConversationListQueryKey(query.queryKey) },
            (oldData: { conversations?: Array<{ conversationId: string; identityImage: string | null }> } | undefined) => {
              if (!oldData?.conversations) return oldData;

              return {
                ...oldData,
                conversations: oldData.conversations.map((conv) =>
                  targetSessionIds.has(conv.conversationId)
                    ? { ...conv, identityImage }
                    : conv
                )
              };
            }
          );
        }

        // Invalidate BOTH the conversations list AND the individual insights query
        // The conversations list powers the home page TaskList
        // The individual insights query powers the InsightsPanel in ConversationView

        // Debounced invalidation keeps event bursts from hammering details/insights fetches.
        targetSessionIds.forEach((id) => {
          debouncedInvalidate({ sessionId: id });
        });
        debouncedInvalidate({ lists: true });
        break;
      }

      case 'session-ended': {
        const { sessionId, streamingId } = message;
        if (!sessionId || !sessionId.startsWith('conv-')) break;
        // eslint-disable-next-line no-console
        console.debug(`[status:sse] session-ended ${sessionId.slice(0, 12)} sid=${streamingId?.slice(0, 8) ?? '-'}`);

        // Mark as pending insights update - will show subtle indicator until insights SSE arrives
        setPendingInsightsUpdates(prev => {
          const next = new Set(prev);
          next.add(sessionId);
          setTimeout(() => {
            setPendingInsightsUpdates(p => {
              if (!p.has(sessionId)) return p;
              const updated = new Set(p);
              updated.delete(sessionId);
              return updated;
            });
          }, 15000);
          return next;
        });

        // Track as recently completed for notification badge (auto-clears after 10s)
        setRecentlyCompletedSessions(prev => {
          const next = new Set(prev);
          next.add(sessionId);
          return next;
        });
        setTimeout(() => {
          setRecentlyCompletedSessions(prev => {
            if (!prev.has(sessionId)) return prev;
            const next = new Set(prev);
            next.delete(sessionId);
            return next;
          });
        }, 10000);

        // Clear recent actions for this session
        setRecentActions(prev => {
          const updated = { ...prev };
          delete updated[sessionId];
          return updated;
        });

        triggerStatusRefetchRef.current();
        invalidateConversationLists();
        break;
      }

    }
  }, [queryClient, debouncedInvalidate, invalidateConversationLists]);

  // Subscribe to activity stream via the centralized ActivityStreamProvider
  useActivityStreamSubscription({ type: 'activity' }, handleActivityMessage);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (invalidationTimeoutRef.current) {
        clearTimeout(invalidationTimeoutRef.current);
      }
    };
  }, []);

  const apiDirectories: Record<string, RecentDirectory> | undefined = undefined;
  const listQueryKey = React.useMemo(
    () => conversationKeys.list(activeWorkspaceId, activeFilters),
    [activeWorkspaceId, activeFilters]
  );

  // Main conversations query - fetches from unified API only
  const {
    data: queryData,
    isLoading,
    error: queryError,
  } = useQuery<ConversationListQueryData>({
    queryKey: listQueryKey,
    queryFn: async () => {
      // Avoid heavy identity-image blobs in the sidebar list payload.
      // Pass archived filter server-side so we don't receive hundreds of archived
      // conversations just to discard them client-side.
      const unifiedData = await api.listUnifiedConversations({
        includeIdentityImage: false,
        archived: activeFilters.archived,
        limit: CONVERSATION_LIST_PAGE_SIZE,
      });

      const conversations = unifiedData.conversations
        .filter(conv => {
          // Respect pinned filter (archived already handled server-side)
          if (activeFilters.pinned === true && !conv.pinned) return false;
          return true;
        });

      // Sort by updatedAt descending
      conversations.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      const withCachedIdentityImages = mergeIdentityImageCacheIntoConversationList(
        conversations,
        identityImageCacheRef.current
      );

      return {
        conversations: withCachedIdentityImages,
        hasMore: Boolean(unifiedData.hasMore),
        nextCursor: unifiedData.nextCursor ?? null,
        total: unifiedData.total,
      };
    },
    // Keep previous data while fetching new tab's data
    placeholderData: (previousData) => previousData,
  });

  // Unified endpoint returns paged conversations; list query stores accumulated pages.
  const baseConversations = React.useMemo(
    () => queryData?.conversations ?? [],
    [queryData?.conversations]
  );
  const hasMore = queryData?.hasMore ?? false;

  // Merge list with optimistic sessions and pending launches.
  const mergedConversations = React.useMemo(() => {
    const existingIds = new Set(baseConversations.map(c => c.conversationId));

    // Add optimistic sessions that aren't yet in the real data
    // Optimistic sessions go at the start (most recent)
    const optimisticArray = Array.from(optimisticSessions.values())
      .filter(c => !existingIds.has(c.conversationId));

    // Add pending launches (sessions being started, before API returns)
    // These have temporary IDs starting with 'pending-'
    const pendingArray = Array.from(pendingLaunches.values());

    return [...pendingArray, ...optimisticArray, ...baseConversations];
  }, [baseConversations, optimisticSessions, pendingLaunches]);

  const sessionStatusConversationIds = React.useMemo(
    () => mergedConversations
      .map(conversation => conversation.conversationId)
      .filter((conversationId) => conversationId.startsWith('conv-'))
      .sort(),
    [mergedConversations]
  );

  // Fetch all session statuses from the backend and write to sessionStatuses state.
  // Also writes through to React Query cache for useSessionStatus hook compatibility.
  // `fresh` is for a pushed change: the answer must be fetched after it, not
  // served from the short cache or a request that started before it. A call
  // made while a fetch is in flight runs again, fresh, once that one lands.
  const fetchSessionStatuses = useCallback(async (fresh = false) => {
    if (statusFetchInFlightRef.current) {
      statusRefetchRequestedRef.current = true;
      return;
    }
    statusFetchInFlightRef.current = true;
    try {
      const response = await api.getSessionsStatus(
        sessionStatusConversationIds.length > 0 ? sessionStatusConversationIds : undefined,
        { fresh },
      );
      setSessionStatuses(response.sessions);
      // Write through to React Query cache so per-session useSessionStatus hooks
      // (used by ConversationView) see the same data without their own fetch.
      for (const [id, status] of Object.entries(response.sessions)) {
        queryClient.setQueryData<SessionStatusInfo>(sessionStatusKeys.one(id), status);
      }
    } catch { /* bulk poll is best-effort */ }
    statusFetchInFlightRef.current = false;
    if (statusRefetchRequestedRef.current) {
      statusRefetchRequestedRef.current = false;
      void fetchSessionStatuses(true);
    }
  }, [sessionStatusConversationIds, queryClient]);

  // Trigger immediate re-fetch. Called by SSE event handlers via ref.
  const triggerStatusRefetch = useCallback(() => {
    void fetchSessionStatuses(true);
  }, [fetchSessionStatuses]);
  triggerStatusRefetchRef.current = triggerStatusRefetch;

  // Bulk status poll — runs when visible, pauses when hidden. The reliability
  // guarantee: even if every SSE event is missed, status self-corrects within
  // one interval of the tab becoming visible. Push events carry the real-time
  // transitions, so the interval stretches while the stream is connected.
  const streamConnected = connectionState.status === 'connected';
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const intervalMs = streamConnected ? STATUS_POLL_STREAMING_MS : STATUS_POLL_POLLING_MS;

    const startPolling = () => {
      if (interval) return;
      void fetchSessionStatuses();
      interval = setInterval(() => { void fetchSessionStatuses(); }, intervalMs);
    };

    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    };

    // Start immediately if visible
    if (!document.hidden) startPolling();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchSessionStatuses, streamConnected]);

  // Derive activeSessionIds from the polled status map.
  const activeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, status] of Object.entries(sessionStatuses)) {
      if (status.status === 'ongoing') ids.add(id);
    }
    return ids;
  }, [sessionStatuses]);

  // sessionStatusLookup is a reference to the polled status map.
  const sessionStatusLookup = sessionStatuses;

  // Load identity images lazily to keep the main sidebar payload small and
  // avoid tab stalls from parsing many large base64 blobs at once.
  useEffect(() => {
    const candidateSessionIds = getIdentityImageHydrationCandidates(mergedConversations, {
      inFlight: identityImageFetchInFlightRef.current,
      retryAfterBySessionId: identityImageRetryAfterRef.current,
    });

    if (candidateSessionIds.length === 0) {
      return;
    }

    const queue = [...candidateSessionIds];
    const workerCount = Math.min(IDENTITY_IMAGE_FETCH_CONCURRENCY, queue.length);
    let cancelled = false;

    const hydrateNext = async (): Promise<void> => {
      while (!cancelled && queue.length > 0) {
        const sessionId = queue.shift();
        if (!sessionId) return;

        identityImageFetchInFlightRef.current.add(sessionId);

        try {
          const imageResult = await api.getUnifiedConversationIdentityImage(sessionId);
          const identityImage = imageResult.identityImage;

          if (!identityImage) {
            identityImageRetryAfterRef.current.set(sessionId, Date.now() + IDENTITY_IMAGE_RETRY_DELAY_MS);
            continue;
          }

          identityImageCacheRef.current.set(sessionId, identityImage);
          identityImageRetryAfterRef.current.delete(sessionId);

          queryClient.setQueriesData(
            { predicate: (query) => isConversationListQueryKey(query.queryKey) },
            (oldData: unknown) => {
              const typed = oldData as ConversationListQueryData | undefined;
              if (!typed?.conversations) return oldData;

              const nextConversations = mergeIdentityImageIntoConversationList(
                typed.conversations,
                sessionId,
                identityImage
              );
              if (nextConversations === typed.conversations) {
                return oldData;
              }

              return {
                ...typed,
                conversations: nextConversations,
              };
            }
          );
        } catch {
          identityImageRetryAfterRef.current.set(sessionId, Date.now() + IDENTITY_IMAGE_RETRY_DELAY_MS);
        } finally {
          identityImageFetchInFlightRef.current.delete(sessionId);
        }
      }
    };

    void Promise.all(Array.from({ length: workerCount }, () => hydrateNext()));

    return () => {
      cancelled = true;
    };
  }, [mergedConversations, queryClient]);

  // Clean up optimistic sessions once they appear in real data
  useEffect(() => {
    if (optimisticSessions.size === 0) return;

    const realIds = new Set(baseConversations.map(c => c.conversationId));
    const toRemove = Array.from(optimisticSessions.keys()).filter(id => realIds.has(id));

    if (toRemove.length > 0) {
      setOptimisticSessions(prev => {
        const next = new Map(prev);
        toRemove.forEach(id => next.delete(id));
        return next;
      });
    }
  }, [baseConversations, optimisticSessions]);

  // Merge polled status with conversations.
  const conversationsWithLiveStatus = React.useMemo(() => {
    return mergedConversations.map((conversation) => {
      const status = sessionStatusLookup[conversation.conversationId];
      if (!status) {
        return conversation;
      }

      const liveStatus = status.status === 'ongoing'
        ? {
          streamingId: status.streamingId || conversation.streamingId || undefined,
          currentStatus: status.provider === 'codex' ? 'Codex Active' : 'Claude Active',
          connectionState: 'connected' as const,
        }
        : undefined;

      return {
        ...conversation,
        status: status.status,
        pendingWork: status.pendingWork ?? null,
        compacting: status.compacting ?? false,
        failure: status.failure ?? null,
        projectNeedsYou: status.needsYou ?? [],
        projectWorkingOn: status.workingOn ?? null,
        projectWorkerTasks: status.workerTasks ?? null,
        wakeAt: status.wakeAt ?? null,
        latestProvider: status.provider || conversation.latestProvider,
        streamingId: status.streamingId ?? conversation.streamingId ?? null,
        liveStatus,
      };
    });
  }, [mergedConversations, sessionStatusLookup]);

  // Build recent directories from conversations and API data
  const recentDirectories = React.useMemo(() => {
    const directories: Record<string, RecentDirectory> = {};

    // Start with API directories
    if (apiDirectories) {
      Object.assign(directories, apiDirectories);
    }

    // Merge with conversation data
    conversationsWithLiveStatus.forEach(conv => {
      const projectPath = conv.workingDirectory;
      if (projectPath) {
        const pathParts = projectPath.split('/');
        const defaultShortname = pathParts[pathParts.length - 1] ?? projectPath;
        const existingEntry = directories[projectPath] as RecentDirectory | undefined;

        if (!existingEntry ||
            new Date(conv.updatedAt) > new Date(existingEntry.lastDate)) {
          // Prefer API shortname, fall back to computed default
          const apiEntry = apiDirectories?.[projectPath] as RecentDirectory | undefined;
          directories[projectPath] = {
            lastDate: conv.updatedAt,
            shortname: apiEntry?.shortname ?? defaultShortname
          };
        }
      }
    });

    return directories;
  }, [conversationsWithLiveStatus, apiDirectories]);

  // Track which sessions we've already prefetched to avoid redundant fetches
  const prefetchedSessionsRef = useRef<Set<string>>(new Set());

  // Prefetch conversation details for active sessions
  // This ensures clicking into an active session is instant
  useEffect(() => {
    // Keep prefetch lightweight. The details endpoint defaults to returning the full
    // transcript (including tool blocks) when no limit is provided.
    const PREFETCH_MESSAGE_LIMIT = 50;

    const sessionsToPrefetch = Array.from(activeSessionIds).filter(
      sessionId => !prefetchedSessionsRef.current.has(sessionId)
    );

    if (sessionsToPrefetch.length === 0) return;

    // Prefetch each active session's details
    sessionsToPrefetch.forEach(sessionId => {
      prefetchedSessionsRef.current.add(sessionId);

      void queryClient.prefetchQuery({
        queryKey: conversationKeys.details(sessionId),
        queryFn: () => api.getConversationDetails(sessionId, { limit: PREFETCH_MESSAGE_LIMIT, timeout: 10_000 }),
        // Keep prefetched data fresh for 30 seconds
        staleTime: 30_000,
      });
    });

  }, [activeSessionIds, queryClient]);

  // Heartbeat: periodically invalidate cache to pick up backend-generated insights
  // The backend event-driven system handles all insight generation/patching automatically.
  // Frontend just needs to refetch periodically to show updated data.
  useEffect(() => {
    // Baselines live in refs, not effect-locals. This effect is re-created
    // whenever mergedConversations changes identity — which a successful
    // refresh guarantees — so effect-local baselines were wiped on every
    // update, and the comparison below had nothing to compare against.
    const knownMtimes = knownMtimesRef.current;
    const knownInsightMtimes = knownInsightMtimesRef.current;

    const checkActivity = async () => {
      if (document.visibilityState !== 'visible') return;

      // Check all displayed conversations, not just activeSessionIds
      // activeSessionIds tracks file-based activity, but we need to poll for insight updates
      // on any conversation the user might be viewing
      const sessionIds = mergedConversations.map(c => c.conversationId);
      if (sessionIds.length === 0) return;

      try {
        const { mtimes, insightMtimes, activeSessionIds } = await api.unifiedActivityCheck(
          sessionIds,
          knownMtimes,
          previousActiveSessionIdsRef.current ?? []
        );

        // Check if any file mtimes changed
        let hasChanges = false;

        // A session starting or going idle is the change most worth showing,
        // and it does not reliably move a transcript file's mtime. The response
        // already carried this; it was fetched and dropped. Skipped on the very
        // first beat, when there is no baseline to differ from.
        const nextActive = [...(activeSessionIds ?? [])].sort();
        const previousActive = previousActiveSessionIdsRef.current;
        if (previousActive
          && (nextActive.length !== previousActive.length
            || nextActive.some((id, index) => id !== previousActive[index]))) {
          hasChanges = true;
        }
        previousActiveSessionIdsRef.current = nextActive;

        for (const [sessionId, mtime] of Object.entries(mtimes)) {
          if (knownMtimes[sessionId] !== undefined && knownMtimes[sessionId] !== mtime) {
            hasChanges = true;
          }
          knownMtimes[sessionId] = mtime;
        }

        // Also check if any insight timestamps changed (patched_at/computed_at)
        if (insightMtimes) {
          for (const [sessionId, mtime] of Object.entries(insightMtimes)) {
            if (knownInsightMtimes[sessionId] !== undefined && knownInsightMtimes[sessionId] !== mtime) {
              hasChanges = true;
            }
            knownInsightMtimes[sessionId] = mtime;
          }
        }

        if (hasChanges) {
          invalidateConversationLists();
        }
      } catch (_err) {
        // Silently ignore activity check errors
      }
    };

    // Heartbeat interval
    const intervalId = setInterval(
      () => void checkActivity(),
      streamConnected ? HEARTBEAT_INTERVAL_STREAMING_MS : HEARTBEAT_INTERVAL_POLLING_MS,
    );

    // Refresh on window focus (if we've been away long enough)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const timeAway = Date.now() - lastVisibleRef.current;
        if (timeAway > FOCUS_REFRESH_THRESHOLD) {
          invalidateConversationLists();
        }
      } else {
        lastVisibleRef.current = Date.now();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [mergedConversations, invalidateConversationLists, streamConnected]);

  const loadMoreConversations = useCallback(async (_filters?: ConversationFilters) => {
    if (loadingMore) return;
    if (!queryData?.hasMore || !queryData.nextCursor) return;

    setLoadingMore(true);
    try {
      const unifiedData = await api.listUnifiedConversations({
        includeIdentityImage: false,
        archived: activeFilters.archived,
        limit: CONVERSATION_LIST_PAGE_SIZE,
        cursor: queryData.nextCursor,
      });

      queryClient.setQueryData<ConversationListQueryData>(listQueryKey, (previousData) => {
        const existing = previousData?.conversations ?? [];
        const mergedConversations = mergeConversationPageIntoList({
          existing,
          incoming: unifiedData.conversations,
          pinnedOnly: activeFilters.pinned === true,
          identityImageBySessionId: identityImageCacheRef.current,
        });

        return {
          conversations: mergedConversations,
          hasMore: Boolean(unifiedData.hasMore),
          nextCursor: unifiedData.nextCursor ?? null,
          total: unifiedData.total,
        };
      });
    } finally {
      setLoadingMore(false);
    }
  }, [
    activeFilters.archived,
    activeFilters.pinned,
    listQueryKey,
    loadingMore,
    queryClient,
    queryData?.hasMore,
    queryData?.nextCursor,
  ]);

  const invalidateConversations = useCallback(async () => {
    await refetchConversationLists();
  }, [refetchConversationLists]);

  // Add an optimistic session that appears immediately in the sidebar
  // It will be replaced by real data when the next refetch completes
  const addOptimisticSession = useCallback((session: OptimisticSession) => {
    const now = new Date().toISOString();

    const optimistic: UnifiedConversationSummary = {
      conversationId: session.conversationId,
      streamingId: session.streamingId,
      workingDirectory: session.workingDirectory,
      workspace: session.workspace,
      latestProvider: session.provider || 'claude',
      providersUsed: [session.provider || 'claude'],
      activeProvider: session.provider || 'claude',
      segmentCount: 1,
      customName: '',
      pinned: false,
      archived: false,
      pausedReason: null,
      importedAt: null,
      permissionMode: session.permissionMode,
      identityImage: null,
      pinCharacterName: null,
      pinCharacterImage: null,
      initialPromptPreview: session.initialPrompt,
      createdAt: now,
      updatedAt: now,
      status: 'ongoing',
      // Visual indicator that this is optimistic/loading
      liveStatus: {
        streamingId: session.streamingId,
        currentStatus: 'Thinking',
        connectionState: 'connected',
      },
    };

    setOptimisticSessions(prev => {
      const next = new Map(prev);
      next.set(session.conversationId, optimistic);
      return next;
    });

    // Mark as ongoing in the status map so the sidebar shows it as active immediately.
    // Also seed the React Query cache for useSessionStatus in the ConversationView.
    const optimisticStatus: SessionStatusInfo = {
      status: 'ongoing',
      provider: session.provider || 'claude',
      streamingId: session.streamingId,
      startedAt: new Date().toISOString(),
      runVersion: null,
      segmentId: null,
      providerSessionId: null,
      transitionReason: null,
    };
    setSessionStatuses(prev => ({ ...prev, [session.conversationId]: optimisticStatus }));
    queryClient.setQueryData<SessionStatusInfo>(sessionStatusKeys.one(session.conversationId), {
      status: 'ongoing',
      provider: session.provider || 'claude',
      streamingId: session.streamingId,
      startedAt: now,
      runVersion: null,
      segmentId: null,
      providerSessionId: null,
      transitionReason: null,
    });

  }, [queryClient]);

  // Add a pending launch placeholder that appears INSTANTLY (before API returns)
  // This shows "Launching..." in the sidebar while the session starts
  const addPendingLaunch = useCallback((launch: PendingLaunch) => {
    const now = new Date().toISOString();

    const pending: UnifiedConversationSummary = {
      conversationId: launch.tempId, // Temporary ID (starts with 'pending-')
      streamingId: null,
      workingDirectory: launch.workingDirectory,
      workspace: launch.workspace,
      latestProvider: launch.provider,
      providersUsed: [launch.provider],
      activeProvider: launch.provider,
      segmentCount: 0,
      customName: '',
      pinned: false,
      archived: false,
      pausedReason: null,
      importedAt: null,
      permissionMode: launch.permissionMode,
      identityImage: null,
      pinCharacterName: null,
      pinCharacterImage: null,
      initialPromptPreview: launch.initialPrompt,
      createdAt: now,
      updatedAt: now,
      status: 'pending', // Special status for launching sessions
      liveStatus: {
        streamingId: undefined,
        currentStatus: 'Launching',
        connectionState: 'connecting',
      },
    };

    setPendingLaunches(prev => {
      const next = new Map(prev);
      next.set(launch.tempId, pending);
      return next;
    });

  }, []);

  // Remove a pending launch (called when API returns or fails)
  const removePendingLaunch = useCallback((tempId: string) => {
    setPendingLaunches(prev => {
      const next = new Map(prev);
      next.delete(tempId);
      return next;
    });
  }, []);

  // Every consumer of this context re-renders when the value identity changes, so
  // an inline object literal here would push a render through the whole sidebar and
  // conversation view on every provider render.
  const contextValue = React.useMemo<ConversationsContextType>(
    () => ({
      conversations: conversationsWithLiveStatus,
      loading: isLoading,
      loadingMore,
      hasMore,
      error: queryError ? 'Failed to load conversations' : null,
      recentDirectories,
      activeFilters,
      setActiveFilters,
      loadMoreConversations,
      invalidateConversations,
      addOptimisticSession,
      addPendingLaunch,
      removePendingLaunch,
      recentActions,
      pendingInsightsUpdates,
      setSessionOptimisticOngoing,
      recentlyCompletedSessions,
    }),
    [
      conversationsWithLiveStatus,
      isLoading,
      loadingMore,
      hasMore,
      queryError,
      recentDirectories,
      activeFilters,
      setActiveFilters,
      loadMoreConversations,
      invalidateConversations,
      addOptimisticSession,
      addPendingLaunch,
      removePendingLaunch,
      recentActions,
      pendingInsightsUpdates,
      setSessionOptimisticOngoing,
      recentlyCompletedSessions,
    ]
  );

  return (
    <ConversationsContext.Provider value={contextValue}>
      {children}
    </ConversationsContext.Provider>
  );
}

export function useConversations(): ConversationsContextType {
  const context = useContext(ConversationsContext);
  if (context === undefined) {
    throw new Error('useConversations must be used within a ConversationsProvider');
  }
  return context;
}

// Export query keys for consistent cache key usage across components
export { conversationKeys };
