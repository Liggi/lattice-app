/**
 * Pending message annotations — the user highlights a span inside an assistant
 * message, attaches a short note, and the note rides along at the front of the
 * next message they send.
 *
 * Everything in this file is pure so the outgoing-message format can be unit
 * tested without a DOM.
 */

export interface PendingAnnotation {
  /** Stable id for React keys and removal. */
  id: string;
  /** `data-message-id` of the assistant message the quote came from. */
  messageId: string;
  /** Exact text the user highlighted. Never truncated when sent. */
  quote: string;
  /** The user's note about that span. */
  note: string;
  /**
   * Offset the quote started at within the container's whitespace-free text.
   * Disambiguates a phrase that appears more than once in the same message.
   * Absent on notes saved before this was recorded — those still resolve to the
   * first occurrence, as they always did.
   */
  quoteStart?: number;
  /** Epoch ms, used only for stable ordering. */
  createdAt: number;
}

export const ANNOTATIONS_STORAGE_PREFIX = 'lattice-annotations-';

/** localStorage key for a conversation's pending annotations. */
export function annotationsStorageKey(conversationId: string | undefined | null): string {
  return `${ANNOTATIONS_STORAGE_PREFIX}${conversationId ?? 'home'}`;
}

/** Drops anything that does not look like a PendingAnnotation (hand-edited or stale storage). */
export function sanitizeStoredAnnotations(value: unknown): PendingAnnotation[] {
  if (!Array.isArray(value)) return [];
  const result: PendingAnnotation[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<PendingAnnotation>;
    if (typeof candidate.id !== 'string' || candidate.id === '') continue;
    if (typeof candidate.messageId !== 'string') continue;
    if (typeof candidate.quote !== 'string' || candidate.quote === '') continue;
    if (typeof candidate.note !== 'string') continue;
    const { quoteStart } = candidate;
    result.push({
      id: candidate.id,
      messageId: candidate.messageId,
      quote: candidate.quote,
      note: candidate.note,
      ...(typeof quoteStart === 'number' && Number.isFinite(quoteStart) && quoteStart >= 0
        ? { quoteStart }
        : {}),
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
    });
  }
  return result;
}

/**
 * Builds the notes block that gets prepended to the outgoing message.
 *
 * Quotes and notes are emitted verbatim — no truncation, no escaping, no
 * re-indentation. Display-side clamping lives in the chip component; the wire
 * format always carries the full span the user highlighted.
 */
export function formatAnnotationsBlock(annotations: readonly PendingAnnotation[]): string {
  if (annotations.length === 0) return '';
  const lines: string[] = ['[Notes on your earlier output]'];
  annotations.forEach((annotation, index) => {
    lines.push(`${index + 1}. Re: "${annotation.quote}"`);
    lines.push(`   Note: ${annotation.note}`);
  });
  lines.push('[/Notes]');
  return lines.join('\n');
}

/**
 * Final outgoing message: notes block first, then whatever the user typed.
 *
 * - No annotations → the typed message is returned untouched.
 * - Empty typed message → the notes block alone is the message.
 */
export function formatAnnotatedMessage(
  annotations: readonly PendingAnnotation[],
  typedMessage: string,
): string {
  if (annotations.length === 0) return typedMessage;
  const block = formatAnnotationsBlock(annotations);
  const body = typedMessage.trim();
  return body ? `${block}\n\n${body}` : block;
}

export interface SentAnnotation {
  quote: string;
  note: string;
}

export interface ParsedAnnotatedMessage {
  annotations: SentAnnotation[];
  /** What the user typed after the notes; empty when the notes were the whole message. */
  body: string;
}

const NOTES_HEADER = '[Notes on your earlier output]\n';
const NOTES_FOOTER = '\n[/Notes]';
const NOTE_SEPARATOR = '"\n   Note: ';

/**
 * Inverse of `formatAnnotatedMessage`, for rendering a sent message.
 * Returns null for anything that is not exactly that shape, so ordinary
 * messages render as the text they are.
 */
export function parseAnnotatedMessage(text: string): ParsedAnnotatedMessage | null {
  if (!text.startsWith(NOTES_HEADER)) return null;
  const inner = text.slice(NOTES_HEADER.length);
  const annotations: SentAnnotation[] = [];
  let cursor = 0;
  for (let index = 1; ; index += 1) {
    const prefix = `${index}. Re: "`;
    if (!inner.startsWith(prefix, cursor)) return null;
    const quoteStart = cursor + prefix.length;
    const separator = inner.indexOf(NOTE_SEPARATOR, quoteStart);
    if (separator === -1) return null;
    const noteStart = separator + NOTE_SEPARATOR.length;
    const nextEntry = inner.indexOf(`\n${index + 1}. Re: "`, noteStart);
    const footer = inner.indexOf(NOTES_FOOTER, noteStart);
    if (footer === -1) return null;
    const noteEnd = nextEntry !== -1 && nextEntry < footer ? nextEntry : footer;
    annotations.push({ quote: inner.slice(quoteStart, separator), note: inner.slice(noteStart, noteEnd) });
    if (noteEnd === footer) {
      const rest = inner.slice(footer + NOTES_FOOTER.length);
      if (rest !== '' && !rest.startsWith('\n\n')) return null;
      return { annotations, body: rest.trim() };
    }
    cursor = noteEnd + 1;
  }
}
