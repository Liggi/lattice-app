import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AUTO_SCROLL_THRESHOLD_PX } from './message-list-constants';

interface MessageLike {
  id?: string;
  messageId?: string;
}

export function useScrollManagement(params: {
  sessionId?: string;
  messages: MessageLike[];
  isStreaming?: boolean;
  scrollContainerRef: RefObject<HTMLDivElement>;
}): {
  showJumpToLatest: boolean;
  unseenCount: number;
  handleJumpToLatest: () => void;
} {
  const { sessionId, messages, isStreaming, scrollContainerRef } = params;
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);

  const prevSessionIdRef = useRef(sessionId);
  const prevMessageCountRef = useRef(messages.length);
  const prevFirstMessageIdRef = useRef<string | undefined>(messages[0]?.messageId);
  const isUserScrollingRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track whether user has deliberately scrolled away during this streaming turn
  const userScrolledAwayRef = useRef(false);

  useEffect(() => {
    if (sessionId === prevSessionIdRef.current) {
      return;
    }

    prevSessionIdRef.current = sessionId;
    shouldAutoScrollRef.current = true;
    isUserScrollingRef.current = false;
    userScrolledAwayRef.current = false;
    setShowJumpToLatest(false);
    setUnseenCount(0);

    requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    });
  }, [sessionId, scrollContainerRef]);

  // Reset "scrolled away" tracking when streaming starts
  useEffect(() => {
    if (isStreaming) {
      // Check current position — if already at bottom, reset the flag
      const container = scrollContainerRef.current;
      if (container && Math.abs(container.scrollTop) <= AUTO_SCROLL_THRESHOLD_PX) {
        userScrolledAwayRef.current = false;
      }
    }
  }, [isStreaming, scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // column-reverse containers give negative scrollTop when scrolled up
      const distanceFromBottom = Math.abs(container.scrollTop);
      const isNearLiveEdge = distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
      shouldAutoScrollRef.current = isNearLiveEdge;

      if (isNearLiveEdge) {
        // User scrolled back to the bottom — they're re-engaged
        userScrolledAwayRef.current = false;
        setShowJumpToLatest(false);
        setUnseenCount(0);
      } else {
        // User has scrolled away from the live edge
        userScrolledAwayRef.current = true;
        // Show jump button if streaming or if there's content below
        if (isStreaming) {
          setShowJumpToLatest(true);
        }
      }

      isUserScrollingRef.current = true;
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      scrollTimeoutRef.current = setTimeout(() => {
        isUserScrollingRef.current = false;
      }, 150);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [isStreaming, scrollContainerRef]);

  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const hasNewMessages = messages.length > prevCount;
    const newMessageDelta = messages.length - prevCount;
    const firstMessageId = messages[0]?.messageId;
    const firstMessageChanged = firstMessageId !== prevFirstMessageIdRef.current;

    prevMessageCountRef.current = messages.length;
    prevFirstMessageIdRef.current = firstMessageId;

    if (!hasNewMessages || firstMessageChanged) {
      return;
    }

    // Only auto-scroll during active streaming when user hasn't scrolled away
    if (isStreaming && shouldAutoScrollRef.current && !userScrolledAwayRef.current) {
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      setShowJumpToLatest(false);
      return;
    }

    // If there are new messages and user is scrolled away, show the jump button
    if (!shouldAutoScrollRef.current || userScrolledAwayRef.current) {
      setUnseenCount(prev => prev + newMessageDelta);
      setShowJumpToLatest(true);
    }
  }, [messages, isStreaming, scrollContainerRef]);

  // Hide jump button when streaming ends and user is at the bottom
  useEffect(() => {
    if (!isStreaming && shouldAutoScrollRef.current) {
      setShowJumpToLatest(false);
    }
  }, [isStreaming]);

  const handleJumpToLatest = useCallback(() => {
    shouldAutoScrollRef.current = true;
    isUserScrollingRef.current = false;
    userScrolledAwayRef.current = false;
    setShowJumpToLatest(false);
    setUnseenCount(0);
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [scrollContainerRef]);

  return {
    showJumpToLatest,
    unseenCount,
    handleJumpToLatest,
  };
}
