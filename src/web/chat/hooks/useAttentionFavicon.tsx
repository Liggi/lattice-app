import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { useActivityStream, useActivityStreamSubscription } from '../contexts/ActivityStreamContext';

const FAVICON_LINK_ID = 'app-favicon';
const DEFAULT_FAVICON_HREF = '/favicon.png';
const ATTENTION_FAVICON_HREF = '/favicon-attention.svg';
const ATTENTION_POLL_INTERVAL_MS = 5_000;
/** Safety-net interval while push events drive attention state. */
const ATTENTION_POLL_STREAMING_MS = 60_000;

/** Stream event types that can change what needs attention. */
const ATTENTION_EVENT_TYPES = new Set([
  'pending-questions-changed',
  'permission-request',
  'permission-updated',
  'session-idle',
  'session-ended',
]);

function getFaviconType(href: string): string {
  return href.endsWith('.png') ? 'image/png' : 'image/svg+xml';
}

export type AttentionState = {
  permissionCount: number;
  questionCount: number;
  /** conversationId → count of pending permissions + questions for that session */
  sessionAttention: Record<string, number>;
};

export const ATTENTION_QUERY_KEY = ['attention-favicon'] as const;

function ensureFaviconLink(): HTMLLinkElement {
  const existing = document.getElementById(FAVICON_LINK_ID);
  if (existing instanceof HTMLLinkElement) {
    return existing;
  }

  const link = document.createElement('link');
  link.id = FAVICON_LINK_ID;
  link.rel = 'icon';
  link.type = getFaviconType(DEFAULT_FAVICON_HREF);
  document.head.appendChild(link);
  return link;
}

export function syncAttentionFavicon(needsAttention: boolean): void {
  if (typeof document === 'undefined') return;

  const faviconLink = ensureFaviconLink();
  const href = needsAttention ? ATTENTION_FAVICON_HREF : DEFAULT_FAVICON_HREF;
  faviconLink.rel = 'icon';
  faviconLink.type = getFaviconType(href);
  faviconLink.href = href;
}

async function fetchAttentionState(): Promise<AttentionState> {
  const [permissionsResult, pendingQuestionsResult] = await Promise.all([
    api.getPermissions({ status: 'pending' }),
    api.getPendingQuestions(),
  ]);

  // Build per-conversation attention map keyed by conversationId (conv-*).
  // The backend resolves provider session IDs → conversationId for us.
  const sessionAttention: Record<string, number> = {};

  for (const perm of permissionsResult.permissions) {
    const key = perm.conversationId || perm.sessionId;
    if (key) {
      sessionAttention[key] = (sessionAttention[key] || 0) + 1;
    }
  }

  for (const q of pendingQuestionsResult.questions) {
    const key = q.conversationId || q.sessionId;
    if (key) {
      sessionAttention[key] = (sessionAttention[key] || 0) + 1;
    }
  }

  return {
    permissionCount: permissionsResult.permissions.length,
    questionCount: pendingQuestionsResult.questions.length,
    sessionAttention,
  };
}

export function AttentionFaviconController(): null {
  const queryClient = useQueryClient();
  const { isConnected } = useActivityStream();
  const { data } = useQuery({
    queryKey: ATTENTION_QUERY_KEY,
    queryFn: fetchAttentionState,
    staleTime: 2_000,
    refetchInterval: isConnected ? ATTENTION_POLL_STREAMING_MS : ATTENTION_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  // Invalidate on any push event that can change attention state. This is the
  // single central subscription for the shared attention query — the
  // per-session useSessionAttention readers share the cache entry.
  useActivityStreamSubscription({ type: 'activity' }, (event) => {
    const payload = event as { type?: string };
    if (!payload.type || !ATTENTION_EVENT_TYPES.has(payload.type)) return;
    void queryClient.invalidateQueries({ queryKey: ATTENTION_QUERY_KEY });
  });

  const needsAttention = (data?.permissionCount || 0) > 0 || (data?.questionCount || 0) > 0;

  useEffect(() => {
    syncAttentionFavicon(needsAttention);
    return () => {
      syncAttentionFavicon(false);
    };
  }, [needsAttention]);

  return null;
}

/**
 * Hook to check if a specific session has pending attention items.
 * Reads from the same query cache as the favicon controller (no extra API calls).
 */
export function useSessionAttention(conversationId: string | undefined): boolean {
  const { isConnected } = useActivityStream();
  const { data } = useQuery({
    queryKey: ATTENTION_QUERY_KEY,
    queryFn: fetchAttentionState,
    staleTime: 2_000,
    refetchInterval: isConnected ? ATTENTION_POLL_STREAMING_MS : ATTENTION_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  if (!data || !conversationId) return false;
  return (data.sessionAttention[conversationId] || 0) > 0;
}
