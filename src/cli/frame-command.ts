/**
 * `lattice frame <file>` — turns an agent's frame, a 1920-wide SVG drawn like
 * a still from an explainer video, into the PNG it embeds in its reply.
 *
 * Renders with sharp (librsvg), which ships with Lattice. Every frame is set in
 * one serif: Palatino where the system has it (macOS, and Windows as Palatino
 * Linotype), otherwise TeX Gyre Pagella from data/fonts. On Linux librsvg finds
 * fonts through fontconfig, and with none installed it draws no text at all,
 * so the command points fontconfig at the bundled font before sharp loads.
 * On macOS sharp uses CoreText and ignores fontconfig; Palatino ships there.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const FRAME_USAGE = `  lattice frame <file.svg | -> [--out <file.png>]
      Render a frame (a 1920-wide SVG) to a PNG and print its path, with a
      second image showing how small it sits inline in the chat on a phone.
      Open both and look before embedding the PNG as ![what it shows](path).
`;

export const FRAME_WIDTH = 1920;
/** The smallest text that stays readable when the frame is shown inline on a phone (about 358px wide). */
export const FRAME_MIN_TEXT = 32;
const PHONE_COLUMN = 358;
const FONT_STACK = "'TeX Gyre Pagella', Palatino, 'Palatino Linotype', serif";
const DEFAULT_TEXT_SIZE = 16;

function fail(message: string): never {
  process.stderr.write(`lattice frame: ${message}\n`);
  process.exit(1);
}

/** The one <svg> element in the input: a bare SVG file, or a draft that contains one. */
export function extractFrame(text: string): string | null {
  const match = /<svg[\s>][\s\S]*<\/svg>/i.exec(text);
  return match ? match[0] : null;
}

function frameSize(svg: string): { width: number | null; height: number | null } {
  const open = /^<svg[^>]*>/i.exec(svg)?.[0] ?? '';
  const viewBox = /\sviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/i.exec(open);
  const attr = (name: string) => {
    const m = new RegExp(`\\s${name}="([\\d.]+)(px)?"`, 'i').exec(open);
    return m ? Number(m[1]) : null;
  };
  return {
    width: viewBox ? Number(viewBox[1]) : attr('width'),
    height: viewBox ? Number(viewBox[2]) : attr('height'),
  };
}

/** Font sizes of the frame's text, inherited from enclosing groups, defaulting to SVG's 16px. */
export function textSizes(svg: string): { size: number; text: string }[] {
  const found: { size: number; text: string }[] = [];
  const stack: { name: string; size: number | null }[] = [];
  const sizeOf = (attrs: string) => {
    const m = /\sfont-size="([\d.]+)(px)?"/i.exec(attrs) ?? /font-size\s*:\s*([\d.]+)(px)?/i.exec(attrs);
    return m ? Number(m[1]) : null;
  };
  const inherited = () => [...stack].reverse().find((e) => e.size !== null)?.size ?? DEFAULT_TEXT_SIZE;
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>([^<]*)/g)) {
    const [, closing, name, attrs, selfClosing, after] = m;
    if (closing) {
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    const own = sizeOf(attrs);
    if (/^(text|tspan)$/i.test(name) && after.trim()) found.push({ size: own ?? inherited(), text: after.trim() });
    if (!selfClosing) stack.push({ name, size: own });
  }
  return found;
}

/** Problems visible in the source alone. */
export function lintFrame(svg: string): string[] {
  const problems: string[] = [];
  const { width, height } = frameSize(svg);
  if (width !== FRAME_WIDTH) {
    problems.push(`It is ${width ?? 'of unknown'} wide. Draw frames ${FRAME_WIDTH} wide (viewBox="0 0 ${FRAME_WIDTH} 1080" width="${FRAME_WIDTH}" height="1080"), so the type sizes in the guidance hold.`);
  }
  if (width && height && height > width * 1.25) problems.push(`It is ${height} tall; keep a frame no taller than ${Math.round(width * 1.25)}, or split it into two frames.`);
  const small = textSizes(svg).filter((t) => t.size < FRAME_MIN_TEXT);
  if (small.length > 0) {
    const sample = small.slice(0, 3).map((t) => `"${t.text.slice(0, 40)}" at ${t.size}px`).join(', ');
    problems.push(`${small.length} line${small.length === 1 ? ' is' : 's are'} under ${FRAME_MIN_TEXT}px and will be unreadable inline on a phone: ${sample}. Make it bigger, or cut it.`);
  }
  if (/<script\b/i.test(svg)) problems.push('Remove the <script>; it does not run.');
  if (/\s(href|xlink:href)="https?:/i.test(svg)) problems.push('Nothing loads from the network; remove external links and images.');
  return problems;
}

/** Repo root: this file is src/cli/ in a checkout and dist/cli/ in a build. */
function fontDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'fonts');
}

