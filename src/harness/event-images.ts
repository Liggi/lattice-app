/**
 * Images in served events travel as URLs, not inline base64.
 *
 * A screenshot a tool returns is stored in its event as a base64 image block,
 * 400-700 KB of JSON each. Sent inline, a few of them made up 78-87% of the
 * 200-event window a session switch downloads, and the page then held every
 * one as a string for as long as the session was open (2026-09-29). Served
 * events carry a URL to the same bytes instead, which the browser fetches when
 * it draws the image, at full resolution, and caches. Stored events are not
 * changed: this applies only to what is sent to a page.
 */

/** Images at or under this many base64 characters stay inline: a request costs more than they do. */
const INLINE_MAX_CHARS = 8 * 1024;

interface Base64ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type?: string; data: string };
}

function isBase64Image(value: unknown): value is Base64ImageBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as { type?: unknown; source?: { type?: unknown; data?: unknown } };
  return block.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string';
}

/** The URL a served event names for its `index`th base64 image. */
export function eventImageUrl(sessionId: string, seq: number, index: number): string {
  return `/api/harness/${encodeURIComponent(sessionId)}/events/${seq}/images/${index}`;
}

/**
 * Walks `value` in a fixed order, numbering every base64 image block, and
 * returns a copy in which `replace` has had its say on each. Objects and arrays
 * that contain no image are returned as they are, so nothing is copied for an
 * event without images and the stored event is never modified.
 */
function mapImages(value: unknown, counter: { n: number }, replace: (block: Base64ImageBlock, index: number) => unknown): unknown {
  if (isBase64Image(value)) return replace(value, counter.n++);
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const next = mapImages(value[i], counter, replace);
      if (next !== value[i]) {
        copy ??= value.slice();
        copy[i] = next;
      }
    }
    return copy ?? value;
  }
  if (value && typeof value === 'object') {
    let copy: Record<string, unknown> | null = null;
    for (const [key, child] of Object.entries(value)) {
      const next = mapImages(child, counter, replace);
      if (next !== child) {
        copy ??= { ...(value as Record<string, unknown>) };
        copy[key] = next;
      }
    }
    return copy ?? value;
  }
  return value;
}

/** The event as it should be sent to a page: large base64 images replaced by URLs. */
export function externalizeEventImages<E extends { seq: number; data?: unknown }>(sessionId: string, event: E): E {
  if (event.data === undefined) return event;
  const data = mapImages(event.data, { n: 0 }, (block, index) =>
    block.source.data.length <= INLINE_MAX_CHARS
      ? block
      : { ...block, source: { type: 'url', url: eventImageUrl(sessionId, event.seq, index), media_type: block.source.media_type } },
  );
  return data === event.data ? event : { ...event, data };
}

/** The `index`th base64 image in the event's data, in the numbering `externalizeEventImages` uses. */
export function findEventImage(data: unknown, index: number): { mediaType: string; bytes: Buffer } | null {
  let found: Base64ImageBlock | null = null;
  mapImages(data, { n: 0 }, (block, n) => {
    if (n === index) found = block;
    return block;
  });
  const image = found as Base64ImageBlock | null;
  if (!image) return null;
  return { mediaType: image.source.media_type || 'image/png', bytes: Buffer.from(image.source.data, 'base64') };
}
