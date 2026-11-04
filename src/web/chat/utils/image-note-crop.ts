import type { ImageBox, PendingAnnotation } from './annotations-format';

/** Context kept around a box, in the image's own pixels, so the agent sees what surrounds it. */
const MARGIN = 120;
const MIN_WIDTH = 1400;
const MIN_HEIGHT = 900;
/** Longest side sent; the model scales anything larger down to about this anyway. */
const MAX_SIDE = 1568;

export interface MarkedCrop {
  /** Base64 PNG of the area around the box, with the box drawn on it. */
  data: string;
  /** The box in the full image's pixels. */
  box: { left: number; top: number; right: number; bottom: number };
}

/**
 * Cuts the area around a box out of an image and draws the box on it. Made
 * in the page when the note is sent, so the copy travels in the message and
 * outlives the file it came from.
 */
export async function markedImageCrop(src: string, box: ImageBox): Promise<MarkedCrop> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const left = box.x * W;
  const top = box.y * H;
  const w = box.w * W;
  const h = box.h * H;
  const cw = Math.min(W, Math.max(w + 2 * MARGIN, MIN_WIDTH));
  const ch = Math.min(H, Math.max(h + 2 * MARGIN, MIN_HEIGHT));
  const cx = Math.min(Math.max(0, left + w / 2 - cw / 2), W - cw);
  const cy = Math.min(Math.max(0, top + h / 2 - ch / 2), H - ch);
  const k = Math.min(1, MAX_SIDE / Math.max(cw, ch));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cw * k);
  canvas.height = Math.round(ch * k);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw on an image');
  ctx.drawImage(img, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height);
  const line = Math.max(3, Math.round(canvas.width / 320));
  const rect = [(left - cx) * k, (top - cy) * k, w * k, h * k] as const;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.lineWidth = line * 2.2;
  ctx.strokeRect(...rect);
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = line;
  ctx.strokeRect(...rect);

  return {
    data: canvas.toDataURL('image/png').split(',')[1],
    box: { left: Math.round(left), top: Math.round(top), right: Math.round(left + w), bottom: Math.round(top + h) },
  };
}

type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };

/**
 * Turns the notes on screenshots into what the agent receives: a marked copy
 * of each, attached as an image, and a line saying which file it came from,
 * where the box is, and which attached image shows it. Notes on passages pass
 * through untouched. A copy that cannot be made is said so in the note.
 */
export async function attachImageNotes(
  notes: readonly PendingAnnotation[],
  imagesAlreadyAttached: number,
): Promise<{ notes: PendingAnnotation[]; images: ImageBlock[] }> {
  const images: ImageBlock[] = [];
  const out: PendingAnnotation[] = [];
  for (const note of notes) {
    if (!note.image) { out.push(note); continue; }
    const { src, path, box } = note.image;
    const file = path ?? src;
    let where: string;
    try {
      const crop = await markedImageCrop(src, box);
      images.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: crop.data } });
      const b = crop.box;
      where = `box at x ${b.left}–${b.right}, y ${b.top}–${b.bottom} px, drawn on attached image ${imagesAlreadyAttached + images.length}`;
    } catch (error) {
      const pct = (n: number) => `${Math.round(n * 100)}%`;
      where = `box from ${pct(box.x)} to ${pct(box.x + box.w)} across and ${pct(box.y)} to ${pct(box.y + box.h)} down; no marked copy, because the image could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    out.push({ ...note, quote: `Screenshot: ${note.quote} (${file}); ${where}` });
  }
  return { notes: out, images };
}

/**
 * Reads back a line written by `attachImageNotes`, for showing a sent note:
 * the screenshot's caption, and which attached image (counting from 1) shows
 * the box, or null when no marked copy could be made. Null for any other quote.
 */
export function parseScreenshotQuote(quote: string): { label: string; image: number | null } | null {
  const marked = /^Screenshot: ([\s\S]+) \([^()]*\); box at x [^;]* px, drawn on attached image (\d+)$/.exec(quote);
  if (marked) return { label: marked[1], image: Number(marked[2]) };
  const unmarked = /^Screenshot: ([\s\S]+) \([^()]*\); box from [^;]*; no marked copy, /.exec(quote);
  if (unmarked) return { label: unmarked[1], image: null };
  return null;
}
