import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../services/api';
import type { FeedbackDraftView, FeedbackProposalView, FeedbackStatus } from '@/types/feedback';

export const feedbackStatusQueryKey = ['feedback', 'status'] as const;
export const feedbackDraftsQueryKey = ['feedback', 'drafts'] as const;
export const feedbackInboxQueryKey = ['feedback', 'inbox'] as const;

export function useFeedbackStatus(): FeedbackStatus | null {
  const { data } = useQuery({
    queryKey: feedbackStatusQueryKey,
    queryFn: () => api.getFeedbackStatus(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  return data ?? null;
}

/** Drafts waiting to be sent; only fetched while feedback is on. */
export function useFeedbackDrafts(enabled: boolean): FeedbackDraftView[] {
  const { data } = useQuery({
    queryKey: feedbackDraftsQueryKey,
    queryFn: async () => (await api.listFeedbackDrafts()).drafts,
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    refetchOnWindowFocus: false,
  });
  return enabled ? data ?? [] : [];
}

/** Unread count for the sidebar; only on a Lattice that has an inbox. */
export function useFeedbackInboxUnread(enabled: boolean): number | null {
  const { data } = useQuery({
    queryKey: [...feedbackInboxQueryKey, 'unread'],
    queryFn: async () => (await api.getFeedbackInboxUnread()).unread,
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    refetchOnWindowFocus: false,
  });
  return data ?? null;
}

/** An agent proposal's card: the draft while it waits, then what became of it. */
export function useFeedbackProposal(draftId: string): { proposal: FeedbackProposalView | null; error: unknown } {
  const { data, error } = useQuery({
    queryKey: ['feedback', 'proposal', draftId],
    queryFn: () => api.getFeedbackProposal(draftId),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  return { proposal: data ?? null, error };
}

export function useInvalidateFeedback(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['feedback'] });
  }, [queryClient]);
}
