/**
 * Shared visual vocabulary for the note-annotation surfaces.
 *
 * Centralised so the "Add note" button, the note editor (sheet and popover), the
 * span marker's popover and the status-bar badge popover provably share one
 * radius, one surface and one label typography, rather than drifting apart as
 * each was styled.
 *
 * Everything here is the app's own flat vocabulary (theme.css):
 *  - panels: `bg-surface` with a `border-line` hairline, 10px radius, no
 *    shadow and no blur.
 *  - labels: 12px medium Geist in `text-fg-2`. No display face, no tracking.
 *  - accent: cyan, and only on the one primary action.
 */

/** Floating panel: sheet, note popover, span popover, badge popover. */
export const ANNOTATION_PANEL =
  'rounded-lg border border-line bg-surface';

/** Header strip inside a panel — hairline rule under a glyph + label. */
export const ANNOTATION_PANEL_HEADER =
  'flex items-center gap-2 px-3 py-2 border-b border-line';

/** Panel header label. */
export const ANNOTATION_PANEL_LABEL =
  'text-xs font-medium text-fg-2';

/** Body copy inside a panel — user content, so readable, not chrome. */
export const ANNOTATION_PANEL_BODY =
  'px-3 py-2 text-[13px] leading-relaxed text-fg break-words whitespace-pre-wrap';

/** Shared button shape: 6px radius, 13px medium, 44px tall for touch. */
export const ANNOTATION_BUTTON_BASE =
  'min-h-[44px] rounded-sm text-[13px] font-medium '
  + 'transition-colors duration-100 cursor-pointer select-none';

/** Primary: the accent on text, a surface step on hover. */
export const ANNOTATION_BUTTON_PRIMARY =
  'text-accent hover:bg-accent-soft '
  + 'disabled:opacity-40 disabled:hover:bg-transparent';

/** Tertiary: quiet text. */
export const ANNOTATION_BUTTON_GHOST =
  'text-fg-2 hover:text-fg hover:bg-surface-2';

/** Side of the desktop "Add note" button, a square holding only its icon. */
export const ANNOTATION_ICON_BUTTON_PX = 28;

/** The desktop "Add note" button: a quiet square with the accent on the icon. */
export const ANNOTATION_ICON_BUTTON =
  'flex items-center justify-center rounded-sm bg-surface border border-line text-accent '
  + 'hover:bg-surface-2 hover:border-line-2 active:bg-surface-2 '
  + 'transition-colors duration-100 cursor-pointer select-none';

/**
 * The phone's selection toolbar: one solid panel docked above the composer,
 * a step above the page so it stands off the cards it floats over.
 */
export const ANNOTATION_TOOLBAR =
  'flex items-stretch gap-0.5 rounded-lg border border-line-2 bg-surface-2 p-1';

/** A toolbar action: its icon above a short label, sized for a thumb. */
export const ANNOTATION_TOOLBAR_BUTTON =
  'flex min-h-[52px] min-w-[76px] flex-col items-center justify-center gap-1 rounded-sm px-2 '
  + 'text-[11px] font-medium text-fg-2 hover:bg-line-2 hover:text-fg active:bg-line-2 '
  + 'transition-colors duration-100 cursor-pointer select-none';
