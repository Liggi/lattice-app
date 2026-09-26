// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNormalizedTextIndex,
  findQuoteRange,
  findQuoteRangeInIndex,
  normalizeForMatch,
  normalizedOffsetOfPoint,
} from '../../src/web/chat/utils/annotation-range.js';

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('normalizeForMatch', () => {
  it('strips all whitespace', () => {
    expect(normalizeForMatch('  the   quick\n\nbrown \t fox  ')).toBe('thequickbrownfox');
  });

  it('is empty for whitespace-only input', () => {
    expect(normalizeForMatch('   \n\t ')).toBe('');
  });
});

describe('buildNormalizedTextIndex', () => {
  it('drops the markdown indentation between block elements', () => {
    const host = mount(`
      <p>The retry loop</p>
      <p>never backs off.</p>
    `);
    expect(buildNormalizedTextIndex(host).text).toBe('Theretryloopneverbacksoff.');
  });

  it('maps every indexed character back to a source text node', () => {
    const host = mount('<p>ab</p><p>cd</p>');
    const index = buildNormalizedTextIndex(host);
    // No whitespace text node exists between the two blocks — the reason
    // matching cannot rely on collapsing whitespace.
    expect(index.text).toBe('abcd');
    expect(index.positions).toHaveLength(4);
    expect(index.positions[0].node.data).toBe('ab');
    expect(index.positions[0].offset).toBe(0);
    expect(index.positions[3].node.data).toBe('cd');
    expect(index.positions[3].offset).toBe(1);
  });

  it('skips subtrees belonging to the annotation UI itself', () => {
    const host = mount(`
      <p>real content</p>
      <div data-annotation-ui="true"><span>Add note</span></div>
    `);
    expect(buildNormalizedTextIndex(host).text).toBe('realcontent');
  });

  it('is empty for a subtree with no text', () => {
    const host = mount('<div><svg><path></path></svg></div>');
    expect(buildNormalizedTextIndex(host).text).toBe('');
  });
});

