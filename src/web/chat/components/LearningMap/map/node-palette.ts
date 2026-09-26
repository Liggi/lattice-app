/**
 * Node tints for the learning map.
 *
 * This is the one place in the app that still carries several hues at once:
 * on a map canvas the hue *is* the node's kind, so dropping it would lose
 * information rather than just chrome. Everything else about the restart's
 * vocabulary applies — no glow, no shadow, no gradient, and the selected node
 * is marked with the single cyan accent like any other selected thing.
 *
 * The recipe per kind:
 *
 *   - an inline `background` at 10% of the hue and a `1px solid` `border` at
 *     20% of the same hue, so a node reads as a tinted pane of the canvas
 *     rather than a coloured object;
 *   - a small sentence-case type word above the title, in the hue's Tailwind
 *     `-400` shade at 80%;
 *   - a neutral surface step on hover;
 *   - an accent ring when selected.
 *
 * `code-structure` is the neutral kind, so it takes the app's own stone
 * neutral rather than a competing cool grey.
 *
 * Every class here is a whole literal string. Tailwind scans source text, so a
 * hue interpolated into a class name at runtime would never be generated.
 */

import type { KmNodeType } from '../../../services/api/km-api';

export interface NodeTint {
  /** `r, g, b` — the channel triple, so opacities compose in one place. */
  rgb: string;
  /** Sentence-case type word shown above the title. */
  label: string;
  /** Inline fill/border pair. */
  surface: { background: string; border: string };
  /** Colour of the type word. */
  labelClass: string;
  /** Hover fill. */
  hoverClass: string;
  /** Ring while selected. */
  selectedClass: string;
  /** Box width: the original's 350px pane. */
  widthClass: string;
}

/** Selection is interactive state, so it is the accent — the same everywhere. */
const SELECTED = 'ring-2 ring-accent';

const HOVER = 'hover:bg-surface-2';

const WIDE = 'min-w-[350px] max-w-[350px]';

export const NODE_TINTS: Record<KmNodeType, NodeTint> = {
  article: {
    rgb: '52, 211, 153',
    label: 'Article',
    surface: {
      background: 'rgba(52, 211, 153, 0.1)',
      border: '1px solid rgba(52, 211, 153, 0.2)',
    },
    labelClass: 'text-emerald-400/80',
    hoverClass: HOVER,
    selectedClass: SELECTED,
    widthClass: WIDE,
  },
  concept: {
    rgb: '167, 139, 250',
    label: 'Concept',
    surface: {
      background: 'rgba(167, 139, 250, 0.1)',
      border: '1px solid rgba(167, 139, 250, 0.2)',
    },
    labelClass: 'text-violet-400/80',
    hoverClass: HOVER,
    selectedClass: SELECTED,
    widthClass: WIDE,
  },
  entity: {
    rgb: '244, 114, 182',
    label: 'Entity',
    surface: {
      background: 'rgba(244, 114, 182, 0.1)',
      border: '1px solid rgba(244, 114, 182, 0.2)',
    },
    labelClass: 'text-pink-400/80',
    hoverClass: HOVER,
    selectedClass: SELECTED,
    widthClass: WIDE,
  },
  'code-structure': {
    rgb: '168, 162, 158',
    label: 'Code',
    surface: {
      background: 'rgba(168, 162, 158, 0.1)',
      border: '1px solid rgba(168, 162, 158, 0.2)',
    },
    labelClass: 'text-fg-2',
    hoverClass: HOVER,
    selectedClass: SELECTED,
    widthClass: WIDE,
  },
  'architecture-item': {
    rgb: '163, 230, 53',
    label: 'Architecture',
    surface: {
      background: 'rgba(163, 230, 53, 0.1)',
      border: '1px solid rgba(163, 230, 53, 0.2)',
    },
    labelClass: 'text-lime-400/80',
    hoverClass: HOVER,
    selectedClass: SELECTED,
    widthClass: WIDE,
  },
};

/** Unknown types keep the recipe but stay neutral, and say so on the label. */
const FALLBACK_TINT: NodeTint = { ...NODE_TINTS['code-structure'], label: 'Node' };

/** Unknown node types are possible: the API stores node_type as free text. */
export function tintFor(nodeType: string): NodeTint {
  return NODE_TINTS[nodeType as KmNodeType] ?? FALLBACK_TINT;
}
