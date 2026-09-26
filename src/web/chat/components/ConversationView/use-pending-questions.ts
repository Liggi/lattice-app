import { useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import { useActivityStream, useActivityStreamSubscription } from '../../contexts/ActivityStreamContext';
import type { PendingQuestion } from '../../types';

export function usePendingQuestions(params: {
  conversationId?: string;
  isSessionIdle: boolean;
  reconnectToStream: (streamingId: string) => void;
}): {
  pendingQuestions: PendingQuestion[];
  handleAnswerPendingQuestion: (
    questionId: string,
    answers: Record<string, string>
  ) => Promise<Awaited<ReturnType<typeof api.answerPendingQuestion>>>;
  handleDismissPendingQuestion: (questionId: string) => Promise<void>;
  refetchPendingQuestions: () => Promise<unknown>;
} {
  const { conversationId, isSessionIdle, reconnectToStream } = params;
  const { isConnected } = useActivityStream();
  const {
    data: pendingQuestionsData,
    refetch,
  } = useQuery({
    queryKey: ['pendingQuestions', conversationId],
    queryFn: () => api.getPendingQuestions(conversationId),
    enabled: !!conversationId,
    // Question lifecycle arrives as pending-questions-changed push events
    // (refetched below); the interval is a safety net. Without the stream,
    // fall back to the old tight poll — Codex request_user_input keeps the
    // turn alive while it waits, so questions appear mid-turn too.
    refetchInterval: isConnected ? 30_000 : 2_500,
    staleTime: 10_000,
  });

  const pendingQuestions = pendingQuestionsData?.questions || [];

  // Server pushes question mutations. Events carry the session the change
  // belongs to when known; a null sessionId means a bulk change (expiry
  // sweeps), which is rare enough to just refetch on.
  useActivityStreamSubscription({ type: 'activity' }, (event) => {
    if (!conversationId) return;
    const payload = event as { type?: string; sessionId?: string | null };
    if (payload.type !== 'pending-questions-changed') return;
    if (payload.sessionId && payload.sessionId !== conversationId) return;
    void refetch();
  });

  // When session transitions to idle (e.g., after AskUserQuestion stops the process),
  // refetch pending questions immediately so the question UI appears without needing a refresh.
  const prevIsIdleRef = useRef(isSessionIdle);
  useEffect(() => {
    if (isSessionIdle && !prevIsIdleRef.current) {
      void refetch();
    }
    prevIsIdleRef.current = isSessionIdle;
  }, [isSessionIdle, refetch]);

  const handleAnswerPendingQuestion = useCallback(async (questionId: string, answers: Record<string, string>) => {
    const result = await api.answerPendingQuestion(questionId, answers);
    void refetch();

    // The answer API spawns a NEW CLI process with --resume, returning a new streamingId.
    // Reconnect the SSE stream to pick up output from the resumed session.
    if (result.streamingId) {
      reconnectToStream(result.streamingId);
    }

    return result;
  }, [reconnectToStream, refetch]);

  const handleDismissPendingQuestion = useCallback(async (questionId: string) => {
    try {
      await api.expirePendingQuestion(questionId);
      void refetch();
    } catch (err) {
      console.error('Failed to dismiss pending question:', err);
    }
  }, [refetch]);

  return {
    pendingQuestions,
    handleAnswerPendingQuestion,
    handleDismissPendingQuestion,
    refetchPendingQuestions: refetch,
  };
}
