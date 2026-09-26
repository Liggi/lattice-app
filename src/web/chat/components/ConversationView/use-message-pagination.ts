import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ChatMessage, Turn } from '../../types';

export function useMessagePagination(params: {
  conversationId?: string;
  combinedMessages: ChatMessage[];
  fetchHistory: (opts?: { limit?: number }) => Promise<{ hasMore: boolean }>;
  initialMessageLimit: number;
}): {
  hasMoreMessages: boolean;
  setHasMoreMessages: Dispatch<SetStateAction<boolean>>;
  isLoadingMore: boolean;
  jumpToMessageId: string | null;
  setJumpToMessageId: Dispatch<SetStateAction<string | null>>;
  loadMoreMessages: () => Promise<void>;
  handleJumpToTurn: (turn: Turn) => Promise<void>;
} {
  const { conversationId, fetchHistory, initialMessageLimit } = params;
  // Start with hasMore=true — the SSE initial replay only sends the current turn,
  // so there are almost always older events in storage.
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [jumpToMessageId, setJumpToMessageId] = useState<string | null>(null);
  // Synchronous mutex — `isLoadingMore` is React state and isn't committed
  // until the next render, so two observer callbacks can both pass the guard.
  const isLoadingMoreRef = useRef(false);

  const loadMoreMessages = useCallback(async () => {
    if (!conversationId || !hasMoreMessages || isLoadingMoreRef.current) return;

    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const result = await fetchHistory({ limit: initialMessageLimit });
      setHasMoreMessages(result.hasMore);
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [conversationId, hasMoreMessages, fetchHistory, initialMessageLimit]);

  const handleJumpToTurn = useCallback(async (_turn: Turn): Promise<void> => {
    // TODO: Jump-to-turn needs a server-side turn lookup in the harness.
    // For now, just load more history pages until we have enough.
    if (!conversationId) return;

    setIsLoadingMore(true);
    try {
      let hasMore = true;
      let pagesLoaded = 0;
      const MAX_PAGES = 40;
      while (hasMore && pagesLoaded < MAX_PAGES) {
        const result = await fetchHistory({ limit: initialMessageLimit });
        hasMore = result.hasMore;
        pagesLoaded++;
      }
      setHasMoreMessages(hasMore);
    } catch (err) {
      console.error('Failed to load history for jump-to-turn:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [conversationId, fetchHistory, initialMessageLimit]);

  return {
    hasMoreMessages,
    setHasMoreMessages,
    isLoadingMore,
    jumpToMessageId,
    setJumpToMessageId,
    loadMoreMessages,
    handleJumpToTurn,
  };
}
