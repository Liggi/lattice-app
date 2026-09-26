/**
 * Resolving a stored quote string back to a live DOM Range inside a message.
 *
 * The quote was captured with `selection.toString()`, which is *not* a
 * substring of the concatenated text nodes. Two independent mismatches:
 *
 *  1. Crossing a block boundary, the browser inserts a newline that exists in
 *     no text node — `<p>ab</p><p>cd</p>` selects as `"ab\ncd"` but reads as
 *     `"abcd"`. Collapsing whitespace cannot fix this, because there is no
 *     whitespace in the DOM to collapse.
 *  2. Markdown rendering introduces indentation whitespace of its own, which
 *     the selection may or may not have picked up.
 *
 * Matching therefore ignores whitespace entirely on both sides: the index
 * concatenates only non-whitespace characters, and a position map carries each
 * of them back to its (text node, offset) origin so a Range can be rebuilt
 * across element boundaries. The Range spans from the first matched character
 * to the last, so interior whitespace is covered by the range itself.
 *
 * Everything here is pure over a DOM tree — no React, no module state.
 */

interface CharPosition {
  node: Text;
  offset: number;
}

export interface NormalizedTextIndex {
  /** Whitespace-free text of the subtree. */
  text: string;
  /** `positions[i]` is the origin of `text[i]`. */
  positions: CharPosition[];
}

const WHITESPACE = /\s/;

/** Strips all whitespace. Both the index and the search needle use this. */
export function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * Walks the text nodes of `root`, building the whitespace-free text and the map
 * back to source positions. Subtrees marked `data-annotation-ui` are skipped so
 * our own injected UI never becomes part of the searchable text.
 */
export function buildNormalizedTextIndex(root: Node): NormalizedTextIndex {
  const doc = root.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  if (!doc) return { text: '', positions: [] };

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (parent && parent.closest('[data-annotation-ui="true"]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const chars: string[] = [];
  const positions: CharPosition[] = [];

  let current = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    const data = textNode.data;
    for (let offset = 0; offset < data.length; offset += 1) {
      const char = data[offset];
      if (WHITESPACE.test(char)) continue;
      chars.push(char);
      positions.push({ node: textNode, offset });
    }
    current = walker.nextNode();
  }

  return { text: chars.join(''), positions };
}

/**
 * Index of the first indexed character at or after a DOM point, or null when
 * the point sits past the last one.
 *
 * This is what lets a repeated phrase be annotated on the copy the user
 * actually highlighted: captured at selection time, it travels with the
 * annotation and steers `findQuoteRangeInIndex` to the right occurrence.
 *
 * Binary search over `positions`, which is in document order by construction,
 * so it costs a handful of DOM comparisons rather than a walk.
 */
export function normalizedOffsetOfPoint(
  index: NormalizedTextIndex,
  node: Node,
  offset: number,
): number | null {
  const doc = node.ownerDocument;
  if (!doc || index.positions.length === 0) return null;

  let point: Range;
  try {
    point = doc.createRange();
    point.setStart(node, offset);
    point.collapse(true);
  } catch {
    return null;
  }

  let low = 0;
  let high = index.positions.length;
  try {
    while (low < high) {
      const mid = (low + high) >> 1;
      const candidate = index.positions[mid];
      // Negative means the candidate lies before the point — search right.
      if (point.comparePoint(candidate.node, candidate.offset) < 0) low = mid + 1;
      else high = mid;
    }
  } catch {
    // comparePoint throws for detached or cross-document nodes.
    return null;
  }

  return low < index.positions.length ? low : null;
}

/**
 * The occurrence of `needle` nearest `preferredStart`, or the first one when no
 * position was recorded. Ties go to the earlier occurrence.
 */
function chooseOccurrence(
  haystack: string,
  needle: string,
  preferredStart: number | null | undefined,
): number {
  const first = haystack.indexOf(needle);
  if (first < 0 || preferredStart == null || !Number.isFinite(preferredStart)) return first;

  let best = first;
  let bestDistance = Math.abs(first - preferredStart);
  // Step by one rather than by needle length so overlapping repeats are seen.
  for (let at = haystack.indexOf(needle, first + 1); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const distance = Math.abs(at - preferredStart);
    if (distance < bestDistance) {
      best = at;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Occurrence of `quote` in a prebuilt index, as a live Range.
 *
 * `preferredStart` is the index the quote started at when it was captured. A
 * phrase can repeat inside one message, so without it the highlight and its
 * comment icon land on the first copy no matter which one was selected.
 * Nearest-wins rather than exact-match: earlier text can reflow (a thinking
 * block collapsing, a streamed edit) and shift every offset after it.
 *
 * Returns null when the text is no longer present — the caller treats that as
 * "no highlight for this annotation", never as an error.
 */
export function findQuoteRangeInIndex(
  index: NormalizedTextIndex,
  quote: string,
  preferredStart?: number | null,
): Range | null {
  const needle = normalizeForMatch(quote);
  if (needle === '') return null;

  const at = chooseOccurrence(index.text, needle, preferredStart);
  if (at < 0) return null;

  const start = index.positions[at];
  const end = index.positions[at + needle.length - 1];
  if (!start || !end) return null;

  const doc = start.node.ownerDocument;
  if (!doc) return null;

  try {
    const range = doc.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    return range;
  } catch {
    // Offsets can go stale if the DOM mutated between index build and here.
    return null;
  }
}

/** Convenience wrapper for a one-off lookup. */
export function findQuoteRange(
  root: Node,
  quote: string,
  preferredStart?: number | null,
): Range | null {
  return findQuoteRangeInIndex(buildNormalizedTextIndex(root), quote, preferredStart);
}