/**
 * Point fontconfig at the bundled serif plus the system's fonts. Must run
 * before sharp loads, since fontconfig reads its configuration once.
 */
function useBundledFont(): void {
  if (process.env.FONTCONFIG_FILE) return;
  const dir = path.join(os.tmpdir(), 'lattice-fontconfig');
  fs.mkdirSync(dir, { recursive: true });
  const conf = path.join(dir, 'fonts.conf');
  fs.writeFileSync(conf, [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
    '<fontconfig>',
    `  <dir>${fontDir()}</dir>`,
    '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>',
    `  <cachedir>${path.join(dir, 'cache')}</cachedir>`,
    '</fontconfig>',
    '',
  ].join('\n'));
  process.env.FONTCONFIG_FILE = conf;
}

/** The frame with the house serif applied to all of its text. */
function styled(svg: string): string {
  return svg.replace(/^<svg([^>]*)>/i, (_m, attrs: string) => {
    const ns = /\sxmlns=/i.test(attrs) ? '' : ' xmlns="http://www.w3.org/2000/svg"';
    return `<svg${ns}${attrs}><style>text, tspan { font-family: ${FONT_STACK}; }</style>`;
  });
}

export async function renderFrame(svg: string, out: string): Promise<{ png: string; phone: string }> {
  useBundledFont();
  const { default: sharp } = await import('sharp');
  const { width } = frameSize(svg);
  const scale = FRAME_WIDTH / (width ?? FRAME_WIDTH);
  await sharp(Buffer.from(styled(svg)), { density: 72 * scale }).png().toFile(out);
  const phone = out.replace(/\.png$/i, '') + '-phone.png';
  await sharp(out).resize({ width: PHONE_COLUMN * 2 }).png().toFile(phone);
  return { png: out, phone };
}

export async function runFrameCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(`Usage:\n${FRAME_USAGE}`);
    return;
  }
  let target: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else if (!target) target = args[i];
    else fail(`unexpected argument "${args[i]}".\n\nUsage:\n${FRAME_USAGE}`);
  }
  if (!target) fail(`give one file, or - for stdin.\n\nUsage:\n${FRAME_USAGE}`);
  if (out !== undefined && !out.toLowerCase().endsWith('.png')) fail('--out must name a .png file.');

  let text: string;
  try {
    text = target === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(target, 'utf8');
  } catch (error) {
    fail(`could not read ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const svg = extractFrame(text);
  if (!svg) fail('no <svg> element in the input.');

  const base = target === '-' ? 'frame' : path.basename(target).replace(/\.[^.]+$/, '');
  const png = path.resolve(out ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-frame-')), `${base}.png`));
  const problems = lintFrame(svg);
  let rendered: { png: string; phone: string } | null = null;
  try {
    rendered = await renderFrame(svg, png);
  } catch (error) {
    problems.push(`It did not render: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines: string[] = [];
  if (rendered) {
    lines.push(`Frame:        ${rendered.png}`, `Phone inline: ${rendered.phone} (how small it sits in the chat on a phone)`);
  }
  for (const problem of problems) lines.push(`  problem: ${problem}`);
  lines.push(
    '',
    'Open both images and look as a reader would: text running past a box or the frame edge, labels colliding,',
    'arrows that miss their box, anything cramped or busier than it needs to be, and on the phone image, anything',
    'you cannot read. Fix what you see and render again. Embed the frame by its path: ![what it shows](path).',
  );
  process.stdout.write(lines.join('\n') + '\n');
  if (!rendered) process.exitCode = 1;
}
