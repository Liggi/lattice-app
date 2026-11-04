import { describe, expect, it } from 'vitest';
import {
  computeDockedBarPlacement,
  computeKeyboardInset,
  shouldDockAnnotationUi,
} from '../../src/web/chat/utils/annotation-viewport.js';

describe('computeKeyboardInset', () => {
  it('is zero with no keyboard open', () => {
    expect(computeKeyboardInset(800, { offsetTop: 0, height: 800 })).toBe(0);
  });

  it('equals the keyboard height when the visual viewport only shrinks', () => {
    expect(computeKeyboardInset(800, { offsetTop: 0, height: 500 })).toBe(300);
  });

  it('accounts for iOS panning the visual viewport within the layout viewport', () => {
    // Safari shrinks the visual viewport to 500 AND scrolls it 120px down to
    // reveal the focused input. The visible bottom edge is at layout-y 620, so
    // a fixed element needs bottom: 180 — not 300.
    expect(computeKeyboardInset(800, { offsetTop: 120, height: 500 })).toBe(180);
  });

  it('is zero when the layout viewport shrinks too (Android resizes-content)', () => {
    expect(computeKeyboardInset(500, { offsetTop: 0, height: 500 })).toBe(0);
  });

  it('never goes negative when the visual viewport exceeds the layout viewport', () => {
    // Happens transiently during pinch-zoom and rubber-band scrolling.
    expect(computeKeyboardInset(800, { offsetTop: 0, height: 900 })).toBe(0);
    expect(computeKeyboardInset(800, { offsetTop: 200, height: 800 })).toBe(0);
  });

  it('is zero when there is no visualViewport at all', () => {
    expect(computeKeyboardInset(800, null)).toBe(0);
  });

  it('rounds to whole pixels — visualViewport reports fractions', () => {
    expect(computeKeyboardInset(844, { offsetTop: 0, height: 507.3333 })).toBe(337);
  });

  it('is zero for non-finite input rather than producing NaN styles', () => {
    expect(computeKeyboardInset(Number.NaN, { offsetTop: 0, height: 500 })).toBe(0);
  });
});

describe('computeDockedBarPlacement', () => {
  const card = { top: 700, bottom: 790, left: 16, right: 374 };

  it('covers the composer card exactly', () => {
    expect(computeDockedBarPlacement(card, 0)).toEqual({ over: true, top: 700, left: 16, width: 358, height: 90 });
  });

  it('floats above an open keyboard instead', () => {
    expect(computeDockedBarPlacement(card, 300)).toEqual({ over: false, bottom: 308 });
  });

  it('floats above the bottom edge when the composer cannot be measured', () => {
    expect(computeDockedBarPlacement(null, 0)).toEqual({ over: false, bottom: 8 });
    expect(computeDockedBarPlacement({ ...card, top: Number.NaN }, 0)).toEqual({ over: false, bottom: 8 });
    expect(computeDockedBarPlacement({ ...card, bottom: 700 }, 0)).toEqual({ over: false, bottom: 8 });
  });

  it('ignores a non-finite keyboard inset rather than producing NaN styles', () => {
    expect(computeDockedBarPlacement(card, Number.NaN)).toEqual({ over: true, top: 700, left: 16, width: 358, height: 90 });
  });
});

describe('shouldDockAnnotationUi', () => {
  it('docks on coarse pointers at any width', () => {
    expect(shouldDockAnnotationUi(true, 1400)).toBe(true);
    expect(shouldDockAnnotationUi(true, 390)).toBe(true);
  });

  it('docks on narrow viewports even with a mouse', () => {
    expect(shouldDockAnnotationUi(false, 500)).toBe(true);
  });

  it('anchors to the selection on a wide mouse-driven viewport', () => {
    expect(shouldDockAnnotationUi(false, 640)).toBe(false);
    expect(shouldDockAnnotationUi(false, 1440)).toBe(false);
  });
});
