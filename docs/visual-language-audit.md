# Lattice visual language audit

Audited 2026-07-11 against the running product, `lattice-design-reference`,
the current CSS foundations, and representative composed surfaces.

## Job of this document

Preserve the visual identity Lattice already has, name the roles its UI needs,
and identify the smallest component foundation that can make new work
consistent. This is not a redesign and not a proposal to migrate the whole app
at once.

## Executive finding

Lattice already has a strong visual language. It is implemented repeatedly at
the composition layer instead of encoded in reliable primitives.

The canonical language is the rendered product:

- warm charcoal, dark-only base surfaces;
- cyan interactive chrome and live-state energy;
- crisp hairline borders and small radii;
- dense, uppercase technical labels;
- semantic accent colors used with restraint;
- generative session art, scanline grids, and glow for identity and state;
- Geist for readable prose and Geist Mono for technical chrome and data.

The main problem is not missing taste. It is that stock shadcn primitives,
duplicated token layers, global CSS helper classes, and one-off Tailwind strings
describe different products.

## Evidence

### The implementation favors the bespoke language

Within `src/web/chat`:

- 180 raw `<button>` elements exist, versus 6 uses of the shared `<Button>`.
- The stock `ui/button.tsx` is imported by one component.
- `rounded-sm` appears 224 times, versus 14 `rounded-md`, 36 `rounded-lg`, and
  one `rounded-xl`.
- `font-display` (currently Orbitron) appears 200 times and `font-mono` 172
  times. The frequency makes Orbitron's sci-fi character cumulative rather
  than occasional.
- Menus are split between Radix-backed popovers/commands and bespoke absolute
  panels with hand-written dismissal behavior.

This is a useful signal: the composed product has converged on a recognizable
language even though the nominal primitive layer has not.

### There are two conflicting foundations

`src/web/styles/index.css` exposes a generic amber-primary shadcn theme with a
6px base radius. `src/web/chat/styles/theme.css` separately defines the actual
warm-charcoal surfaces, cyan chrome colors, a second radius scale, typography,
spacing, and composer tokens.

The rendered app overwhelmingly treats cyan as the default interactive color.
Amber is a caution/highlight color. Therefore the current `--primary` token is
not product truth.

### High-signal references

The best current references are:

- `lattice-design-reference/motif-spec.md` and its screenshots;
- `shared/SessionCard.tsx` for identity, state, tags, and density;
- `ConversationHeader/` for action chrome and semantic colors;
- `Composer/` for live/ready/caution/danger states;
- `SettingsDialog/` for dialog, tabs, inputs, and footer hierarchy;
- the revised cross-session sidebar for compact action/filter hierarchy.

The stock files under `components/ui/` are useful behavioral substrates, but
they are not visual references.

## What should remain load-bearing

### Warm base, cool chrome

The two-layer palette is the clearest invariant:

- Warm stone/charcoal surfaces stay recessive.
- Cyan means interactive, focused, active, or alive.
- Emerald means successful or complete.
- Amber means caution, attention, or exceptional highlight.
- Rose means destructive, failed, or dangerous.
- Violet should denote a specific product concept, not generic decoration.

Color must communicate a role. A toolbar should not become a rainbow merely
because variants are available.

### Hairlines carry structure

Lattice should continue to use thin, low-opacity borders and nested surfaces
instead of large spacing and soft shadows. Elevation is expressed with a darker
surface, stronger border, and occasionally a restrained cyan glow.

### Crisp geometry

Small radii are canonical for controls, menus, cards, and panels. Larger radii
should be reserved for content containers where a softer reading surface is
useful. Fully rounded pills should not become a general shape language.

### Dense technical voice

Chrome labels remain terse, uppercase, and tracked. Icons are thin-stroke
Lucide icons. Relative time stays compact. Magic/sparkle iconography is not part
of the product voice.

### Signature identity motifs

Generative session art, the lattice/scanline grid, cyan particles, and live
glow are identity elements rather than decorative options. They should remain
bespoke and should not be generalized into every component.

## Typography system

The current sources disagree between “monospace-first” and an earlier decision
that pervasive technical fonts flatten prose, code, and chrome into one level.
The rendered product benefits from three explicit roles:

| Role | Face | Use |
| --- | --- | --- |
| Chrome | Geist Mono (`font-mono`) | buttons, tabs, compact section labels, status chrome |
| Reading | Geist (`font-sans`) | conversation prose, explanations, descriptions, longer settings copy |
| Data | Geist Mono (`font-mono`) | code, paths, IDs, input values, logs, counters, machine keys |
| Brand accent | Orbitron (`font-display`) | optional wordmark-only use while evaluated |

Rules:

- Uppercase and tracking belong to chrome, not body copy.
- A button label uses Geist Mono even when its description uses Geist.
- Routine chrome uses medium weight. Reserve semibold for major page-level
  headings; do not rely on bold labels to create hierarchy.
- Input values are mono only when the value is technical; ordinary prose
  inputs use Geist.
- Orbitron should not be used for general controls or paragraphs. Its current
  breadth pushes the product from technical instrument toward fictional HUD.
- Do not immediately replace Orbitron with another stylized technology font.
  First evaluate whether Geist Mono plus the existing geometry, tracking,
  color, and grid motifs carry enough identity.
- GeistPixelCircle is not part of the default hierarchy. It may remain a rare
  brand texture if there is a concrete use for it.

### Preferred small-chrome candidate

