/**
 * Structural design tokens — light mode uses Sundial parchment palette,
 * dark mode uses Tailwind's warm stone scale. Consumer sets `class="dark"`
 * on a parent element to activate dark mode.
 *
 * Light-mode palette: Sundial "Parchment" — warm neutrals from the Ash
 * design system. The consumer registers `--color-parchment-*` in their
 * Tailwind @theme block.
 */
export const tk = {
  card: {
    bg: 'bg-white dark:bg-stone-800/40',
    border: 'border-parchment-300 dark:border-white/[0.08]',
  },
  surface: 'bg-white dark:bg-stone-900',
  codeBg: 'bg-parchment-100 dark:bg-stone-900',
  codeBgSubtle: 'bg-parchment-50 dark:bg-stone-900/60',
  text: {
    heading: 'text-parchment-900 dark:text-stone-200',
    primary: 'text-parchment-800 dark:text-stone-300',
    secondary: 'text-parchment-600 dark:text-stone-400',
    muted: 'text-parchment-500 dark:text-stone-500',
    faint: 'text-parchment-400 dark:text-stone-600',
  },
  separator: 'border-parchment-200 dark:border-white/[0.08]',
  hover: 'hover:bg-parchment-100 dark:hover:bg-stone-800/70',
  scrollbar: 'scrollbar-thin scrollbar-track-transparent scrollbar-thumb-parchment-300 dark:scrollbar-thumb-stone-700',
} as const;

/**
 * Per-tool accents. Every tool shares one flat card; the hue is carried only
 * by the small header icon, and only in light mode where it lifts the icon
 * off white. In dark mode the icon is a neutral secondary so a busy thread
 * reads as one surface, with colour reserved for state (errors, approvals).
 */
const NEUTRAL_CARD = '';
const neutralAccent = (lightIcon: string) => ({
  card: NEUTRAL_CARD,
  icon: `${lightIcon} dark:text-stone-400`,
});

export const accent = {
  blue:    neutralAccent('text-blue-600'),
  emerald: neutralAccent('text-emerald-600'),
  violet:  neutralAccent('text-violet-600'),
  orange:  neutralAccent('text-orange-600'),
  amber:   neutralAccent('text-amber-600'),
  purple:  neutralAccent('text-purple-600'),
  cyan:    neutralAccent('text-cyan-600'),
  indigo:  neutralAccent('text-indigo-600'),
  rose:    neutralAccent('text-rose-600'),
  red:     { card: 'border-red-500/35 bg-red-500/10 dark:border-rose-400/30 dark:bg-rose-400/5', icon: 'text-red-600 dark:text-rose-400/80' },
  zinc:    neutralAccent('text-parchment-500'),
} as const;

/**
 * TINTS map for TaskTool / TeamTools — keyed by colour name. Cards stay
 * neutral; the hue survives on the icon because a team member's colour is
 * identity, not decoration. `red` and `green` are outcomes and keep their tint.
 */
export const TINTS: Record<string, { border: string; bg: string; icon: string }> = {
  blue:   { border: '', bg: '', icon: 'text-blue-600 dark:text-blue-400/80' },
  green:  { border: 'border-green-600/30 dark:border-emerald-400/30', bg: 'bg-green-500/10 dark:bg-emerald-400/5', icon: 'text-green-600 dark:text-emerald-400/80' },
  yellow: { border: '', bg: '', icon: 'text-amber-600 dark:text-amber-400/80' },
  purple: { border: '', bg: '', icon: 'text-purple-600 dark:text-violet-400/80' },
  red:    { border: 'border-red-600/30 dark:border-rose-400/30', bg: 'bg-red-500/10 dark:bg-rose-400/5', icon: 'text-red-600 dark:text-rose-400/80' },
  cyan:   { border: '', bg: '', icon: 'text-cyan-600 dark:text-cyan-400/80' },
};
export const DEFAULT_TINT = { border: '', bg: '', icon: 'text-parchment-500 dark:text-stone-400' };

/**
 * Prose class string for markdown rendering.
 * Used by WebResultContent, PlanTool, and ProseResultContent.
 * Light mode uses Sundial parchment palette; dark mode uses stone.
 */
export const PROSE_CLASSES = `prose dark:prose-invert prose-sm max-w-none
  [&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:text-parchment-900 dark:[&_h1]:text-stone-200 [&_h1]:mt-3 [&_h1]:mb-1
  [&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:text-parchment-800 dark:[&_h2]:text-stone-300 [&_h2]:mt-2.5 [&_h2]:mb-1
  [&_h3]:text-[13px] [&_h3]:font-medium [&_h3]:text-parchment-600 dark:[&_h3]:text-stone-400 [&_h3]:mt-2 [&_h3]:mb-0.5
  [&_p]:text-[13px] [&_p]:text-parchment-600 dark:[&_p]:text-stone-400 [&_p]:leading-relaxed [&_p]:my-1
  [&_li]:text-[13px] [&_li]:text-parchment-600 dark:[&_li]:text-stone-400 [&_li]:leading-relaxed
  [&_ul]:my-1 [&_ol]:my-1
  [&_strong]:text-parchment-800 dark:[&_strong]:text-stone-300 [&_strong]:font-medium
  [&_a]:text-blue-600 dark:[&_a]:text-cyan-400 [&_a]:no-underline hover:[&_a]:text-blue-500 dark:hover:[&_a]:text-cyan-300
  [&_code]:text-[12px] [&_code]:bg-parchment-200 dark:[&_code]:bg-stone-800/50 [&_code]:px-1 [&_code]:rounded
  [&_hr]:border-parchment-300 dark:[&_hr]:border-stone-800/40 [&_hr]:my-2`;

/** Compact variant for smaller containers (collapsed groups). */
export const PROSE_CLASSES_SM = `prose dark:prose-invert prose-sm max-w-none
  [&_h1]:text-[13px] [&_h1]:font-semibold [&_h1]:text-parchment-900 dark:[&_h1]:text-stone-200 [&_h1]:mt-2 [&_h1]:mb-1
  [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-parchment-800 dark:[&_h2]:text-stone-300 [&_h2]:mt-2 [&_h2]:mb-0.5
  [&_h3]:text-[13px] [&_h3]:font-medium [&_h3]:text-parchment-600 dark:[&_h3]:text-stone-400 [&_h3]:mt-1.5 [&_h3]:mb-0.5
  [&_p]:text-[13px] [&_p]:text-parchment-600 dark:[&_p]:text-stone-400 [&_p]:leading-relaxed [&_p]:my-1
  [&_li]:text-[13px] [&_li]:text-parchment-600 dark:[&_li]:text-stone-400 [&_li]:leading-relaxed
  [&_ul]:my-1 [&_ol]:my-1
  [&_strong]:text-parchment-800 dark:[&_strong]:text-stone-300 [&_strong]:font-medium
  [&_a]:text-blue-600 dark:[&_a]:text-cyan-400 [&_a]:no-underline
  [&_code]:text-[12px] [&_code]:bg-parchment-200 dark:[&_code]:bg-stone-800/50 [&_code]:px-1 [&_code]:rounded`;
