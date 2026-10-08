import { describe, it, expect } from 'vitest';
import { isLongPaste, shiftPastedRanges, pastedSpansForSubmit } from '../components/Composer/pasted-spans.js';

describe('isLongPaste', () => {
  it('records a paste of 8 or more lines, however short', () => {
    expect(isLongPaste(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'))).toBe(true);
    expect(isLongPaste(Array.from({ length: 7 }, (_, i) => `line ${i}`).join('\n'))).toBe(false);
  });

  it('leaves a long single paragraph as typed text, as dictation inserts it', () => {
    expect(isLongPaste('word '.repeat(300))).toBe(false);
  });
});

describe('shiftPastedRanges', () => {
  const paste = { start: 4, end: 10 }; // "PASTED" in "say PASTED end"
  const text = 'say PASTED end';

  it('shifts a paste when text is typed before it', () => {
    expect(shiftPastedRanges(text, 'well, say PASTED end', [paste])).toEqual([{ start: 10, end: 16 }]);
  });

  it('leaves a paste alone when text is typed after it', () => {
    expect(shiftPastedRanges(text, 'say PASTED end, ok?', [paste])).toEqual([paste]);
    expect(shiftPastedRanges(text, 'say PASTED! end', [paste])).toEqual([paste]);
  });

  it('resizes a paste edited inside', () => {
    expect(shiftPastedRanges(text, 'say PAED end', [paste])).toEqual([{ start: 4, end: 8 }]);
  });

  it('drops a paste whose edge was edited across, or that was deleted', () => {
    expect(shiftPastedRanges(text, 'saSTED end', [paste])).toEqual([]);
    expect(shiftPastedRanges(text, '', [paste])).toEqual([]);
  });
});

describe('pastedSpansForSubmit', () => {
  it('counts each paste back from the end of the trimmed text, in order', () => {
    const text = '  a PASTE b MORE c \n'; // trims to 'a PASTE b MORE c', 16 characters
    expect(pastedSpansForSubmit(text, [{ start: 12, end: 16 }, { start: 4, end: 9 }])).toEqual([
      { fromEnd: 14, length: 5 },
      { fromEnd: 6, length: 4 },
    ]);
  });
});
