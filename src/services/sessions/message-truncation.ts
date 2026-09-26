import sharp from 'sharp';
import type { ConversationMessage } from '@/types/index.js';

const THUMBNAIL_MAX_DIMENSION = 800;
const THUMBNAIL_JPEG_QUALITY = 80;

interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

function isImageBlock(block: unknown): block is ImageBlock {
  if (!block || typeof block !== 'object') return false;
  const b = block as Record<string, unknown>;
  if (b.type !== 'image') return false;
  const source = b.source as Record<string, unknown> | undefined;
  return source?.type === 'base64' && typeof source.data === 'string';
}

async function resizeImageBlock(block: ImageBlock): Promise<void> {
  try {
    const buf = Buffer.from(block.source.data, 'base64');
    // Skip small images (under 50KB base64 ≈ ~37KB raw)
    if (buf.length < 37_000) return;

    const resized = await sharp(buf)
      .resize(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
      .toBuffer();

    // Only replace if we actually reduced size
    if (resized.length < buf.length) {
      block.source.data = resized.toString('base64');
      block.source.media_type = 'image/jpeg';
    }
  } catch {
    // If sharp fails (corrupt image, unsupported format), leave the original
  }
}

/**
 * Resize image blocks in conversation messages to thumbnails for browser display.
 * Mutates messages in-place. Call before sending API responses.
 */
export async function thumbnailImageBlocks(messages: ConversationMessage[]): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const msg of messages) {
    const messageObj = msg.message as { content?: unknown[] };
    const content = messageObj?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (isImageBlock(block)) {
        promises.push(resizeImageBlock(block));
      }
    }
  }

  await Promise.all(promises);
}
