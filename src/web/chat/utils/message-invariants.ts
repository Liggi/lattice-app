/**
 * Message Invariant Library
 *
 * A set of assertions that any normalized message list must satisfy.
 * Used in two contexts:
 * - At runtime (dev mode): logged as warnings/errors by normalizeForDisplay()
 * - In tests: asserted to catch regressions in CI
 *
 * See docs/MESSAGE_TESTING_INFRA.md for the full design.
 */

import type { ChatMessage, ToolResult, DisplayContentBlock } from '../types';

export interface InvariantViolation {
  rule: string;
  message: string;
  severity: 'error' | 'warning';
  context?: Record<string, unknown>;
}

export interface NormalizedMessagesShape {
  displayMessages: ChatMessage[];
  toolResults: Record<string, ToolResult>;
  childMessages: Record<string, ChatMessage[]>;
}

/**
 * Check invariants on a normalized message set.
 *
 * @param normalized - Output from normalizeForDisplay()
 * @param expectedUserPromptCount - If known, the number of real user prompts
 *   (tool_result messages excluded). Enables the user-count-sanity check.
 */
export function checkMessageInvariants(
  normalized: NormalizedMessagesShape,
  expectedUserPromptCount?: number
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const { displayMessages, toolResults } = normalized;

  // --- no-standalone-tool-results ---
  // No displayMessage should be a user message with only tool_result content
  for (const msg of displayMessages) {
    if (msg.type === 'user' && Array.isArray(msg.content)) {
      const blocks = msg.content as DisplayContentBlock[];
      const allToolResults = blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
      if (allToolResults) {
        violations.push({
          rule: 'no-standalone-tool-results',
          message: `User message ${msg.id} contains only tool_result blocks but is in displayMessages`,
          severity: 'error',
          context: { messageId: msg.id, blockCount: blocks.length },
        });
      }
    }
  }

  // --- no-duplicate-uuids ---
  // No two display messages should share the same backend ID
  const seenIds = new Map<string, number>();
  for (let i = 0; i < displayMessages.length; i++) {
    const id = displayMessages[i].id;
    if (id && seenIds.has(id)) {
      violations.push({
        rule: 'no-duplicate-uuids',
        message: `Duplicate message ID "${id}" at indices ${seenIds.get(id)} and ${i}`,
        severity: 'error',
        context: { id, firstIndex: seenIds.get(id), secondIndex: i },
      });
    } else if (id) {
      seenIds.set(id, i);
    }
  }

  // --- tool-use-has-result ---
  // Every tool_use block in assistant messages should have a toolResults entry
  for (const msg of displayMessages) {
    if (msg.type === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use' && b.id) {
          const toolUseId = b.id as string;
          const toolName = typeof b.name === 'string' ? b.name : 'unknown';
          if (!toolResults[toolUseId]) {
            violations.push({
              rule: 'tool-use-has-result',
              message: `tool_use "${toolUseId}" (${toolName}) has no entry in toolResults`,
              severity: 'warning',
              context: { toolUseId, toolName, messageId: msg.id },
            });
          }
        }
      }
    }
  }

  // --- tool-results-populated ---
  // After normalization, if there are tool_use blocks, toolResults should have
  // completed entries (not just pending). This catches the "empty after refresh" bug.
  const toolUseCount = displayMessages.reduce((count, msg) => {
    if (msg.type === 'assistant' && Array.isArray(msg.content)) {
      return count + (msg.content as DisplayContentBlock[]).filter(b => b.type === 'tool_use').length;
    }
    return count;
  }, 0);
  const completedCount = Object.values(toolResults).filter(r => r.status === 'completed').length;
  if (toolUseCount > 0 && completedCount === 0) {
    violations.push({
      rule: 'tool-results-populated',
      message: `${toolUseCount} tool_use blocks found but 0 completed tool results — results may not have been extracted from history`,
      severity: 'error',
      context: { toolUseCount, completedCount, pendingCount: Object.keys(toolResults).length },
    });
  }

  // --- user-count-sanity ---
  // If expected count is provided, actual user messages should not exceed it
  if (expectedUserPromptCount !== undefined) {
    const actualUserCount = displayMessages.filter(m => m.type === 'user').length;
    if (actualUserCount > expectedUserPromptCount) {
      violations.push({
        rule: 'user-count-sanity',
        message: `${actualUserCount} user messages displayed but only ${expectedUserPromptCount} real prompts expected`,
        severity: 'error',
        context: { actualUserCount, expectedUserPromptCount },
      });
    }
  }

  // --- chronological-order ---
  // Messages should be in chronological order
  for (let i = 1; i < displayMessages.length; i++) {
    const prevTime = new Date(displayMessages[i - 1].timestamp).getTime();
    const currTime = new Date(displayMessages[i].timestamp).getTime();
    if (currTime < prevTime && !isNaN(prevTime) && !isNaN(currTime)) {
      violations.push({
        rule: 'chronological-order',
        message: `Message at index ${i} (${displayMessages[i].id}) is before message at index ${i - 1} (${displayMessages[i - 1].id})`,
        severity: 'warning',
        context: {
          prevId: displayMessages[i - 1].id,
          prevTimestamp: displayMessages[i - 1].timestamp,
          currId: displayMessages[i].id,
          currTimestamp: displayMessages[i].timestamp,
        },
      });
    }
  }

  // --- no-empty-content ---
  for (const msg of displayMessages) {
    const isEmpty =
      msg.content === null ||
      msg.content === undefined ||
      msg.content === '' ||
      (Array.isArray(msg.content) && msg.content.length === 0);
    if (isEmpty) {
      violations.push({
        rule: 'no-empty-content',
        message: `Message ${msg.id} (${msg.type}) has empty content`,
        severity: 'warning',
        context: { messageId: msg.id, type: msg.type },
      });
    }
  }

  return violations;
}
