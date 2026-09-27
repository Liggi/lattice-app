import { useEffect, useMemo, useState } from 'react';
import { useConversations } from '../contexts/ConversationsContext';
import { useSessionAttentionMap } from './useAttentionFavicon';
import { sidebarLists } from '../utils/sidebar-ordering';

const CLOCK_TICK_MS = 60_000;

/**
 * The sidebar's lists (see sidebarLists), shared by the sidebar and Ctrl+Tab so
 * both walk the same order. Recomputed each minute as well as on new data, so
 * a session that goes quiet moves into Sleeping without waiting for a refresh.
 */
export function useSidebarLists(): ReturnType<typeof sidebarLists> {
  const { conversations } = useConversations();
  const sessionAttention = useSessionAttentionMap();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return useMemo(
    () => sidebarLists(conversations, sessionAttention, now),
    [conversations, sessionAttention, now],
  );
}
