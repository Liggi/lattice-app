import type { ContentBlockParam } from '@/types/index.js';
import type { UnifiedContentBlock, UnifiedMediaSource } from '@/types/unified-messages.js';

type ContentBlockLike = {
  type?: unknown;
  text?: unknown;
  source?: unknown;
};

type SourceLike = {
  type?: unknown;
  media_type?: unknown;
  data?: unknown;
  url?: unknown;
};

function normalizeMediaSource(source: unknown): UnifiedMediaSource | null {
  if (!source || typeof source !== 'object') {
    return null;
  }

  const candidate = source as SourceLike;
  const mediaType = typeof candidate.media_type === 'string' ? candidate.media_type : null;
  if (!mediaType) {
    return null;
  }

  if (candidate.type === 'base64') {
    const data = typeof candidate.data === 'string' ? candidate.data : null;
    if (!data) {
      return null;
    }
    return {
      type: 'base64',
      media_type: mediaType,
      data,
    };
  }

  if (candidate.type === 'url') {
    const url = typeof candidate.url === 'string' ? candidate.url : null;
    if (!url) {
      return null;
    }
    return {
      type: 'url',
      media_type: mediaType,
      url,
    };
  }

  return null;
}

/**
 * Build persisted user content for unified message storage.
 * Keeps multimodal attachment blocks and appends the typed prompt text.
 */
export function buildUnifiedUserContent(
  message: string,
  initialContent?: ContentBlockParam[]
): UnifiedContentBlock[] {
  const content: UnifiedContentBlock[] = [];

  if (Array.isArray(initialContent)) {
    for (const rawBlock of initialContent) {
      if (!rawBlock || typeof rawBlock !== 'object') {
        continue;
      }

      const block = rawBlock as ContentBlockLike;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        content.push({ type: 'text', text: block.text });
        continue;
      }

      if (block.type === 'image') {
        const source = normalizeMediaSource(block.source);
        if (source) {
          content.push({ type: 'image', source });
        }
        continue;
      }

      if (block.type === 'document') {
        const source = normalizeMediaSource(block.source);
        if (source) {
          content.push({ type: 'document', source });
        }
      }
    }
  }

  if (message.trim().length > 0) {
    content.push({ type: 'text', text: message });
  }

  return content;
}
