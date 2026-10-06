/**
 * How an agent draws a diagram in a Lattice reply: when to draw at all, the
 * SVG vocabulary the chat styles (src/utils/diagram-style.ts), and the look
 * step. Written from a trial on real replies (thread 26398): drafts drawn 340
 * wide read well on a phone and on desktop, and a look at the rendered image
 * caught the one real defect, a shape left with SVG's default black fill. The
 * optional wide layout fills the desktop column (thread 31548).
 */
export function diagramGuidance(cli: string): string[] {
  return [
    'Diagrams',
    '- Draw a diagram only when position carries meaning: parts of a system and what flows between them, a map, what',
    '  lives inside what, a rough sketch of a screen, a branching decision. Steps, timelines, comparisons and yes/no',
    '  grids are markdown lists and tables, which the chat already renders well. Never draw ASCII-art diagrams.',
    '- A diagram is an inline SVG in a fenced block with the language `diagram`, and nothing else in the fence. The chat',
    '  draws it in a sandbox: no scripts, nothing loaded from the network. Keep the explanation in your prose.',
    '  ```diagram',
    '  <svg viewBox="0 0 340 60" width="340">',
    '    <rect class="box" x="1" y="8" width="130" height="44" rx="6"/><text x="13" y="28">Phone app</text>',
    '    <text x="13" y="44" class="sub">sends the message</text>',
    '    <path class="line" d="M131 30 H200" marker-end="url(#arrow)"/>',
    '    <rect class="box on" x="200" y="8" width="130" height="44" rx="6"/><text x="212" y="35">Backend</text>',
    '  </svg>',
    '  ```',
    '- Size: always draw 340 wide (`viewBox="0 0 340 H" width="340"`), as tall as it needs. That is the phone column.',
    '  Things side by side on a whiteboard go one above the other here unless both fit in 340. When that stacking',
    '  hides the point (parts that sit side by side, flows that run across), also draw a wide layout 600 wide',
    '  (`viewBox="0 0 600 H" width="600"`) and put it in the same fence after the 340 one. Desktop shows the wide one,',
    '  phones the 340 one. Keep both saying the same thing; most diagrams need only the 340 one.',
    '- SVG does not wrap text, so you must. 13px text (the default) averages 7px a character, `.sub` and `.faint` 6.5px,',
    '  `.label` capitals 7px. Work out each line\'s width, keep 12px padding inside a box, and break a long line into two',
    '  `<text>` lines 16px apart, or shorten it. Text never crosses a box edge or another element.',
    '- Text classes: default (primary), `.sub` (secondary, 12px), `.faint` (quiet notes), `.label` (small caption for a',
    '  region; write it in capitals), `.strong`, `.mono` (paths, ids, commands), `.on` (accent), `.warn` (amber).',
    '- Shape classes: `.box` (outline; use rx="6"), `.box.fill` (faint fill), `.box.on` (the one highlighted thing),',
    '  `.area` (a quiet region holding other things, with a `.label` inside its top-left), `.ghost` (dashed: planned,',
    '  optional, not built), `.line` (connector; add marker-end="url(#arrow)" for an arrowhead, `.line.on` with',
    '  url(#arrow-on) for the highlighted path), `.rule` (hairline divider), `.off` (fades a group). Give every shape a',
    '  class: a shape with no class and no fill renders solid black. Use no colours of your own.',
    '- Keep it quiet. Know the one sentence the diagram must get across and draw only what supports it. Hierarchy comes',
    '  from position, grouping, whitespace and weight, not colour or boxes; not everything needs a box, and boxes nest',
    '  two levels at most. One accent at most. Amber only for what needs the user\'s attention, never for missing or not',
    '  built (that is `.ghost` or `.faint`). Never: dots as status markers, coloured bars on an edge, pill-shaped tags,',
    '  shadows, gradients, icons, emoji, legends, rotated or italic text, strokes over 1.5.',
    '- Arrows run straight or with right-angle bends (H and V path commands), start and end on a box edge, and never',
    '  cross text. Label one only when the relationship is not obvious, with a few `.faint` words beside it. Align',
    '  things on a grid: shared left edges, equal gaps (16 or 24), equal heights in a row.',
    `- Before you send any reply that contains a diagram, look at it: write the reply (or just the SVG) to a file, run`,
    `  \`${cli} diagram check <file>\`, and open both images it prints. You cannot judge coordinates from the source, so`,
    '  do this every time, once per diagram. Look as a reader would: text overflowing or clipped, labels colliding,',
    '  arrows missing their box or crossing text, anything cramped, too small or busier than it needs to be. Fix what',
    '  you see and check again; send once it reads well.',
  ];
}
