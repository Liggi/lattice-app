/**
 * The look of an agent's ```diagram fence, shared by the chat renderer
 * (DiagramBlock) and `lattice diagram check`, so the picture an agent checks
 * is drawn with the same rules the user will see. Colours are literal rather
 * than CSS variables because the check renders with librsvg (through sharp),
 * which does not resolve var().
 */

/** Width of the message column a diagram is drawn into, in CSS pixels; a wide layout is drawn to the desktop one. */
export const DIAGRAM_COLUMN = { desktop: 600, phone: 358 } as const;

/** Below this scale a drawing is too small to read, so the chat offers it at full size. */
export const DIAGRAM_EXPAND_BELOW = 0.75;

const SANS = "Geist, system-ui, -apple-system, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const DIAGRAM_CSS = `
text { fill: #e7e5e4; font-family: ${SANS}; font-size: 13px; }
text.sub, tspan.sub { fill: #a8a29e; font-size: 12px; }
text.faint, tspan.faint { fill: #78716c; font-size: 12px; }
text.label, tspan.label { fill: #78716c; font-size: 10px; letter-spacing: .08em; font-weight: 500; }
text.strong, tspan.strong { font-weight: 600; }
text.mono, tspan.mono { font-family: ${MONO}; font-size: 11.5px; }
text.on, tspan.on { fill: #22d3ee; }
text.warn, tspan.warn { fill: #f59e0b; }
.box { fill: none; stroke: rgba(255,255,255,.16); stroke-width: 1; }
.box.fill { fill: rgba(255,255,255,.035); }
.box.on { stroke: rgba(34,211,238,.6); fill: rgba(34,211,238,.06); }
.area { fill: rgba(255,255,255,.02); stroke: rgba(255,255,255,.07); stroke-width: 1; }
.ghost { fill: none; stroke: rgba(255,255,255,.16); stroke-width: 1; stroke-dasharray: 3 3; }
.line { fill: none; stroke: #78716c; stroke-width: 1; }
.line.on { stroke: #22d3ee; }
.rule { fill: none; stroke: rgba(255,255,255,.08); stroke-width: 1; }
.off { opacity: .42; }
`;

const arrowhead = (id: string, colour: string) =>
  `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
  `<path d="M0.5 0.8 L7 4 L0.5 7.2" fill="none" stroke="${colour}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></marker>`;

/** Arrowheads every diagram can use: marker-end="url(#arrow)", or url(#arrow-on) for the accent. */
export const DIAGRAM_MARKERS = `<defs>${arrowhead('arrow', '#78716c')}${arrowhead('arrow-on', '#22d3ee')}</defs>`;

/**
 * A fence's drawing: the phone layout, and optionally a wider layout the chat
 * shows instead when the column is at least as wide as it.
 */
export interface DiagramLayouts {
  narrow: string;
  wide: string | null;
}

/**
 * The fence's layouts, when it holds one complete <svg>, or two with nothing
 * but whitespace between them, the wider of which is the wide layout; null
 * otherwise. The chat and the check both draw exactly what this accepts.
 */
export function diagramLayouts(source: string): DiagramLayouts | null {
  const svgs = topLevelSvgs(source.trim());
  if (!svgs || svgs.length > 2) return null;
  if (svgs.length === 1) return { narrow: svgs[0], wide: null };
  const [a, b] = svgs.map((svg) => naturalWidth(svg) ?? 0);
  if (a === b) return null;
  return a < b ? { narrow: svgs[0], wide: svgs[1] } : { narrow: svgs[1], wide: svgs[0] };
}

/** The <svg> elements a source is made of, or null when anything else is outside them or one is unclosed. */
function topLevelSvgs(source: string): string[] | null {
  const svgs: string[] = [];
  let depth = 0;
  let start = 0;
  let end = 0;
  for (const m of source.matchAll(/<(\/?)svg(?=[\s>/])[^>]*>/gi)) {
    const at = m.index ?? 0;
    if (m[1]) {
      if (depth === 0) return null;
      depth -= 1;
      if (depth === 0) {
        end = at + m[0].length;
        svgs.push(source.slice(start, end));
      }
    } else if (!m[0].endsWith('/>')) {
      if (depth === 0) {
        if (source.slice(end, at).trim()) return null;
        start = at;
      }
      depth += 1;
    }
  }
  return depth === 0 && svgs.length > 0 && !source.slice(end).trim() ? svgs : null;
}

/** The drawing's own width, from its width attribute or else its viewBox. */
export function naturalWidth(svg: string): number | null {
  const open = /^<svg[^>]*>/i.exec(svg)?.[0] ?? '';
  const width = /\swidth="([\d.]+)(px)?"/i.exec(open);
  if (width) return Number(width[1]);
  const viewBox = /\sviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/i.exec(open);
  return viewBox ? Number(viewBox[1]) : null;
}
