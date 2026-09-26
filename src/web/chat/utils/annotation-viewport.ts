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

/**
 * `bottom` for the floating "Add note" pill on touch: clear of the composer
 * dock, and clear of the software keyboard if one happens to be open.
 *
 * `dockTop` is the composer dock's top edge in viewport coordinates. The
 * distance from there down to the bottom of the viewport already includes the
 * dock's own padding and safe-area inset, so no separate safe-area term is
 * needed. When the dock cannot be measured, the keyboard inset alone is used.
 */
export function computeDockedPillBottom(
  layoutHeight: number,
  dockTop: number | null,
  keyboardInset: number,
  gap = 8,
): number {
  const aboveDock = dockTop === null || !Number.isFinite(dockTop)
    ? 0
    : Math.max(0, layoutHeight - dockTop);
  const safeInset = Number.isFinite(keyboardInset) ? Math.max(0, keyboardInset) : 0;
  const base = Math.max(aboveDock, safeInset);
  if (!Number.isFinite(base)) return gap;
  return Math.round(base + gap);
}
