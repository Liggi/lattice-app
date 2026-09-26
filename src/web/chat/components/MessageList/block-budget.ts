import type { ChatMessage } from '../../types';

/** Count renderable content blocks for a message. Each tool_use, text, or
 *  thinking block counts as 1. String content or empty content counts as 1.
 *  tool_result blocks render inside their tool_use and don't count separately. */
export function countContentBlocks(message: ChatMessage): number {
  if (!Array.isArray(message.content)) return 1;
  const renderableBlocks = message.content.filter(
    (b: { type?: string }) => b.type !== 'tool_result'
  );
  return Math.max(1, renderableBlocks.length);
}

/** Walk items from the end (newest first) and return how many to include
 *  before exceeding the block budget. Always includes at least one item. */
export function sliceByBlockBudget<T extends { message: ChatMessage }>(
  reversedItems: T[],
  budget: number
): number {
  let blocks = 0;
  for (let i = 0; i < reversedItems.length; i++) {
    blocks += countContentBlocks(reversedItems[i].message);
    if (blocks > budget && i > 0) return i;
  }
  return reversedItems.length;
}
