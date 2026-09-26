import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { sliceByBlockBudget } from './block-budget';
import { BLOCK_BUDGET_BASE, BLOCK_BUDGET_STEP } from './message-list-constants';
import type { ChatMessage } from '../../types';
import type { HydrationPhase } from '@liggi/agent-ui-harness/client';

interface ReversedItemLike {
  message: ChatMessage;
}

export function useBlockBudget<T extends ReversedItemLike>(params: {
  sessionId?: string;
  reversedItems: T[];
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore?: () => void;
  topSentinelRef: RefObject<HTMLDivElement>;
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** Hydration phase from the harness. The load-more sentinel is kept
   *  disarmed while the session is still hydrating so short last turns
   *  don't trigger a cascade of backfill pagination with staggered entry
   *  animations. See useMessageAnimation for the companion policy. */
  hydrationPhase: HydrationPhase;
  initialBudget?: number;
  budgetStep?: number;
}): {
  blockBudget: number;
  setBlockBudget: Dispatch<SetStateAction<number>>;
  visibleCount: number;
  visibleReversedItems: T[];
  truncatedOlderCount: number;
  hasInternalMore: boolean;
} {
  const {
    sessionId,
    reversedItems,
    hasMore,
    isLoadingMore,
    onLoadMore,
    topSentinelRef,
    scrollContainerRef,
    hydrationPhase,
    initialBudget = BLOCK_BUDGET_BASE,
    budgetStep = BLOCK_BUDGET_STEP,
  } = params;

  const [blockBudget, setBlockBudget] = useState(initialBudget);

  useEffect(() => {
    setBlockBudget(initialBudget);
  }, [sessionId, initialBudget]);

  // Track whether the user has genuinely scrolled since this session loaded.
  // Without this gate, short last turns leave the top sentinel naturally
  // within the IntersectionObserver's 200px root margin, triggering immediate
  // backward pagination — the "pop-in" bug. We only want the observer to
  // fire in response to user intent, not accidents of viewport geometry.
  const [hasUserScrolled, setHasUserScrolled] = useState(false);
  const lastScrollTopRef = useRef<number | null>(null);

  useEffect(() => {
    setHasUserScrolled(false);
    lastScrollTopRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (hasUserScrolled) return;

    // Seed the baseline when the listener attaches, not on the first scroll
    // event. Single-event scrolls (PageUp, scrollbar drag-and-release) would
    // otherwise overwrite the baseline and never set hasUserScrolled.
    lastScrollTopRef.current = container.scrollTop;

    const onScroll = () => {
      if (container.scrollTop === lastScrollTopRef.current) return;
      lastScrollTopRef.current = container.scrollTop;
      setHasUserScrolled(true);
    };

    // A container that does not overflow never fires `scroll`, so a short
    // last turn would leave older history unreachable. Wheeling up, or
    // pressing a key that means "up", is the same intent expressed on a
    // view with nothing to scroll.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) setHasUserScrolled(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'PageUp' || event.key === 'Home' || event.key === 'ArrowUp') setHasUserScrolled(true);
    };

    // Touch devices have no wheel and no keyboard, so a short last turn left
    // older history permanently unreachable on a phone. Dragging the finger
    // down is how the same intent is expressed there; the threshold keeps a
    // tap's jitter from counting as a drag.
    let touchStartY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined || touchStartY === null) return;
      if (y - touchStartY > 8) setHasUserScrolled(true);
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', onWheel, { passive: true });
    container.addEventListener('keydown', onKeyDown);
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
    };
  }, [scrollContainerRef, hasUserScrolled]);

  const visibleCount = useMemo(
    () => sliceByBlockBudget(reversedItems, blockBudget),
    [reversedItems, blockBudget]
  );
  const visibleReversedItems = useMemo(
    () => reversedItems.slice(0, visibleCount),
    [reversedItems, visibleCount]
  );
  const truncatedOlderCount = useMemo(
    () => Math.max(0, reversedItems.length - visibleCount),
    [reversedItems.length, visibleCount]
  );
  const hasInternalMore = hasMore || truncatedOlderCount > 0;

  useEffect(() => {
    if (!topSentinelRef.current || isLoadingMore) return;
    if (!hasInternalMore) return;
    // Don't arm the observer until the session is caught up AND the user
    // has expressed intent to see older content by actually scrolling.
    // Otherwise a short last turn would paginate backward on its own.
    if (hydrationPhase === 'hydrating') return;
    if (!hasUserScrolled) return;

    const hasLocallyTruncatedItems = visibleCount < reversedItems.length;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        if (hasLocallyTruncatedItems) {
          setBlockBudget((prev) => prev + budgetStep);
          return;
        }
        onLoadMore?.();
      },
      {
        root: scrollContainerRef.current,
        rootMargin: '200px 0px 0px 0px',
        threshold: 0,
      }
    );

    observer.observe(topSentinelRef.current);
    return () => observer.disconnect();
  }, [
    budgetStep,
    visibleCount,
    reversedItems.length,
    hasInternalMore,
    isLoadingMore,
    onLoadMore,
    scrollContainerRef,
    topSentinelRef,
    hydrationPhase,
    hasUserScrolled,
  ]);

  return {
    blockBudget,
    setBlockBudget,
    visibleCount,
    visibleReversedItems,
    truncatedOlderCount,
    hasInternalMore,
  };
}
