/**
 * The bold-span extractor that decides which terms in an article get tooltips.
 *
 * Each generated tooltip costs a model call, so what these pin down is the
 * boundary: which spans count as a concept, and that the same term appearing
 * five times is still one concept.
 *
 * Every expectation below was run against the original implementation this was
 * ported from (`extract-bolded-from-markdown.ts` in the learning app) and
 * matches its output, including the two ugly cases — a span broken over a
 * newline, and `***bold italic***`. The one exception is called out in its own
 * test: the original throws on an empty `****` span and this does not.
 */

import { describe, expect, it } from 'vitest';
import { extractBoldConcepts } from '../../src/services/km/extract-bold-concepts.js';

describe('extractBoldConcepts', () => {
  it('returns nothing for empty or unbolded text', () => {
    expect(extractBoldConcepts('')).toEqual([]);
    expect(extractBoldConcepts('Plain prose with *emphasis* and `code`.')).toEqual([]);
  });

  it('picks up both bold markers', () => {
    expect(extractBoldConcepts('A **star bold** and an __underscore bold__ term.'))
      .toEqual(['star bold', 'underscore bold']);
  });

  it('trims the span and drops whitespace-only ones', () => {
    expect(extractBoldConcepts('** padded ** and __ __')).toEqual(['padded']);
  });

  it('dedupes repeats while keeping first-appearance order', () => {
    const text = '**backpressure** then **event log** then **backpressure** again.';
    expect(extractBoldConcepts(text)).toEqual(['backpressure', 'event log']);
  });

  it('treats a difference in case as a different concept', () => {
    expect(extractBoldConcepts('**Event Log** and **event log**'))
      .toEqual(['Event Log', 'event log']);
  });

  it('matches lazily, so adjacent spans stay separate', () => {
    expect(extractBoldConcepts('**one** middle **two**')).toEqual(['one', 'two']);
  });

  it('finds spans across multiple lines of an article', () => {
    const article = [
      '# The harness event log',
      '',
      'Events flow through the **EventLog** to per-session SSE.',
      '',
      '- **SqliteEventStorage** persists them',
      '- the **daemon** owns the PTY',
    ].join('\n');

    expect(extractBoldConcepts(article))
      .toEqual(['EventLog', 'SqliteEventStorage', 'daemon']);
  });

  /**
   * A span cannot cross a newline, so the opening `**` of the broken span never
   * closes and its trailing `**` pairs with the next one instead — collecting
   * the plain words between them. Not what anyone wants, but it is what the
   * original does, and it is why an article is not free to bold across a line.
   */
  it('pairs a newline-broken span with the next marker, as the original does', () => {
    expect(extractBoldConcepts('**broken\nover lines** but **intact** here'))
      .toEqual(['but']);
  });

  it('takes bold-italic as its inner span plus the stray asterisk', () => {
    expect(extractBoldConcepts('***emphatic***')).toEqual(['*emphatic']);
  });

  /**
   * The original throws here: the `**` branch matches with an empty capture,
   * `match[1] || match[2]` falls through to the undefined `__` group, and
   * `.trim()` blows up. Dropping the empty span keeps the rest of the article.
   */
  it('drops an empty span instead of throwing', () => {
    expect(extractBoldConcepts('**** and **ok**')).toEqual(['ok']);
  });
});
