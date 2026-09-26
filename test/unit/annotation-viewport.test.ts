import { describe, expect, it } from 'vitest';
import {
  computeDockedPillBottom,
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

describe('computeDockedPillBottom', () => {
  it('clears the composer dock', () => {
    // Dock top at 700 in an 800px viewport → 100px of dock below it, + 8 gap.
    expect(computeDockedPillBottom(800, 700, 0)).toBe(108);
  });

  it('falls back to the keyboard inset when the dock cannot be measured', () => {
    expect(computeDockedPillBottom(800, null, 300)).toBe(308);
    expect(computeDockedPillBottom(800, null, 0)).toBe(8);
  });

  it('takes whichever of the dock and the keyboard is higher', () => {
    // Keyboard taller than the dock offset.
    expect(computeDockedPillBottom(800, 700, 300)).toBe(308);
    // Dock offset taller than the keyboard.
    expect(computeDockedPillBottom(800, 500, 100)).toBe(308);
  });

  it('ignores a dock measured below the viewport bottom', () => {
    expect(computeDockedPillBottom(800, 900, 0)).toBe(8);
  });

  it('ignores non-finite inputs rather than producing NaN styles', () => {
    expect(computeDockedPillBottom(800, Number.NaN, 0)).toBe(8);
    expect(computeDockedPillBottom(800, 700, Number.NaN)).toBe(108);
  });

  it('honours a custom gap', () => {
    expect(computeDockedPillBottom(800, 700, 0, 20)).toBe(120);
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
