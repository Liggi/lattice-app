/**
 * The concepts an article offers tooltips for: its bold spans.
 *
 * Bolding is already how an article marks the terms that carry weight, so it
 * doubles as the tooltip index — no separate list of terms to keep in sync with
 * the prose. Ported from the learning app this feature comes from; the regex,
 * the trim, and the order-preserving dedupe are that behaviour.
 *
 * This is a regex over raw text, not a markdown parse, and it inherits that
 * bluntness from the original: `.` does not cross newlines, so a span broken
 * over two lines does not match — and the engine then pairs its closing `**`
 * with the next one, which can pick out the words in between. `***bold
 * italic***` comes out as `*bold italic`. Both are rare enough in written
 * articles to be worth less than parsing markdown here would cost.
 *
 * One deliberate divergence: an empty span (`****`) throws in the original,
 * where the `**` branch matches, captures `''`, and `match[1] || match[2]`
 * falls through to an undefined group. Here it is dropped like any other empty
 * concept. Every input the original does not crash on gives the same answer.
 *
 * Comparison is case-sensitive, so `**Backpressure**` and `**backpressure**` are
 * two concepts. That is the same key space the stored tooltips object uses.
 */

const BOLD_SPAN = /\*\*(.*?)\*\*|__(.*?)__/g;

/**
 * Bold spans in `text`, trimmed, empties dropped, duplicates removed, first
 * appearance order kept.
 */
export function extractBoldConcepts(text: string): string[] {
  if (!text) return [];

  const seen = new Set<string>();
  const concepts: string[] = [];

  for (const match of text.matchAll(BOLD_SPAN)) {
    // `**` and `__` are alternatives, so exactly one group is defined — unless
    // the span was empty (`****`), where the group is '' and there is nothing
    // to collect either way.
    const concept = (match[1] ?? match[2] ?? '').trim();
    if (!concept || seen.has(concept)) continue;
    seen.add(concept);
    concepts.push(concept);
  }

  return concepts;
}
