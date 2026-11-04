import { describe, expect, it } from 'vitest';
import {
  annotationsStorageKey,
  formatAnnotatedMessage,
  formatAnnotationsBlock,
  parseAnnotatedMessage,
  sanitizeStoredAnnotations,
  type PendingAnnotation,
} from '../../src/web/chat/utils/annotations-format.js';
import { parseScreenshotQuote } from '../../src/web/chat/utils/image-note-crop.js';

function annotation(overrides: Partial<PendingAnnotation> = {}): PendingAnnotation {
  return {
    id: 'a1',
    messageId: 'msg-1',
    quote: 'the quick brown fox',
    note: 'this is wrong',
    createdAt: 1,
    ...overrides,
  };
}

describe('formatAnnotatedMessage', () => {
  it('returns the typed message untouched when there are no annotations', () => {
    expect(formatAnnotatedMessage([], 'just a normal message')).toBe('just a normal message');
  });

  it('prepends a single annotation ahead of the typed message', () => {
    const result = formatAnnotatedMessage([annotation()], 'please redo it');
    expect(result).toBe(
      [
        '[Notes on your earlier output]',
        '1. Re: "the quick brown fox"',
        '   Note: this is wrong',
        '[/Notes]',
        '',
        'please redo it',
      ].join('\n'),
    );
  });

  it('numbers multiple annotations in list order', () => {
    const result = formatAnnotatedMessage(
      [
        annotation({ id: 'a1', quote: 'first span', note: 'first note' }),
        annotation({ id: 'a2', quote: 'second span', note: 'second note' }),
        annotation({ id: 'a3', quote: 'third span', note: 'third note' }),
      ],
      'go',
    );
    expect(result).toBe(
      [
        '[Notes on your earlier output]',
        '1. Re: "first span"',
        '   Note: first note',
        '2. Re: "second span"',
        '   Note: second note',
        '3. Re: "third span"',
        '   Note: third note',
        '[/Notes]',
        '',
        'go',
      ].join('\n'),
    );
  });

  it('sends the notes block alone when the typed message is empty', () => {
    const result = formatAnnotatedMessage([annotation()], '');
    expect(result).toBe(
      [
        '[Notes on your earlier output]',
        '1. Re: "the quick brown fox"',
        '   Note: this is wrong',
        '[/Notes]',
      ].join('\n'),
    );
    expect(result.endsWith('[/Notes]')).toBe(true);
  });

  it('treats a whitespace-only typed message as empty', () => {
    expect(formatAnnotatedMessage([annotation()], '   \n  ')).toBe(
      formatAnnotatedMessage([annotation()], ''),
    );
  });

  it('emits quotes containing double quotes verbatim', () => {
    const result = formatAnnotatedMessage(
      [annotation({ quote: 'he said "no" loudly' })],
      'why?',
    );
    expect(result).toContain('1. Re: "he said "no" loudly"');
  });

  it('emits multi-line quotes verbatim, without re-indenting', () => {
    const result = formatAnnotatedMessage(
      [annotation({ quote: 'line one\nline two\nline three' })],
      'fix',
    );
    expect(result).toContain('1. Re: "line one\nline two\nline three"');
  });

  it('preserves markdown syntax inside quotes and notes', () => {
    const result = formatAnnotatedMessage(
      [annotation({ quote: '`const x = 1;` — **bold** [link](http://x)', note: '- bullet\n- another' })],
      '',
    );
    expect(result).toContain('1. Re: "`const x = 1;` — **bold** [link](http://x)"');
    expect(result).toContain('   Note: - bullet\n- another');
  });

  it('never truncates the quoted span, however long', () => {
    const longQuote = 'lorem ipsum dolor sit amet '.repeat(500).trim();
    expect(longQuote.length).toBeGreaterThan(10000);
    const result = formatAnnotatedMessage([annotation({ quote: longQuote })], 'thoughts?');
    expect(result).toContain(longQuote);
    expect(result).not.toContain('…');
    expect(result).not.toContain('...');
  });

  it('never truncates the note, however long', () => {
    const longNote = 'a very detailed explanation '.repeat(400).trim();
    const result = formatAnnotatedMessage([annotation({ note: longNote })], '');
    expect(result).toContain(longNote);
  });

  it('does not mangle a typed message that itself contains a notes block', () => {
    const typed = '[Notes on your earlier output]\nnot really\n[/Notes]';
    const result = formatAnnotatedMessage([annotation()], typed);
    expect(result.endsWith(typed)).toBe(true);
  });
});

