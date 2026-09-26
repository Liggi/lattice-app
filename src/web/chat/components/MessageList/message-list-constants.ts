export const AUTO_SCROLL_THRESHOLD_PX = 96;

// Budget is in content blocks, not messages.
// A single assistant message with many tool_use blocks can be expensive to render.
export const BLOCK_BUDGET_BASE = 50;
export const BLOCK_BUDGET_STEP = 50;
