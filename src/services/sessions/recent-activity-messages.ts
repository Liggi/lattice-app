import type Anthropic from '@anthropic-ai/sdk';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { eventsToUnifiedMessages } from '../../harness/event-message-reader.js';
import type { SqliteEventStorageAdapter } from '../../harness/sqlite-event-storage.js';
import type { ConversationMessage } from '@/types/index.js';

/**
 * How many harness events to read per conversation when seeding activity state
 * on connect.
 *
 * The seed exists so a freshly-connected tab renders the sidebar's mini action
 * log straight away rather than waiting for the next live activity event — an
 * idle session never produces one. `extractRecentActions` walks backwards and
 * stops at 14 actions, so only the newest handful of messages can ever matter.
 *
 * The seed used to call `historyReader.fetchConversationDirect(conv-*)`, which
 * was the single most expensive thing this endpoint did. A conv-* ID never
 * names a file under ~/.claude/projects (Claude writes provider-UUID
 * transcripts), so every call paid a full projects-directory scan, missed, and
 * then fell through to reading the event log with `read()`'s default limit of
 * 10000 and rebuilding every message — once per conversation, for up to 50
 * conversations, synchronously, on every tab connect and reconnect. Measured
 * against the 50 busiest conversations in the live store: 920 ms of directory
 * scanning + SQLite + JSON.parse before message assembly even starts.
 *
 * The window is measured in events but the thing that has to be sufficient is
 * *messages*, and the ratio between them is not stable: streamed text arrives
 * as one `content` event per delta, all sharing a messageId, so 199 events can
 * merge into a single message. The read therefore grows (see
 * SEED_ACTIVITY_MESSAGE_TARGET) rather than trusting one fixed size. Measured
 * against 201 live conversations, scoring each against the actions derived from
 * that conversation's complete log: the old whole-history read was right 76.6%
 * of the time at 44.2 ms per conversation; a flat 200-event window is right
 * 67.7% at 2.6 ms; growing to a 4000 ceiling is right 99.0%.
 */
const SEED_ACTIVITY_MIN_WINDOW = 200;
const SEED_ACTIVITY_MAX_WINDOW = 4000;

/**
 * Messages to assemble before the window stops growing. `extractRecentActions`
 * stops at 14 actions and most messages yield at least one, so this leaves
 * headroom for the messages that yield none (a turn of pure thinking blocks).
 */
const SEED_ACTIVITY_MESSAGE_TARGET = 40;

/**
 * Newest messages of a conversation, assembled from a bounded tail of its
 * harness event log, in the shape `InsightsEngine.extractRecentActions` reads.
 * Serves both the activity-stream connect seed and SessionActivityWatcher's
 * live updates, so neither reads a Claude transcript.
 *
 * The block mapping mirrors ClaudeHistoryReader's event-storage fallback — the
 * path every conv-* seed actually took — so the actions extracted downstream
 * are the same kind.
 *
 * The window is `readStatusWindow`, not a raw `readTail`, because a raw tail is
 * not a tail of *messages*: a codex session interleaves `codex:rateLimits`
 * events densely enough that 400 raw events can hold a single message, which
 * emptied the seed for those sessions when this was first written that way.
 * `readStatusWindow` filters to the types carrying status or content — a
 * superset of the three types `eventsToUnifiedMessages` reads, plus the
 * `run:start` it reads the provider from.
 *
 * Where the window edge splits a multi-event message the oldest assembled
 * message can be missing earlier fragments; harmless here, because actions are
 * read from the newest end.
 */
export function readSeedActivityMessages(
  storage: Pick<SqliteEventStorageAdapter, 'readStatusWindow'>,
  conversationId: string,
  limits: { minWindow?: number; maxWindow?: number; messageTarget?: number } = {},
): ConversationMessage[] {
  const maxWindow = limits.maxWindow ?? SEED_ACTIVITY_MAX_WINDOW;
  const messageTarget = limits.messageTarget ?? SEED_ACTIVITY_MESSAGE_TARGET;
  let window = Math.min(limits.minWindow ?? SEED_ACTIVITY_MIN_WINDOW, maxWindow);

  for (;;) {
    const events = storage.readStatusWindow(conversationId, window);
    const messages = toSeedMessages(events, conversationId);
    // A short page means the window already covers the whole session, so
    // growing it cannot find more.
    const coveredWholeSession = events.length < window;
    if (coveredWholeSession || messages.length >= messageTarget || window >= maxWindow) {
      return messages;
    }
    window = Math.min(window * 4, maxWindow);
  }
}

function toSeedMessages(
  events: readonly SessionEvent[],
  conversationId: string,
): ConversationMessage[] {
  if (events.length === 0) {
    return [];
  }

  return eventsToUnifiedMessages(events).map((unified, index): ConversationMessage => ({
    uuid: unified.id || `seed-${index}`,
    type: unified.role === 'user' ? 'user' : 'assistant',
    message: {
      role: unified.role,
      content: unified.content.flatMap((block): Anthropic.ContentBlockParam[] => {
        if (block.type === 'text') {
          return [{ type: 'text' as const, text: block.text }];
        }
        if (block.type === 'tool_use') {
          return [{
            type: 'tool_use' as const,
            id: block.id || `tool-${index}`,
            name: block.name || 'unknown',
            input: block.input ?? {},
          }];
        }
        if (block.type === 'tool_result') {
          return [{
            type: 'text' as const,
            text: typeof block.output === 'string' ? block.output : JSON.stringify(block.output ?? ''),
          }];
        }
        return [];
      }),
    } as Anthropic.MessageParam,
    timestamp: unified.timestamp,
    sessionId: conversationId,
    provider: unified.provider,
  }));
}
