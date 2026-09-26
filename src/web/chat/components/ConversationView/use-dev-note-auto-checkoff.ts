import { useEffect, useRef } from 'react';
import { api } from '../../services/api';
import type { ChatMessage, DevNote } from '../../types';

const DEV_NOTE_CHECKOFF_PREFIX = 'CHECK OFF DEV NOTE:';

function extractPlainTextFromChatMessage(message: ChatMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  const textParts: string[] = [];
  for (const block of message.content) {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      textParts.push(block.text);
    }
  }

  return textParts.join('\n');
}

function normalizeDevNoteMatchValue(value: string): string {
  return value
    .replace(/[“”]/g, '"')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function maybeUnquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const pairs: Array<[string, string]> = [['"', '"'], ['“', '”'], ['\'', '\''], ['`', '`']];
  for (const [open, close] of pairs) {
    if (first === open && last === close) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function extractCheckedOffDevNotesFromText(text: string): string[] {
  if (!text) return [];
  const extracted: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const markerIndex = line.toUpperCase().indexOf(DEV_NOTE_CHECKOFF_PREFIX);
    if (markerIndex === -1) continue;
    const candidate = maybeUnquote(line.slice(markerIndex + DEV_NOTE_CHECKOFF_PREFIX.length));
    if (candidate) extracted.push(candidate);
  }
  return extracted;
}

export function useDevNoteAutoCheckoff(params: {
  conversationId?: string;
  combinedMessages: ChatMessage[];
  showToast: (args: {
    title: string;
    message?: string;
    type: 'success' | 'error' | 'info';
    duration?: number;
  }) => unknown;
}): void {
  const { conversationId, combinedMessages, showToast } = params;
  const processedDevNoteCheckoffsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    processedDevNoteCheckoffsRef.current.clear();
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId || combinedMessages.length === 0) return;

    const byKey = new Map<string, { normalized: string }>();
    for (const message of combinedMessages) {
      if (message.type !== 'assistant') continue;
      const text = extractPlainTextFromChatMessage(message);
      if (!text) continue;
      const checkedOffNotes = extractCheckedOffDevNotesFromText(text);
      for (const raw of checkedOffNotes) {
        const normalized = normalizeDevNoteMatchValue(raw);
        if (!normalized) continue;
        const key = `${conversationId}:${normalized}`;
        if (processedDevNoteCheckoffsRef.current.has(key)) continue;
        byKey.set(key, { normalized });
      }
    }

    if (byKey.size === 0) return;

    void (async () => {
      try {
        const { notes } = await api.getDevNotes();
        if (!Array.isArray(notes) || notes.length === 0) return;

        const pendingByNormalized = new Map<string, DevNote[]>();
        for (const note of notes) {
          const normalized = normalizeDevNoteMatchValue(note.content);
          if (!normalized) continue;
          if (note.status !== 'pending') continue;
          const existing = pendingByNormalized.get(normalized);
          if (existing) {
            existing.push(note);
          } else {
            pendingByNormalized.set(normalized, [note]);
          }
        }

        const matchedNotes: DevNote[] = [];
        const matchedKeys = new Set<string>();
        const matchedIds = new Set<string>();

        for (const [key, item] of byKey.entries()) {
          const direct = pendingByNormalized.get(item.normalized);
          let matched = direct?.find((note) => !matchedIds.has(note.id));

          if (!matched) {
            const pendingEntries = Array.from(pendingByNormalized.entries());
            const relaxed = pendingEntries.find(([normalized]) =>
              normalized.includes(item.normalized) || item.normalized.includes(normalized)
            );
            if (relaxed) {
              matched = relaxed[1].find((note) => !matchedIds.has(note.id));
            }
          }

          if (!matched) continue;
          matchedKeys.add(key);
          matchedIds.add(matched.id);
          matchedNotes.push(matched);
        }

        if (matchedNotes.length === 0) return;

        await Promise.all(
          matchedNotes.map((note) => api.updateDevNoteStatus(note.id, 'done'))
        );

        matchedKeys.forEach((key) => processedDevNoteCheckoffsRef.current.add(key));
        const count = matchedNotes.length;
        showToast({
          title: `Marked ${count} dev note${count === 1 ? '' : 's'} done`,
          message: count === 1 ? matchedNotes[0].content : undefined,
          type: 'success',
          duration: 3500,
        });
      } catch (error) {
        console.error('Failed to auto-complete dev notes from CHECK OFF markers:', error);
      }
    })();
  }, [combinedMessages, conversationId, showToast]);
}
