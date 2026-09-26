// @vitest-environment happy-dom

/**
 * Locating a persisted exchange's span in the rendered article, and reading a
 * fresh selection out of it.
 *
 * The two failure modes worth pinning: an exchange whose quote has been edited
 * out must fall back rather than vanish, and a phrase that repeats must anchor
 * on the copy that was actually highlighted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  anchorExchanges,
  blockAncestor,
} from '../../src/web/chat/components/LearningMap/article/exchange-anchoring.js';
import {
  createArticleSelectionReader,
  resetArticleSelectionMemo,
} from '../../src/web/chat/components/LearningMap/article/article-selection.js';

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

/** A selection over one text node, as a drag inside a paragraph produces. */
function selectWithin(node: Node, start: number, end: number): Selection {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
  resetArticleSelectionMemo();
});

describe('blockAncestor', () => {
  it('walks up to the direct child of the host', () => {
    const host = mount('<p>outer <em>inner</em></p>');
    const em = host.querySelector('em')!;
    expect(blockAncestor(host, em.firstChild)).toBe(host.firstElementChild);
  });

  it('returns null for a node outside the host', () => {
    const host = mount('<p>inside</p>');
    const stranger = document.createElement('p');
    document.body.appendChild(stranger);
    expect(blockAncestor(host, stranger)).toBeNull();
  });
});

describe('anchorExchanges', () => {
  it('anchors each exchange to the block its span ends in', () => {
    const host = mount('<p>The retry loop</p><p>never backs off.</p>');

    const { groups, unlocated } = anchorExchanges(host, [
      { id: 'e1', quote: 'retry loop', quote_start: null },
      { id: 'e2', quote: 'backs off', quote_start: null },
    ]);

    expect(unlocated).toEqual([]);
    expect(groups).toHaveLength(2);
    expect(groups[0].block).toBe(host.children[0]);
    expect(groups[0].exchangeIds).toEqual(['e1']);
    expect(groups[1].block).toBe(host.children[1]);
    expect(groups[1].exchangeIds).toEqual(['e2']);
  });

  it('matches across a block boundary the way a selection reads it', () => {
    const host = mount('<p>The retry loop</p><p>never backs off.</p>');

    // selection.toString() inserts a newline the DOM has no text node for.
    const { groups, unlocated } = anchorExchanges(host, [
      { id: 'e1', quote: 'retry loop\nnever backs', quote_start: null },
    ]);

    expect(unlocated).toEqual([]);
    // The span *ends* in the second paragraph, so the card hangs there.
    expect(groups[0].block).toBe(host.children[1]);
  });

  it('groups several exchanges on one block, in the order given', () => {
    const host = mount('<p>one shared paragraph</p>');

    const { groups } = anchorExchanges(host, [
      { id: 'older', quote: 'one shared', quote_start: null },
      { id: 'newer', quote: 'paragraph', quote_start: null },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].exchangeIds).toEqual(['older', 'newer']);
  });

  it('uses quote_start to pick the repeated copy that was highlighted', () => {
    const host = mount('<p>the daemon</p><p>filler</p><p>the daemon</p>');

    const first = anchorExchanges(host, [
      { id: 'e1', quote: 'the daemon', quote_start: 0 },
    ]);
    expect(first.groups[0].block).toBe(host.children[0]);

    // "thedaemonfiller" is 15 whitespace-free characters, so the second copy
    // starts at 15 in the normalized index.
    const second = anchorExchanges(host, [
      { id: 'e1', quote: 'the daemon', quote_start: 15 },
    ]);
    expect(second.groups[0].block).toBe(host.children[2]);
  });

  it('falls back to the first copy when no offset was recorded', () => {
    const host = mount('<p>the daemon</p><p>the daemon</p>');
    const { groups } = anchorExchanges(host, [
      { id: 'e1', quote: 'the daemon', quote_start: null },
    ]);
    expect(groups[0].block).toBe(host.children[0]);
  });

  it('reports a quote edited out of the article instead of dropping it', () => {
    const host = mount('<p>rewritten since</p>');

    const { groups, unlocated } = anchorExchanges(host, [
      { id: 'gone', quote: 'text that no longer exists', quote_start: 3 },
      { id: 'here', quote: 'rewritten', quote_start: 0 },
    ]);

    expect(unlocated).toEqual(['gone']);
    expect(groups.flatMap(g => g.exchangeIds)).toEqual(['here']);
  });

  it('ignores text inside already-rendered cards', () => {
    const host = mount(
      '<p>real article text</p>'
      + '<div data-annotation-ui="true"><p>a previous answer mentioning ghosts</p></div>',
    );

    const { groups, unlocated } = anchorExchanges(host, [
      { id: 'e1', quote: 'ghosts', quote_start: null },
    ]);

    expect(groups).toEqual([]);
    expect(unlocated).toEqual(['e1']);
  });

  it('does nothing when there are no exchanges', () => {
    const host = mount('<p>body</p>');
    expect(anchorExchanges(host, [])).toEqual({ groups: [], unlocated: [] });
  });
});

describe('createArticleSelectionReader', () => {
  it('captures the quote, the article id and the offset', () => {
    const host = mount('<p>the daemon owns the PTY</p>');
    const read = createArticleSelectionReader('km-art-1', () => host);
    const textNode = host.querySelector('p')!.firstChild!;

    const target = read(selectWithin(textNode, 4, 10));

    expect(target).toMatchObject({ messageId: 'km-art-1', quote: 'daemon' });
    // "the" is three whitespace-free characters before it.
    expect(target?.quoteStart).toBe(3);
  });

  it('rejects a collapsed or whitespace-only selection', () => {
    const host = mount('<p>a b</p>');
    const read = createArticleSelectionReader('km-art-1', () => host);
    const textNode = host.querySelector('p')!.firstChild!;

    expect(read(selectWithin(textNode, 2, 2))).toBeNull();
    expect(read(selectWithin(textNode, 1, 2))).toBeNull();
    expect(read(null)).toBeNull();
  });

  it('rejects a selection outside the article body', () => {
    const host = mount('<p>inside</p>');
    const outside = mount('<p>chrome text</p>');
    const read = createArticleSelectionReader('km-art-1', () => host);

    expect(read(selectWithin(outside.querySelector('p')!.firstChild!, 0, 6))).toBeNull();
  });

  it('rejects a selection inside an exchange card', () => {
    const host = mount(
      '<p>article</p><div data-annotation-ui="true"><p>a previous answer</p></div>',
    );
    const read = createArticleSelectionReader('km-art-1', () => host);
    const cardText = host.querySelector('[data-annotation-ui] p')!.firstChild!;

    expect(read(selectWithin(cardText, 0, 8))).toBeNull();
  });

  it('returns null before the body has mounted', () => {
    const host = mount('<p>text</p>');
    const read = createArticleSelectionReader('km-art-1', () => null);
    expect(read(selectWithin(host.querySelector('p')!.firstChild!, 0, 4))).toBeNull();
  });
});