describe('findQuoteRange', () => {
  it('resolves a quote inside a single text node', () => {
    const host = mount('<p>The retry loop is unbounded and will spin.</p>');
    const range = findQuoteRange(host, 'loop is unbounded');
    expect(range).not.toBeNull();
    expect(range?.toString()).toBe('loop is unbounded');
  });

  it('resolves a quote spanning two markdown blocks, where the selection carried a newline', () => {
    // `selection.toString()` across <p> boundaries yields "\n", which exists in
    // no text node — the whole reason both sides are normalised.
    const host = mount('<p>The retry loop</p><p>never backs off.</p>');
    const range = findQuoteRange(host, 'retry loop\nnever backs');
    expect(range).not.toBeNull();
    expect(range?.startContainer.textContent).toBe('The retry loop');
    expect(range?.endContainer.textContent).toBe('never backs off.');
    expect(range?.startOffset).toBe(4);
    expect(range?.endOffset).toBe(11);
  });

  it('resolves a quote spanning a list, crossing several elements', () => {
    const host = mount('<ul><li>first item</li><li>second item</li><li>third item</li></ul>');
    const range = findQuoteRange(host, 'second item\nthird');
    expect(range).not.toBeNull();
    expect(range?.startContainer.textContent).toBe('second item');
    expect(range?.endContainer.textContent).toBe('third item');
  });

  it('resolves a quote that crosses inline formatting', () => {
    const host = mount('<p>the <strong>bold</strong> claim</p>');
    const range = findQuoteRange(host, 'the bold claim');
    expect(range).not.toBeNull();
    expect(range?.startContainer.textContent).toBe('the ');
    expect(range?.endContainer.textContent).toBe(' claim');
  });

  it('tolerates a quote whose whitespace differs from the rendered DOM', () => {
    const host = mount('<p>alpha   beta</p>');
    expect(findQuoteRange(host, 'alpha beta')?.toString()).toBe('alpha   beta');
    expect(findQuoteRange(host, '  alpha\n\nbeta  ')?.toString()).toBe('alpha   beta');
  });

  it('returns null when the quote is not present — the message changed or was replaced', () => {
    const host = mount('<p>The retry loop is unbounded.</p>');
    expect(findQuoteRange(host, 'a sentence that was never rendered')).toBeNull();
  });

  it('returns null for an empty or whitespace-only quote', () => {
    const host = mount('<p>content</p>');
    expect(findQuoteRange(host, '')).toBeNull();
    expect(findQuoteRange(host, '   \n ')).toBeNull();
  });

  it('takes the first occurrence when the quote repeats and no position was captured', () => {
    const host = mount('<p id="a">repeat</p><p id="b">repeat</p>');
    const range = findQuoteRange(host, 'repeat');
    expect(range?.startContainer.parentElement?.id).toBe('a');
  });

  it('resolves a repeated quote to the occurrence the user actually selected', () => {
    // The bug this covers: annotating the second "repeat" put the highlight and
    // its comment icon on the first one, because resolution was a plain
    // indexOf over the message text.
    const host = mount('<p id="a">repeat</p><p id="b">repeat</p><p id="c">repeat</p>');
    expect(findQuoteRange(host, 'repeat', 0)?.startContainer.parentElement?.id).toBe('a');
    expect(findQuoteRange(host, 'repeat', 6)?.startContainer.parentElement?.id).toBe('b');
    expect(findQuoteRange(host, 'repeat', 12)?.startContainer.parentElement?.id).toBe('c');
  });

  it('takes the nearest occurrence when earlier text has shifted the offsets', () => {
    // A thinking block collapsing above the quote moves every offset after it,
    // so an exact-match-only rule would drop the highlight entirely.
    const host = mount('<p id="a">repeat</p><p id="b">repeat</p>');
    expect(findQuoteRange(host, 'repeat', 5)?.startContainer.parentElement?.id).toBe('b');
    expect(findQuoteRange(host, 'repeat', 99)?.startContainer.parentElement?.id).toBe('b');
  });

  it('finds overlapping repeats, not just disjoint ones', () => {
    const host = mount('<p>aaaa</p>');
    expect(findQuoteRange(host, 'aa', 2)?.startOffset).toBe(2);
  });

  it('reuses a prebuilt index across several quotes', () => {
    const host = mount('<p>alpha</p><p>beta</p><p>gamma</p>');
    const index = buildNormalizedTextIndex(host);
    expect(findQuoteRangeInIndex(index, 'alpha')?.toString()).toBe('alpha');
    expect(findQuoteRangeInIndex(index, 'gamma')?.toString()).toBe('gamma');
    expect(findQuoteRangeInIndex(index, 'delta')).toBeNull();
  });
});

describe('normalizedOffsetOfPoint', () => {
  it('reports where a DOM point falls in the whitespace-free text', () => {
    const host = mount('<p>The retry loop</p><p>never backs off.</p>');
    const index = buildNormalizedTextIndex(host);
    const second = host.querySelectorAll('p')[1].firstChild!;

    expect(normalizedOffsetOfPoint(index, host.querySelector('p')!.firstChild!, 0)).toBe(0);
    // "Theretryloop" is 12 characters, so the second block starts at 12.
    expect(normalizedOffsetOfPoint(index, second, 0)).toBe(12);
    expect(normalizedOffsetOfPoint(index, second, 6)).toBe(17);
  });

  it('rounds a point inside whitespace forward to the next real character', () => {
    const host = mount('<p>alpha   beta</p>');
    const index = buildNormalizedTextIndex(host);
    const text = host.querySelector('p')!.firstChild!;
    // Offsets 5..7 are the run of spaces; all resolve to the "b" of beta.
    expect(normalizedOffsetOfPoint(index, text, 6)).toBe(5);
    expect(normalizeForMatch(host.textContent ?? '')[5]).toBe('b');
  });

  it('is null past the end of the text, and for an empty index', () => {
    const host = mount('<p>abc</p>');
    const index = buildNormalizedTextIndex(host);
    expect(normalizedOffsetOfPoint(index, host.querySelector('p')!.firstChild!, 3)).toBeNull();
    expect(normalizedOffsetOfPoint({ text: '', positions: [] }, host, 0)).toBeNull();
  });
});
