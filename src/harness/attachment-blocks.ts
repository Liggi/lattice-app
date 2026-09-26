/**
 * Attachment content blocks — validation for the image/document/text blocks the
 * composer sends alongside a user message.
 *
 * The composer (toolkit `useAttachments` → `LatticeComposer.toContentBlockParam`)
 * produces Anthropic `ContentBlockParam` values. They ride the wire as JSON on
 * the harness `/start` and `/send` bodies, so the server has to treat them as
 * untrusted input before handing them to the Agent SDK.
 *
 * Validation is strict and fails loudly: an unsupported block or media type
 * returns an error the route turns into a 400, rather than quietly dropping the
 * user's file and sending a text-only turn.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';

/** Image media types the Anthropic Messages API accepts. */
const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

/** Document media types the Anthropic Messages API accepts. */
const SUPPORTED_DOCUMENT_MEDIA_TYPES = ['application/pdf'] as const;

type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];
type SupportedDocumentMediaType = (typeof SUPPORTED_DOCUMENT_MEDIA_TYPES)[number];

export type AttachmentParseResult =
  | { ok: true; blocks: ContentBlockParam[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a raw `attachments` payload into Anthropic content blocks.
 *
 * Returns `{ ok: true, blocks: [] }` for a missing/empty payload — "no
 * attachments" is not an error. Anything present but malformed is an error.
 */
export function parseAttachmentBlocks(value: unknown): AttachmentParseResult {
  if (value === undefined || value === null) return { ok: true, blocks: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'attachments must be an array' };

  const blocks: ContentBlockParam[] = [];

  for (let i = 0; i < value.length; i++) {
    const raw: unknown = value[i];
    if (!isRecord(raw)) return { ok: false, error: `attachments[${i}] must be an object` };

    if (raw.type === 'text') {
      if (typeof raw.text !== 'string' || raw.text.length === 0) {
        return { ok: false, error: `attachments[${i}].text must be a non-empty string` };
      }
      blocks.push({ type: 'text', text: raw.text });
      continue;
    }

    if (raw.type === 'image' || raw.type === 'document') {
      const source = raw.source;
      if (!isRecord(source)) {
        return { ok: false, error: `attachments[${i}].source must be an object` };
      }
      if (source.type !== 'base64') {
        return { ok: false, error: `attachments[${i}].source.type must be "base64"` };
      }
      if (typeof source.data !== 'string' || source.data.length === 0) {
        return { ok: false, error: `attachments[${i}].source.data must be a non-empty base64 string` };
      }
      const mediaType = source.media_type;
      if (typeof mediaType !== 'string') {
        return { ok: false, error: `attachments[${i}].source.media_type must be a string` };
      }

      if (raw.type === 'image') {
        if (!(SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
          return {
            ok: false,
            error: `attachments[${i}] unsupported image media_type "${mediaType}" (supported: ${SUPPORTED_IMAGE_MEDIA_TYPES.join(', ')})`,
          };
        }
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType as SupportedImageMediaType, data: source.data },
        });
        continue;
      }

      if (!(SUPPORTED_DOCUMENT_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
        return {
          ok: false,
          error: `attachments[${i}] unsupported document media_type "${mediaType}" (supported: ${SUPPORTED_DOCUMENT_MEDIA_TYPES.join(', ')})`,
        };
      }
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: mediaType as SupportedDocumentMediaType, data: source.data },
      });
      continue;
    }

    return {
      ok: false,
      error: `attachments[${i}].type must be one of "image", "document", "text" (got ${JSON.stringify(raw.type)})`,
    };
  }

  return { ok: true, blocks };
}

/**
 * Build the `content` for a user message from optional attachment blocks plus
 * the typed text. Attachments come first — the Anthropic docs recommend placing
 * images before the text that refers to them.
 *
 * Returns a plain string when there are no attachments, keeping the existing
 * text-only wire shape byte-identical.
 */
export function buildUserContent(
  text: string,
  attachments: readonly ContentBlockParam[] = [],
): string | ContentBlockParam[] {
  if (attachments.length === 0) return text;
  const content: ContentBlockParam[] = [...attachments];
  if (text.trim().length > 0) content.push({ type: 'text', text });
  return content;
}
