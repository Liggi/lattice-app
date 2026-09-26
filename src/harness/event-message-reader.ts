/**
 * Event Message Reader — reads harness events, converts to UnifiedMessages.
 *
 * Replaces MessageStore as the read path for server-side services.
 * The conversion is the inverse of history-backfill's convertMessagesToEvents()
 * and matches event-persistence's mapping exactly (content → assistant,
 * result → user/tool_result, input:sent → user/text).
 */

import type { AttachmentBlock, SessionEvent } from '@liggi/agent-ui-harness/protocol';
import type { Provider, UnifiedMessage, UnifiedContentBlock } from '../types/unified-messages.js';
import type { SqliteEventStorageAdapter } from './sqlite-event-storage.js';

// ---- Module-level singleton ----

let _storage: SqliteEventStorageAdapter | null = null;

/** Initialize with the storage adapter (called from harness setup). */
export function initEventMessageReader(storage: SqliteEventStorageAdapter): void {
  _storage = storage;
}

function getStorage(): SqliteEventStorageAdapter {
  if (!_storage) {
    throw new Error('EventMessageReader not initialized — call initEventMessageReader() first');
  }
  return _storage;
}

/**
 * Public accessor for the shared harness event storage adapter.
 * Intended for debug/diagnostic routes that need raw event access.
 */
export function getEventStorage(): SqliteEventStorageAdapter {
  return getStorage();
}

// ---- Public API ----

/** Read all messages for a session from harness event storage. */
export function readMessages(sessionId: string): UnifiedMessage[] {
  const events = getStorage().read(sessionId);
  return eventsToUnifiedMessages(events);
}

/** Count message-producing events for a session. */
export function countMessages(sessionId: string): number {
  // Count all events — slightly overcounts (includes run:start, turn:end etc.)
  // but matches the old MessageStore behavior closely enough for eligibility checks.
  // Services that need exact message counts can use readMessages().length.
  return getStorage().count(sessionId);
}

/**
 * Read only the newest messages of a session via bounded tail event windows.
 *
 * Exists for the conversation-details hot path: reconstructing a whole
 * history there is a multi-second main-thread stall on the largest sessions
 * (2026-08-07 freeze investigation). The window grows until enough messages
 * assemble or the whole session is covered.
 *
 * When the window does NOT cover the whole session, the oldest assembled
 * message may be missing earlier fragments (content events merge by
 * messageId, and the window edge can split one), so it is dropped rather
 * than served partial.
 */
export function readMessagesTail(
  sessionId: string,
  limit: number,
): { messages: UnifiedMessage[]; hasMore: boolean } {
  const storage = getStorage();
  const MAX_WINDOW = 32_000;
  let window = Math.min(Math.max(limit * 4, 200), MAX_WINDOW);

  for (;;) {
    const events = storage.readTail(sessionId, window);
    const coveredWholeSession = events.length < window;
    const msgs = eventsToUnifiedMessages(events);

    if (coveredWholeSession) {
      const hasMore = msgs.length > limit;
      return { messages: hasMore ? msgs.slice(-limit) : msgs, hasMore };
    }
    if (msgs.length >= limit + 1 || window >= MAX_WINDOW) {
      // Partial window: drop the possibly-split oldest message, serve the rest.
      return { messages: msgs.slice(1).slice(-limit), hasMore: true };
    }
    window = Math.min(window * 2, MAX_WINDOW);
  }
}

// ---- Conversion ----

/** Convert SessionEvents to UnifiedMessages (pure function, no storage access). */
export function eventsToUnifiedMessages(events: readonly SessionEvent[]): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];
  let provider: Provider = 'claude';

  for (const event of events) {
    const eventProvider = providerFromEvent(event);
    if (eventProvider) provider = eventProvider;

    const msg = eventToUnifiedMessage(event, provider);
    if (msg) appendMessage(messages, msg);
  }

  return messages;
}

function appendMessage(messages: UnifiedMessage[], msg: UnifiedMessage): void {
  const last = messages[messages.length - 1];
  if (
    last
    && last.id === msg.id
    && last.role === msg.role
    && last.provider === msg.provider
  ) {
    last.content = mergeContent(last.content, msg.content);
    last.timestamp = msg.timestamp;
    return;
  }
  messages.push(msg);
}

