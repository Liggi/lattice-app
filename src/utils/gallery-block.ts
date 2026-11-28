import { parseJson } from './json.js';

/**
 * The ```lattice-gallery fence an agent writes to show screenshots as a series
 * with its own notes on them. The body is JSON:
 *
 *   { "images": [ { "path": "/tmp/a.png", "size": [2880, 4046], "caption": "Step 4: …",
 *                   "notes": [ { "text": "…", "box": [x, y, width, height] }, { "text": "about the whole page" } ] } ] }
 *
 * A box is in the pixels of `size` when it is given, otherwise of the image file itself.
 */

/** One agent note: its text, and the box it is about in `basis` pixels, or none for the whole image. */
export interface AgentImageNote {
  text: string;
  box?: { x: number; y: number; w: number; h: number };
}

export interface GalleryImage {
  path: string;
  caption: string;
  /** The pixel size the agent measured boxes in, when it said. */
  size?: { w: number; h: number };
  notes: AgentImageNote[];
}

export type ParsedGallery = { ok: true; images: GalleryImage[] } | { ok: false; error: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readBox(raw: unknown, where: string): AgentImageNote['box'] {
  if (raw === undefined || raw === null) return undefined;
  const v = Array.isArray(raw) ? raw : null;
  if (!v || v.length !== 4 || !v.every(isNum) || v[2] <= 0 || v[3] <= 0) {
    throw new Error(`${where}: "box" must be [x, y, width, height] in pixels`);
  }
  return { x: v[0], y: v[1], w: v[2], h: v[3] };
}

/** Reads a gallery fence's body. Anything malformed is reported, never half-shown. */
export function parseGalleryBlock(source: string): ParsedGallery {
  let data: unknown;
  try {
    data = parseJson(source);
  } catch (error) {
    return { ok: false, error: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const list = Array.isArray(data) ? data : (data as { images?: unknown })?.images;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'expected { "images": [ … ] } with at least one image' };
  try {
    const images = list.map((raw, i): GalleryImage => {
      const where = `image ${i + 1}`;
      const img = raw as Record<string, unknown>;
      if (!img || typeof img.path !== 'string' || !img.path) throw new Error(`${where}: "path" is missing`);
      let size: GalleryImage['size'];
      if (img.size !== undefined) {
        const s = img.size;
        if (!Array.isArray(s) || s.length !== 2 || !s.every(isNum) || s[0] <= 0 || s[1] <= 0) {
          throw new Error(`${where}: "size" must be [width, height] in pixels`);
        }
        size = { w: s[0], h: s[1] };
      }
      const notes = (Array.isArray(img.notes) ? img.notes : []).map((n, j): AgentImageNote => {
        const note = n as Record<string, unknown>;
        const text = typeof n === 'string' ? n : note?.text;
        if (typeof text !== 'string' || !text.trim()) throw new Error(`${where}, note ${j + 1}: "text" is missing`);
        const box = typeof n === 'string' ? undefined : readBox(note.box, `${where}, note ${j + 1}`);
        return box ? { text, box } : { text };
      });
      return { path: img.path, caption: typeof img.caption === 'string' ? img.caption : '', ...(size ? { size } : {}), notes };
    });
    return { ok: true, images };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A note's box as fractions of the image, given the file's real size. Boxes measured
 * against a stated size are scaled to the file, so a box taken at 1× on a 2× screenshot
 * still lands. The result is clamped to the image; null when it falls wholly outside.
 */
export function noteBoxFraction(
  box: NonNullable<AgentImageNote['box']>,
  natural: { w: number; h: number },
  stated?: { w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
  const basis = stated ?? natural;
  const x0 = Math.max(0, box.x / basis.w);
  const y0 = Math.max(0, box.y / basis.h);
  const x1 = Math.min(1, (box.x + box.w) / basis.w);
  const y1 = Math.min(1, (box.y + box.h) / basis.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
