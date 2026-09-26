import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { countContentBlocks } from './block-budget';
import { BLOCK_BUDGET_STEP } from './message-list-constants';
import type { ChatMessage } from '../../types';

interface ReversedMessageItemLike {
  message: ChatMessage;
}

export function useJumpToMessage<T extends ReversedMessageItemLike>(params: {
  jumpToMessageId: string | null;
  reversedItems: T[];
  visibleCount: number;
  setBlockBudget: Dispatch<SetStateAction<number>>;
  scrollContainerRef: RefObject<HTMLDivElement>;
  onJumpHandled?: () => void;
  blockBudgetStep?: number;
}): void {
  const {
    jumpToMessageId,
    reversedItems,
    visibleCount,
    setBlockBudget,
    scrollContainerRef,
    onJumpHandled,
    blockBudgetStep = BLOCK_BUDGET_STEP,
  } = params;

  useEffect(() => {
    if (!jumpToMessageId) return;

    const targetIndex = reversedItems.findIndex(
      (item) => (item.message.messageId || item.message.id) === jumpToMessageId
    );
    if (targetIndex < 0) return;

    if (targetIndex >= visibleCount) {
      let blocks = 0;
      for (let i = 0; i <= targetIndex; i += 1) {
        blocks += countContentBlocks(reversedItems[i].message);
      }
      setBlockBudget(blocks + blockBudgetStep);
      return;
    }

    const raf = requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const escapedId = jumpToMessageId
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
      const target = container.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null;
      if (!target) return;

      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetCenter = targetRect.top + targetRect.height / 2;
      const containerCenter = containerRect.top + containerRect.height / 2;
      const scrollOffset = targetCenter - containerCenter;

      container.scrollTo({
        top: container.scrollTop + scrollOffset,
        behavior: 'smooth',
      });

      target.classList.add('jump-highlight');
      setTimeout(() => target.classList.remove('jump-highlight'), 2000);

      onJumpHandled?.();
    });

    return () => cancelAnimationFrame(raf);
  }, [
    jumpToMessageId,
    reversedItems,
    visibleCount,
    setBlockBudget,
    scrollContainerRef,
    onJumpHandled,
    blockBudgetStep,
  ]);
}