Confirmed 2026-07-12 after comparing four regimes on MacBook and phone:

- Geist Mono;
- 11px minimum for routine chrome;
- medium (500) weight;
- `0.07em` tracking;
- approximately 78% opacity minimum for secondary labels;
- 12px for important or text-heavy actions;
- 10px only for low-priority metadata; avoid 9px for working controls.

This is the **Mono Readable** option from the living specimen at
`/lab/visual-language`. It preserves the technical texture while remaining
legible on lower-density displays. It is not yet a global production baseline:
a partial sidebar migration showed that it clashes when routine chrome changes
but adjacent group headers and session cards retain Orbitron. The next
comparison must apply typography coherently to the whole sidebar surface.

## Component taxonomy

### 1. ActionButton

One semantic component with two independent axes:

- emphasis: `solid`, `outline`, `ghost`;
- tone: `cyan`, `neutral`, `emerald`, `amber`, `rose`, `violet`.

And three density sizes: `compact`, `default`, `icon`.

The common case is cyan outline. Solid cyan is reserved for the primary action
inside a bounded decision surface such as a dialog. Ghost is for tertiary or
frequent toolbar actions. Rose is destructive. Other tones require semantic
justification.

All variants must encode hover, active, focus-visible, disabled, and loading
states. The signature offset/glow hover can remain on outline actions, but it
should not move dense menu items or every tiny icon button.

### 2. IconButton

An icon-only action with a required accessible label and tooltip where the
meaning is not universal. It shares tone and state rules with ActionButton but
has a fixed square hit target.

### 3. StatusTag

Non-interactive metadata: provider, work type, phase, difficulty, runtime
state. Small, uppercase, outlined by default. Filled tags are reserved for
exceptional emphasis such as caution.

This must not accept click handlers. Interactive controls that currently look
like tags should instead use ToggleButton or Tab.

### 4. ToggleButton and Tab

Interactive selection controls. They need selected, unselected, focus, and
disabled states that are visually distinct from StatusTag. Tabs express view
navigation; toggles express a setting or filter.

### 5. Menu

A shared behavioral primitive built on Radix positioning/focus management and
styled as Lattice chrome:

- warm elevated surface;
- hairline border;
- small radius;
- compact rows;
- Geist Mono label with optional Geist description;
- cyan hover/selected state;
- optional leading icon and trailing shortcut/value;
- click-outside, Escape, focus return, collision handling, and portal behavior
  supplied by the primitive rather than reimplemented by each caller.

`MenuItem`, `MenuLabel`, `MenuSeparator`, and `MenuRadioGroup` are sufficient
for the visible menu vocabulary. Searchable model/directory pickers can compose
the same surface with `Command` behavior.

### 6. Field

`TextField`, `TextArea`, and `SelectTrigger` share the same surface, border,
focus, disabled, invalid, and label rules. Labels are chrome; descriptions and
errors are readable Geist; technical values use Geist Mono.

### 7. Surface primitives

- `Toolbar`: horizontal action grouping and separators.
- `PanelHeader`: title, optional status, and actions.
- `DialogSurface`: overlay, panel, title, body, and footer hierarchy.

These should be layout primitives, not product-specific mega-components.

## Contradictions to remove over time

1. Amber `--primary` versus cyan product behavior.
2. Two token files defining overlapping colors, radii, spacing, and fonts.
3. Stock `Button` defaults (`rounded-md`, sentence-case, 40px height) versus
   compact Lattice controls.
4. Raw buttons, `.ui-action-btn`, `SessionReview.ActionButton`, and bespoke
   toolbar buttons implementing near-identical variants independently.
5. Bespoke absolute menus duplicating behavior already available through
   Radix.
6. Status pills and interactive filters sharing the same visual treatment.
7. Orbitron, Geist Mono, and Geist selected ad hoc rather than by content role;
   Orbitron in particular is over-applied to routine chrome.
8. Glow/offset hover applied inconsistently, including places where movement
   adds noise.

## Smallest useful first extraction

Do not begin by rewriting tokens or migrating the whole app. Begin with the
visible action/menu cluster that already has a coherent reference:

1. Create Lattice-styled `ActionButton` and `IconButton` primitives, using CVA
   for explicit emphasis, tone, and size variants.
2. Create a Radix-backed `Menu` surface and items.
3. Add a development-only visual-language specimen page showing every state.
4. Migrate the revised cross-session sidebar and the conversation-header
   controls to these primitives.
5. Compare live screenshots at desktop and compact widths before expanding the
   migration.

This slice proves the taxonomy on both a quiet sidebar and the densest toolbar.
It also removes the most obvious duplicated button/menu code without touching
session cards, messages, composer behavior, or dialog internals.


## Migration principles

- Reference renders are the spec; preserve copy, density, state, and behavior.
- Migrate by surface, not by global search-and-replace.
- Separate visual equivalence from behavior changes.
- Add regression checks for keyboard behavior and the most important visible
  states.
- Delete an old helper only after all of its consumers move.
- Do not expose every color as an invitation to decorate. Require semantic
  tones at call sites.
- Keep bespoke identity components bespoke.

## Success criteria

The foundation is working when:

- a new control can be built without copying a long Tailwind string;
- buttons of the same role look and behave the same across surfaces;
- status metadata cannot be mistaken for an interactive control;
- menus share keyboard, focus, positioning, and visual behavior;
- font choice follows content role;
- the rendered product retains its current character;
- migration reduces variants and code rather than creating a parallel third
  design system.
