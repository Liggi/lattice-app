import type { ChatMessage } from '../../types';

export const USER_DUPLICATE_WINDOW_MS = 3_000;

export function extractMessageText(message: ChatMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    const texts: string[] = [];
    for (const block of message.content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        texts.push(block.text);
      }
    }
    return texts.join('');
  }
  return '';
}

export function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function parseTimestampMs(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isEphemeralUserId(id: string | undefined): boolean {
  if (!id) return false;
  if (id.startsWith('user-prompt-')) return false;
  return (
    id.startsWith('user-') ||
    id.startsWith('optimistic-') ||
    id.startsWith('queued-local-') ||
    id.startsWith('h-') // harness SSE event IDs
  );
}

function sameProviderFamily(a: ChatMessage, b: ChatMessage): boolean {
  if (!a.provider || !b.provider) return true;
  return a.provider === b.provider;
}

export function dedupeNearDuplicateUserMessages(messages: ChatMessage[]): ChatMessage[] {
  const deduped: ChatMessage[] = [];

  for (const message of messages) {
    if (message.type !== 'user') {
      deduped.push(message);
      continue;
    }

    const text = normalizeComparableText(extractMessageText(message));
    if (!text) {
      deduped.push(message);
      continue;
    }

    const messageId = message.id || message.messageId;
    const messageTs = parseTimestampMs(message.timestamp);
    let handledAsDuplicate = false;

    for (let i = deduped.length - 1; i >= 0; i--) {
      const existing = deduped[i];
      if (existing.type !== 'user') {
        continue;
      }
      if (!sameProviderFamily(existing, message)) {
        continue;
      }

      const existingText = normalizeComparableText(extractMessageText(existing));
      if (existingText !== text) {
        continue;
      }

      const existingTs = parseTimestampMs(existing.timestamp);
      if (messageTs !== null && existingTs !== null) {
        const deltaMs = Math.abs(messageTs - existingTs);
        if (deltaMs > USER_DUPLICATE_WINDOW_MS) {
          continue;
        }
      }

      const existingId = existing.id || existing.messageId;
      const incomingEphemeral = isEphemeralUserId(messageId);
      const existingEphemeral = isEphemeralUserId(existingId);
      if (incomingEphemeral === existingEphemeral) {
        continue;
      }

      // Prefer the persisted copy (non-ephemeral ID) over optimistic UI copies.
      if (existingEphemeral && !incomingEphemeral) {
        deduped[i] = message;
      }
      handledAsDuplicate = true;
      break;
    }

    if (!handledAsDuplicate) {
      deduped.push(message);
    }
  }

  return deduped;
}

