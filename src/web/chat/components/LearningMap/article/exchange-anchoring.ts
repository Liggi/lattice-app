/**
 * Locating a persisted exchange's quoted span inside the rendered article, and
 * deciding where its card hangs.
 *
 * Reuses the annotation machinery wholesale: `buildNormalizedTextIndex` +
 * `findQuoteRangeInIndex` match a stored quote against rendered markdown while
 * ignoring whitespace, and `quote_start` picks the right occurrence when a
 * phrase repeats. Same semantics as a message annotation — the offset is into
 * the whitespace-free text of the *rendered* article, and matching is
 * nearest-wins, so an edit that shifts earlier text degrades gracefully instead
 * of jumping the card to the wrong copy.
 *
 * A quote that no longer appears at all (the article was rewritten) resolves to
 * nothing and comes back in `unlocated`, which the surface renders as a list at
 * the end. An exchange is never dropped.
 */

import {
  buildNormalizedTextIndex,
  findQuoteRangeInIndex,
} from '../../../utils/annotation-range';

export interface AnchorableExchange {
  id: string;
  quote: string;
  quote_start: number | null;
}

export interface ExchangeAnchorGroup {
  /**
   * The direct child of the article host that contains the end of the span.
   * Cards are inserted after it, so a card lands under the paragraph its span
   * sits in rather than inside it — inline markup must not be re-parented.
   */
  block: ChildNode;
  /** Exchanges anchored to this block, in the order they were passed in. */
  exchangeIds: string[];
}

export interface ExchangeAnchoring {
  /** Groups in document order of their block. */
  groups: ExchangeAnchorGroup[];
  /** Ids whose quote is no longer present in the article. */
  unlocated: string[];
}

/**
 * Walks up from `node` to the direct child of `host` that contains it. Returns
 * null when the node is not inside the host at all.
 */
export function blockAncestor(host: HTMLElement, node: Node | null | undefined): ChildNode | null {
  let current: Node | null = node ?? null;
  while (current && current !== host) {
    const parent: Node | null = current.parentNode;
    if (parent === host) return current as ChildNode;
    current = parent;
  }
  return null;
}

/**
 * Resolves every exchange against the rendered article in one pass.
 *
 * The text index is built once for the whole host — quotes are matched against
 * the same index, which is both cheaper and the only way the offsets in
 * `quote_start` stay comparable between exchanges.
 */
export function anchorExchanges(
  host: HTMLElement,
  exchanges: readonly AnchorableExchange[],
): ExchangeAnchoring {
  const groups: ExchangeAnchorGroup[] = [];
  const unlocated: string[] = [];
  if (exchanges.length === 0) return { groups, unlocated };

  const index = buildNormalizedTextIndex(host);
  const byBlock = new Map<ChildNode, ExchangeAnchorGroup>();
  const blockOrder: ChildNode[] = Array.from(host.childNodes);

  for (const exchange of exchanges) {
    const range = findQuoteRangeInIndex(index, exchange.quote, exchange.quote_start);
    const block = range ? blockAncestor(host, range.endContainer) : null;
    if (!block) {
      unlocated.push(exchange.id);
      continue;
    }

    const existing = byBlock.get(block);
    if (existing) {
      existing.exchangeIds.push(exchange.id);
    } else {
      byBlock.set(block, { block, exchangeIds: [exchange.id] });
    }
  }

  for (const block of blockOrder) {
    const group = byBlock.get(block);
    if (group) groups.push(group);
  }

  return { groups, unlocated };
}