describe('formatAnnotationsBlock', () => {
  it('is empty for no annotations', () => {
    expect(formatAnnotationsBlock([])).toBe('');
  });

  it('opens and closes with the delimiters', () => {
    const block = formatAnnotationsBlock([annotation()]);
    expect(block.startsWith('[Notes on your earlier output]\n')).toBe(true);
    expect(block.endsWith('\n[/Notes]')).toBe(true);
  });
});

describe('annotationsStorageKey', () => {
  it('is namespaced per conversation', () => {
    expect(annotationsStorageKey('conv-abc')).toBe('lattice-annotations-conv-abc');
  });

  it('falls back to a home key when there is no conversation', () => {
    expect(annotationsStorageKey(undefined)).toBe('lattice-annotations-home');
    expect(annotationsStorageKey(null)).toBe('lattice-annotations-home');
  });
});

describe('sanitizeStoredAnnotations', () => {
  it('returns an empty list for non-array storage values', () => {
    expect(sanitizeStoredAnnotations(null)).toEqual([]);
    expect(sanitizeStoredAnnotations({ id: 'a' })).toEqual([]);
    expect(sanitizeStoredAnnotations('[]')).toEqual([]);
  });

  it('drops entries missing an id, quote, or note', () => {
    const stored = [
      annotation(),
      { id: '', messageId: 'm', quote: 'q', note: 'n', createdAt: 1 },
      { id: 'b', messageId: 'm', quote: '', note: 'n', createdAt: 1 },
      { id: 'c', messageId: 'm', quote: 'q', note: 2, createdAt: 1 },
      null,
    ];
    const result = sanitizeStoredAnnotations(stored);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('defaults a missing createdAt rather than dropping the annotation', () => {
    const result = sanitizeStoredAnnotations([{ id: 'a', messageId: 'm', quote: 'q', note: 'n' }]);
    expect(result).toEqual([{ id: 'a', messageId: 'm', quote: 'q', note: 'n', createdAt: 0 }]);
  });

  it('keeps a note on a box drawn on a screenshot, and drops one whose box is not a fraction of the image', () => {
    const image = { src: '/api/images?path=%2Ftmp%2Fs.png', path: '/tmp/s.png', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } };
    const result = sanitizeStoredAnnotations([
      annotation({ image }),
      annotation({ id: 'b', image: { ...image, box: { x: 0.1, y: 0.2, w: 3, h: 0.05 } } }),
    ]);
    expect(result).toEqual([annotation({ image })]);
  });
});

describe('parseAnnotatedMessage', () => {
  it('round-trips what formatAnnotatedMessage sends', () => {
    const annotations = [
      annotation({ id: 'a1', quote: 'its card shows "Nothing will wake it"', note: '.... why?' }),
      annotation({ id: 'a2', quote: 'line one\nline two [/Notes] inside', note: 'multi\n2. not an entry' }),
      annotation({ id: 'a3', quote: 'q3', note: 'n3' }),
    ];
    for (const typed of ['', 'please redo it\nwith care']) {
      const parsed = parseAnnotatedMessage(formatAnnotatedMessage(annotations, typed));
      expect(parsed).toEqual({
        annotations: annotations.map(({ quote, note }) => ({ quote, note })),
        body: typed,
      });
    }
  });

  it('returns null for messages that are not a notes block', () => {
    expect(parseAnnotatedMessage('just a normal message')).toBeNull();
    expect(parseAnnotatedMessage('[Notes on your earlier output]\nfree text\n[/Notes]')).toBeNull();
    expect(parseAnnotatedMessage('[Notes on your earlier output]\n1. Re: "q"\n   Note: n')).toBeNull();
  });
});

describe('parseScreenshotQuote', () => {
  it('reads the caption and attached image back from a sent note on a screenshot', () => {
    expect(parseScreenshotQuote('Screenshot: Step 4: before (Put live) (/tmp/s/step4.png); box at x 1521–2315, y 1778–1940 px, drawn on attached image 2'))
      .toEqual({ label: 'Step 4: before (Put live)', image: 2 });
    expect(parseScreenshotQuote('Screenshot: Step 3 (/tmp/s/step3.png); box from 10% to 40% across and 5% to 9% down; no marked copy, because the image could not be read: 404'))
      .toEqual({ label: 'Step 3', image: null });
    expect(parseScreenshotQuote('Screenshot: of a passage the user highlighted')).toBeNull();
  });
});
