import { isQuietTurnMarker } from '@/constants/quiet-turn';
import type { DisplayContentBlock } from '../types';

// `trim()` keeps zero-width characters, and a model asked to end a turn with
// no text sometimes writes a lone U+200B instead.
const INVISIBLE_ONLY = /^[\s\u200B-\u200D\u2060]*$/;

/** Whether `text` has anything a reader could see. */
export function hasVisibleText(text: string): boolean {
  return !INVISIBLE_ONLY.test(text);
}

/** A text block with nothing for a reader: invisible, or a quiet turn's marker. */
export function isBlankText(block: DisplayContentBlock): boolean {
  if (block.type !== 'text') return false;
  return !(typeof block.text === 'string' && hasVisibleText(block.text) && !isQuietTurnMarker(block.text));
}
