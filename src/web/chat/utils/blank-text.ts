import type { DisplayContentBlock } from '../types';

// `trim()` keeps zero-width characters, and a model asked to end a turn with
// no text sometimes writes a lone U+200B instead.
const INVISIBLE_ONLY = /^[\s\u200B-\u200D\u2060]*$/;

/** Whether `text` has anything a reader could see. */
export function hasVisibleText(text: string): boolean {
  return !INVISIBLE_ONLY.test(text);
}

/** A text block with nothing a reader could see. */
export function isBlankText(block: DisplayContentBlock): boolean {
  return block.type === 'text' && !(typeof block.text === 'string' && hasVisibleText(block.text));
}
