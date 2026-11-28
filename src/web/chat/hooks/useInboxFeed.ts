import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { InboxFeedResponse } from '@/types/inbox-feed';

export const inboxFeedQueryKey = ['inbox-feed'] as const;

const POLL_MS = 20_000;

/** Thrown when the server has no `/api/inbox` (an older server), so polling stops. */
class InboxUnavailableError extends Error {}

async function fetchInbox(): Promise<InboxFeedResponse> {
  const response = await fetch('/api/inbox');
  if (response.status === 404) throw new InboxUnavailableError('This server has no Inbox yet');
  if (!response.ok) {
    const parsed = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(parsed?.error ?? `HTTP ${response.status}`);
  }
  return await response.json() as InboxFeedResponse;
}

/**
 * The Inbox feed, shared by the page and the sidebar's count. Polls gently
 * and on window focus; a server without the route is asked once, not polled.
 */
export function useInboxFeed(): UseQueryResult<InboxFeedResponse> & { unavailable: boolean } {
  const query = useQuery({
    queryKey: inboxFeedQueryKey,
    queryFn: fetchInbox,
    refetchInterval: (q) => (q.state.error instanceof InboxUnavailableError ? false : POLL_MS),
    refetchOnWindowFocus: true,
    staleTime: 5_000,
    retry: (count, error) => !(error instanceof InboxUnavailableError) && count < 1,
  });
  return Object.assign(query, { unavailable: query.error instanceof InboxUnavailableError });
}

/** Refetches the feed now, after an action or a burst of session activity. */
export function useRefreshInbox(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => { void queryClient.invalidateQueries({ queryKey: inboxFeedQueryKey }); }, [queryClient]);
}
