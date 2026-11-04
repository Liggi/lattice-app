/**
 * Viewport maths for the annotation UI. Pure so the keyboard-compensation
 * arithmetic can be tested without a real mobile browser.
 */

export interface ViewportMetrics {
  /** Visual viewport width — what the user can actually see. */
  width: number;
  /** Visual viewport height. Shrinks when a software keyboard opens. */
  height: number;
  /** Visual viewport top, relative to the layout viewport. Non-zero when iOS pans. */
  offsetTop: number;
  /** Layout viewport height — what `position: fixed` is measured against. */
  layoutHeight: number;
}

/**
 * Distance from the bottom of the *layout* viewport to the bottom of the
 * *visual* viewport — i.e. the `bottom` a fixed element needs so it sits just
 * above the software keyboard.
 *
 * `position: fixed` resolves against the layout viewport, which iOS leaves
 * unchanged when the keyboard opens: only the visual viewport shrinks, and it
 * may additionally be panned down (`offsetTop > 0`) to reveal the focused
 * input. Both effects have to be subtracted.
 *
 * On Android Chrome's default `interactive-widget=resizes-visual` this behaves
 * the same; under `resizes-content` the layout viewport shrinks too and this
 * correctly returns ~0.
 */
export function computeKeyboardInset(
  layoutHeight: number,
  visual: { offsetTop: number; height: number } | null,
): number {
  if (!visual) return 0;
  const inset = layoutHeight - visual.offsetTop - visual.height;
  if (!Number.isFinite(inset) || inset <= 0) return 0;
  return Math.round(inset);
}

/**
 * Whether the annotation UI should dock (pill above the composer, note editor
 * as a bottom sheet) rather than anchor to the selection rect.
 *
 * Coarse pointers get docked placement because iOS draws its own edit menu
 * above *or* below the selection depending on available room — any
 * selection-anchored placement collides with it in some cases. Narrow viewports
 * get the same treatment for the same lack-of-room reason.
 */
export function shouldDockAnnotationUi(pointerCoarse: boolean, viewportWidth: number): boolean {
  return pointerCoarse || viewportWidth < 640;
}

/** Where the touch selection bar goes: exactly over the composer, or floating centred above the keyboard. */
export type DockedBarPlacement =
  | { over: true; top: number; left: number; width: number; height: number }
  | { over: false; bottom: number };

/**
 * Placement for the touch selection bar. It covers the composer card exactly,
 * so it never covers the transcript's last lines, which is where the bottom of
 * a message being selected sits; typing is not possible mid-selection, so
 * hiding the composer costs nothing. With a software keyboard open, or no
 * composer to measure, it floats centred just above the keyboard instead.
 *
 * `composer` is the composer card's box in viewport coordinates.
 */
export function computeDockedBarPlacement(
  composer: { top: number; bottom: number; left: number; right: number } | null,
  keyboardInset: number,
  gap = 8,
): DockedBarPlacement {
  const safeInset = Number.isFinite(keyboardInset) ? Math.max(0, keyboardInset) : 0;
  const measured = composer !== null
    && [composer.top, composer.bottom, composer.left, composer.right].every(Number.isFinite)
    && composer.bottom > composer.top
    && composer.right > composer.left;
  if (!measured || safeInset > 0) return { over: false, bottom: Math.round(safeInset + gap) };
  return {
    over: true,
    top: Math.round(composer.top),
    left: Math.round(composer.left),
    width: Math.round(composer.right - composer.left),
    height: Math.round(composer.bottom - composer.top),
  };
}
