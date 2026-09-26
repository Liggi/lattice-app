/**
 * Converts ConversationMessages into harness SessionEvents.
 *
 * Used by session transfer to import a bundle of messages from another
 * machine into harness_events. Pre-cutover history is handled separately by
 * legacy-message-migration.ts, which reads the legacy `messages` table.
 */

import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import type { ConversationMessage } from '@/types/index.js';

/**
 * Convert old ConversationMessages to harness SessionEvents.
 *
 * Mapping:
 *  - assistant messages → 'content' events (text, thinking, tool_use blocks)
 *  - user messages with string content → 'input:sent' events
 *  - user messages with tool_result blocks → 'result' events
 *  - system messages → skipped (no harness equivalent)
 */
export function convertMessagesToEvents(
  sessionId: string,
  messages: ConversationMessage[],
): SessionEvent[] {
  const events: SessionEvent[] = [];
  const runId = `backfill-${sessionId}`;
  let seq = 1;

  // Dedup: the old pipeline stores user messages in BOTH JSONL and MessageStore
  // with different UUIDs. After merging, the same text appears twice within a
  // small timestamp window. Track recent input:sent texts to skip duplicates.
  const DEDUP_WINDOW_MS = 5000;
  const recentInputs: Array<{ text: string; timestamp: number }> = [];

  const isDuplicateInput = (text: string, ts: number): boolean => {
    for (const recent of recentInputs) {
      if (recent.text === text && Math.abs(ts - recent.timestamp) < DEDUP_WINDOW_MS) {
        return true;
      }
    }
    recentInputs.push({ text, timestamp: ts });
    return false;
  };

  for (const msg of messages) {
    const timestamp = new Date(msg.timestamp).getTime();

    if (msg.type === 'assistant') {
      const anthropicMsg = msg.message as { content?: unknown[] };
      const rawBlocks = (anthropicMsg.content ?? []) as Array<Record<string, unknown>>;

      // Only keep blocks the harness client knows how to render
      const contentBlocks = rawBlocks.filter(
        b => b.type === 'text' || b.type === 'thinking' || b.type === 'tool_use',
      );

      if (contentBlocks.length > 0) {
        events.push({
          sessionId,
          runId,
          seq: seq++,
          timestamp,
          type: 'content',
          data: { blocks: contentBlocks },
        });
      }
    } else if (msg.type === 'user') {
      const content = (msg.message as { content?: string | unknown[] }).content;

      if (typeof content === 'string') {
        // Plain text user message — skip if duplicate from JSONL+MessageStore overlap
        if (!isDuplicateInput(content, timestamp)) {
          events.push({
            sessionId,
            runId,
            seq: seq++,
            timestamp,
            type: 'input:sent',
            data: { text: content },
          });
        }
      } else if (Array.isArray(content)) {
        // Mixed content — split into separate event types
        const textParts: string[] = [];
        const toolResults: Array<Record<string, unknown>> = [];

        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          } else if (block.type === 'tool_result') {
            toolResults.push(block);
          }
        }

        if (textParts.length > 0) {
          const text = textParts.join('\n');
          if (!isDuplicateInput(text, timestamp)) {
            events.push({
              sessionId,
              runId,
              seq: seq++,
              timestamp,
              type: 'input:sent',
              data: { text },
            });
          }
        }

        if (toolResults.length > 0) {
          events.push({
            sessionId,
            runId,
            seq: seq++,
            timestamp,
            type: 'result',
            data: { blocks: toolResults },
          });
        }
      }
    }
    // System messages have no harness event equivalent — skip
  }

  return events;
}
