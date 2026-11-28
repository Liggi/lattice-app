import { useCallback, useRef } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { JobsFeedResponse } from '@/types/jobs';
import { useActivityStreamSubscription } from '../contexts/ActivityStreamContext';

export const JOBS_FEED_QUERY_KEY = ['jobs-feed'] as const;

const ACTIVITY_DEBOUNCE_MS = 1_500;

async function fetchJobsFeed(): Promise<JobsFeedResponse> {
  const res = await fetch('/api/jobs');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<JobsFeedResponse>;
}

/**
 * Live unified jobs feed across local Lattice jobs and plugin providers.
 * Refetches immediately on `jobs-changed` SSE events, plus a gentle poll for
 * remote plugin providers.
 */
export type UseJobsFeedResult = UseQueryResult<JobsFeedResponse> & { refresh: () => void };

export function useJobsFeed(opts: { active?: boolean } = {}): UseJobsFeedResult {
  const active = opts.active ?? false;
  const queryClient = useQueryClient();
  const lastRefresh = useRef(0);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: JOBS_FEED_QUERY_KEY });
  }, [queryClient]);

  useActivityStreamSubscription({ type: 'activity' }, (event) => {
    if ((event as { type?: string }).type !== 'jobs-changed') return;
    const now = Date.now();
    if (now - lastRefresh.current < ACTIVITY_DEBOUNCE_MS) return;
    lastRefresh.current = now;
    refresh();
  });

  const query = useQuery<JobsFeedResponse>({
    queryKey: JOBS_FEED_QUERY_KEY,
    queryFn: fetchJobsFeed,
    refetchInterval: active ? 15_000 : 60_000,
    staleTime: 5_000,
    retry: 1,
  });

  return { ...query, refresh };
}
