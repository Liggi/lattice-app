import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { conversationKeys } from '../../contexts/ConversationsContext';
import { sessionStatusKeys } from '../../hooks/useSessionStatus';

/**
 * Delay (ms) before invalidating queries after tab becomes visible.
 * Gives the browser's network stack time to wake up after being
 * backgrounded — without this, immediate fetches often fail with
 * "Failed to fetch" / "Load failed" because the connection hasn't
 * re-established yet.
 */
const VISIBILITY_REFETCH_DELAY_MS = 300;

export function useSessionVisibilityRefresh(params: {
  conversationId?: string;
  queryClient: QueryClient;
}): void {
  const { conversationId, queryClient } = params;

  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && conversationId) {
        // Small delay to let the network stack recover from backgrounding.
        // Browser connections (especially on mobile) may not be ready
        // immediately when the tab resumes.
        timerId = setTimeout(() => {
          // eslint-disable-next-line no-console
          console.debug(`[DETAIL-TRACE] visibility-refresh invalidating details for ${conversationId?.slice(0, 12)}`);
          void queryClient.invalidateQueries({ queryKey: conversationKeys.details(conversationId) });
          void queryClient.invalidateQueries({ queryKey: sessionStatusKeys.one(conversationId) });
        }, VISIBILITY_REFETCH_DELAY_MS);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timerId) clearTimeout(timerId);
    };
  }, [conversationId, queryClient]);
}
