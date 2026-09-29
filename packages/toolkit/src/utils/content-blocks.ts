/**
 * Unwraps MCP-style content block arrays from tool result strings.
 *
 * Tool results often arrive as JSON-encoded arrays of content blocks:
 *   [{"type":"text","text":"..."},{"type":"image","source":{"media_type":"image/png","data":"..."}}]
 *
 * This utility parses them and separates text from image content.
 */

export interface ContentBlock {
  type: string;
  text?: string;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
}

export interface UnwrappedContent {
  text: string;
  blocks: ContentBlock[];
}

export function unwrapContentBlocks(raw: string): UnwrappedContent | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }

  const blocks: ContentBlock[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === 'object' && 'type' in item) blocks.push(item as ContentBlock);
    }
  } else if (parsed && typeof parsed === 'object' && 'type' in (parsed as Record<string, unknown>)) {
    blocks.push(parsed as ContentBlock);
  }

  if (blocks.length === 0) return null;
  if (!blocks.some(b => b.type === 'text' || b.type === 'image')) return null;

  const text = blocks.filter(b => b.type === 'text' && b.text).map(b => b.text!).join('\n');
  return { text, blocks };
}

/** Check if an unwrapped result contains an image block, inline or by URL. */
export function findImageBlock(content: UnwrappedContent): ContentBlock | undefined {
  return content.blocks.find(b => b.type === 'image' && (b.source?.data || b.source?.url));
}

/**
 * The `src` for an image content block: a data URL for inline base64, or the
 * block's own URL when the server sends the image separately.
 */
export function imageBlockToDataUrl(block: ContentBlock): string | null {
  if (block.source?.data) return `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`;
  return block.source?.url ?? null;
}
