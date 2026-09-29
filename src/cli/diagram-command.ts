/**
 * `lattice diagram check <file>` — the look step for an agent's diagram.
 *
 * The agent cannot see what its SVG coordinates produce. This renders each
 * diagram at the width the chat shows it on desktop and on a phone, with the
 * same stylesheet the chat uses, and prints the image paths for the agent to
 * open before it sends the reply. It renders with sharp (librsvg), which ships
 * with Lattice, so no browser is needed.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { DIAGRAM_COLUMN, DIAGRAM_CSS, DIAGRAM_EXPAND_BELOW, DIAGRAM_MARKERS, completeSvg, naturalWidth } from '../utils/diagram-style.js';

export const DIAGRAM_USAGE = `  lattice diagram check <file | ->
      Render the diagrams in a file (a reply draft containing \`\`\`diagram
      fences, or a bare <svg>) as the chat shows them on desktop and on a
      phone, and print the image paths. Open both images and look before
      sending the reply.
`;

const PAD = 16;
const SCALE = 2;
const BACKGROUND = '#1c1917';

function fail(message: string): never {
  process.stderr.write(`lattice diagram: ${message}\n`);
  process.exit(1);
}

/** The diagrams in a reply draft, or the file itself when it is one bare SVG. */
export function extractDiagrams(text: string): string[] {
  const fences = [...text.matchAll(/```diagram[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return fences.length > 0 ? fences : /^\s*<svg[\s>]/i.test(text) ? [text] : [];
}

/**
 * Problems visible in the source alone. A shape with neither a class nor a
 * fill renders solid black (SVG's default fill), which a first draft did in
 * the trial; the rest keep a drawing inside what the chat can show.
 */
export function lintDiagram(svg: string): string[] {
  const problems: string[] = [];
  const width = naturalWidth(svg);
  if (!/\sviewBox=/i.test(/^<svg[^>]*>/i.exec(svg)?.[0] ?? '')) problems.push('The <svg> has no viewBox, so it cannot scale to the column.');
  if (width && width > DIAGRAM_COLUMN.phone / DIAGRAM_EXPAND_BELOW && width <= 680) {
    problems.push(`It is ${width} wide: on a phone it shrinks below ${Math.round(DIAGRAM_EXPAND_BELOW * 100)}% and the reader has to open it full size. Draw 340 wide unless the width carries the point.`);
  }
  if (width && width > 680) problems.push(`It is ${width} wide; the most the guidance allows is 680.`);
  for (const shape of unfilledShapes(svg)) {
    problems.push(`A <${shape.split(/[\s>/]/)[0].slice(1)}> has no class and no fill, so it renders solid black: ${shape.slice(0, 90)}`);
  }
  if (/<script\b/i.test(svg)) problems.push('Scripts do not run in the chat; remove the <script>.');
  if (/\s(href|xlink:href)="https?:/i.test(svg)) problems.push('Nothing loads from the network in the chat; remove external links and images.');
  return problems;
}

/**
 * Shapes that end up with SVG's default black fill: no class or fill of their
 * own and none inherited from an enclosing group. Anything inside <defs> or a
 * <marker> is skipped, since it is drawn where it is used.
 */
function unfilledShapes(svg: string): string[] {
  const found: string[] = [];
  const stack: { name: string; fills: boolean }[] = [];
  const givesFill = (attrs: string) => /\s(class|fill)=/i.test(attrs) || /fill\s*:/i.test(attrs);
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [tag, closing, name, attrs, selfClosing] = m;
    if (closing) {
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    const inherited = stack.some((e) => e.fills);
    if (/^(rect|circle|ellipse|polygon|path)$/i.test(name) && !inherited && !givesFill(attrs)) found.push(tag);
    if (!selfClosing) stack.push({ name, fills: /^(defs|marker|symbol|pattern|clipPath|mask)$/i.test(name) || givesFill(attrs) });
  }
  return found;
}

/** The SVG as the chat draws it: shared stylesheet and arrowheads added. */
function styled(svg: string): string {
  return svg.replace(/^<svg([^>]*)>/i, (_m, attrs: string) => {
    const ns = /\sxmlns=/i.test(attrs) ? '' : ' xmlns="http://www.w3.org/2000/svg"';
    return `<svg${ns}${attrs}><style>${DIAGRAM_CSS}</style>${DIAGRAM_MARKERS}`;
  });
}

async function renderAt(svg: string, columnWidth: number, file: string): Promise<number> {
  const { default: sharp } = await import('sharp');
  const natural = naturalWidth(svg) ?? columnWidth;
  const shown = Math.min(natural, columnWidth);
  const drawing = await sharp(Buffer.from(styled(svg)), { density: 72 * SCALE * (shown / natural) })
    .png()
    .toBuffer();
  const meta = await sharp(drawing).metadata();
  const width = (columnWidth + PAD * 2) * SCALE;
  const height = (meta.height ?? 0) + PAD * 2 * SCALE;
  await sharp({ create: { width, height, channels: 4, background: BACKGROUND } })
    .composite([{ input: drawing, left: PAD * SCALE, top: PAD * SCALE }])
    .png()
    .toFile(file);
  return shown / natural;
}

export async function runDiagramCommand(args: string[]): Promise<void> {
  const [verb, target, ...rest] = args;
  if (!verb || verb === '-h' || verb === '--help') {
    process.stdout.write(`Usage:\n${DIAGRAM_USAGE}`);
    return;
  }
  if (verb !== 'check') fail(`unknown verb "${verb}".\n\nUsage:\n${DIAGRAM_USAGE}`);
  if (!target || rest.length > 0) fail(`give one file, or - for stdin.\n\nUsage:\n${DIAGRAM_USAGE}`);

  let text: string;
  try {
    text = target === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(target, 'utf8');
  } catch (error) {
    fail(`could not read ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const diagrams = extractDiagrams(text);
  if (diagrams.length === 0) fail('no ```diagram fence and no bare <svg> in the input.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-diagram-'));
  const lines: string[] = [];
  let problemsFound = false;
  for (const [index, source] of diagrams.entries()) {
    const label = diagrams.length > 1 ? `Diagram ${index + 1}` : 'Diagram';
    const svg = completeSvg(source);
    if (!svg) {
      problemsFound = true;
      lines.push(`${label}: not drawn. The fence must hold a single <svg>…</svg> element and nothing else; the chat would show its source instead.`);
      continue;
    }
    const problems = lintDiagram(svg);
    try {
      const desktop = path.join(dir, `diagram-${index + 1}-desktop.png`);
      const phone = path.join(dir, `diagram-${index + 1}-phone.png`);
      await renderAt(svg, DIAGRAM_COLUMN.desktop, desktop);
      const phoneScale = await renderAt(svg, DIAGRAM_COLUMN.phone, phone);
      lines.push(`${label}:`, `  desktop: ${desktop}`, `  phone:   ${phone}${phoneScale < 1 ? ` (shown at ${Math.round(phoneScale * 100)}%)` : ''}`);
    } catch (error) {
      problems.push(`It did not render: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (problems.length > 0) problemsFound = true;
    for (const problem of problems) lines.push(`  problem: ${problem}`);
  }
  lines.push(
    '',
    'Open both images and look as a reader would: text overflowing or clipped, labels colliding, arrows that miss',
    'their box or cross text, anything cramped, too small, or busier than it needs to be. Fix what you see and',
    problemsFound ? 'check again before sending.' : 'send the reply once it reads well.',
  );
  process.stdout.write(lines.join('\n') + '\n');
}
