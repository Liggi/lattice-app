/**
 * Where long pastes sit in the composer's text, so the thread can show each
 * one closed. The text itself is never changed: a paste stays in the textarea
 * as typed text, and only its position is tracked through later edits.
 */

/** A paste is recorded when it is at least this many lines, or this many characters. */
const LONG_PASTE_MIN_LINES = 8;
const LONG_PASTE_MIN_CHARS = 1000;

/** Character range of a paste within the composer's current text. */
export interface PastedRange {
  start: number;
  end: number;
}

/** A paste as sent with the message: counted back from the end of the text. */
export interface ComposerPastedSpan {
  fromEnd: number;
  length: number;
}

/** The text a paste puts in a textarea, which turns every line break into `\n`. */
export function pastedTextAsInserted(clipboardText: string): string {
  return clipboardText.replace(/\r\n?/g, '\n');
}

export function isLongPaste(text: string): boolean {
  return text.length >= LONG_PASTE_MIN_CHARS || text.split('\n').length >= LONG_PASTE_MIN_LINES;
}

/**
 * Move ranges across one edit from `prev` to `next`. The edit is the single
 * changed stretch between their common start and common end. An edit before a
 * range shifts it, one inside resizes it, and one across its edge drops it,
 * since the range would no longer be the text that was pasted.
 */
export function shiftPastedRanges(prev: string, next: string, ranges: readonly PastedRange[]): PastedRange[] {
  if (prev === next || ranges.length === 0) return [...ranges];
  const shorter = Math.min(prev.length, next.length);
  let head = 0;
  while (head < shorter && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < shorter - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const editEnd = prev.length - tail;
  const delta = next.length - prev.length;

  return ranges.flatMap((range) => {
    if (editEnd <= range.start && head <= range.start) return [{ start: range.start + delta, end: range.end + delta }];
    if (head >= range.end) return [range];
    if (head >= range.start && editEnd <= range.end) {
      const end = range.end + delta;
      return end > range.start ? [{ start: range.start, end }] : [];
    }
    return [];
  });
}

/** The ranges as they apply to `text.trim()`, counted back from its end, in order. */
export function pastedSpansForSubmit(text: string, ranges: readonly PastedRange[]): ComposerPastedSpan[] {
  const lead = text.length - text.trimStart().length;
  const trimmedLength = text.trim().length;
  return [...ranges]
    .sort((a, b) => a.start - b.start)
    .map((range) => ({ start: Math.max(range.start - lead, 0), end: Math.min(range.end - lead, trimmedLength) }))
    .filter((range) => range.end > range.start)
    .map((range) => ({ fromEnd: trimmedLength - range.start, length: range.end - range.start }));
}
