import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import type { UnifiedConversationSummary } from '../types';

const ARCHIVED_SIDEBAR_PAGE_SIZE = 200;

export const archivedSidebarQueryKey = ['conversations', 'archived-sidebar'] as const;

interface UseArchivedSidebarSessionsOptions {
  enabled: boolean;
}

interface UseArchivedSidebarSessionsResult {
  archivedSessions: UnifiedConversationSummary[];
  isLoading: boolean;
}

export function useArchivedSidebarSessions(
  options: UseArchivedSidebarSessionsOptions
): UseArchivedSidebarSessionsResult {
  const { enabled } = options;

  const { data, isLoading } = useQuery({
    queryKey: archivedSidebarQueryKey,
    queryFn: async () => {
      const response = await api.listUnifiedConversations({
        archived: true,
        includeIdentityImage: false,
        limit: ARCHIVED_SIDEBAR_PAGE_SIZE,
      });

      // Server order: most recently archived first. Re-sorting by updatedAt here
      // sorted by creation time, which buried a session archived a moment ago.
      return (response.conversations || []).filter((conversation) => conversation.archived);
    },
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  return {
    archivedSessions: data || [],
    isLoading,
  };
}