function mergeContent(
  existing: UnifiedContentBlock[],
  incoming: UnifiedContentBlock[],
): UnifiedContentBlock[] {
  const merged = [...existing];
  for (const block of incoming) {
    const last = merged[merged.length - 1];
    if (last?.type === 'text' && block.type === 'text') {
      last.text += block.text;
      continue;
    }
    if (last?.type === 'thinking' && block.type === 'thinking') {
      last.text = `${last.text}${last.text && block.text ? '\n' : ''}${block.text}`;
      continue;
    }
    merged.push(block);
  }
  return merged;
}

function providerFromEvent(event: SessionEvent): Provider | null {
  if (event.type !== 'run:start') return null;
  const data = event.data as { config?: { extra?: { provider?: unknown } } };
  return data.config?.extra?.provider === 'codex' ? 'codex' : null;
}

function eventToUnifiedMessage(event: SessionEvent, provider: Provider): UnifiedMessage | null {
  switch (event.type) {
    case 'content':
      return contentEventToMessage(event, provider);
    case 'result':
      return resultEventToMessage(event, provider);
    case 'input:sent':
      return inputSentEventToMessage(event, provider);
    default:
      return null;
  }
}

function contentEventToMessage(event: SessionEvent, provider: Provider): UnifiedMessage | null {
  const data = event.data as { blocks?: Array<Record<string, unknown>>; messageId?: string };
  if (!data.blocks || data.blocks.length === 0) return null;

  const content: UnifiedContentBlock[] = data.blocks
    .map(normalizeContentBlock)
    .filter(Boolean) as UnifiedContentBlock[];
  if (content.length === 0) return null;

  return {
    id: data.messageId ? `evt-${data.messageId}` : `evt-${event.seq}`,
    provider,
    role: 'assistant',
    content,
    timestamp: new Date(event.timestamp).toISOString(),
    providerMessageId: data.messageId,
  };
}

function resultEventToMessage(event: SessionEvent, provider: Provider): UnifiedMessage | null {
  const data = event.data as { blocks?: Array<Record<string, unknown>> };
  if (!data.blocks || data.blocks.length === 0) return null;

  const content: UnifiedContentBlock[] = [];
  for (const block of data.blocks) {
    if (block.type === 'tool_result') {
      content.push({
        type: 'tool_result',
        toolUseId: (block.tool_use_id as string) ?? '',
        output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        isError: (block.is_error as boolean) ?? false,
      });
    }
  }

  if (content.length === 0) return null;

  return {
    id: `evt-${event.seq}`,
    provider,
    role: 'user',
    content,
    timestamp: new Date(event.timestamp).toISOString(),
  };
}

function inputSentEventToMessage(event: SessionEvent, provider: Provider): UnifiedMessage | null {
  const data = event.data as { text?: string; blocks?: AttachmentBlock[] };
  const attachments = Array.isArray(data.blocks) ? data.blocks : [];
  // Attachments-only input (a bare image paste) is a real message with no text.
  if (!data.text && attachments.length === 0) return null;

  const content: UnifiedContentBlock[] = [
    ...attachments.map(toUnifiedAttachmentBlock),
    ...(data.text ? [{ type: 'text' as const, text: data.text }] : []),
  ];

  return {
    id: `evt-${event.seq}`,
    provider,
    role: 'user',
    content,
    timestamp: new Date(event.timestamp).toISOString(),
  };
}

/** Harness attachment blocks and Unified blocks share a shape; this is the
 *  explicit widening (harness base64-only source → Unified base64|url source). */
function toUnifiedAttachmentBlock(block: AttachmentBlock): UnifiedContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return {
    type: block.type,
    source: { type: 'base64', media_type: block.source.media_type, data: block.source.data },
  };
}

function normalizeContentBlock(block: Record<string, unknown>): UnifiedContentBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text as string };
    case 'thinking':
      return { type: 'thinking', text: block.thinking as string };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id as string,
        name: block.name as string,
        input: (block.input as Record<string, unknown>) ?? {},
      };
    default:
      return null;
  }
}
