/**
 * What a conversation has produced, read from its messages: the screenshots
 * its agents showed (gallery fences and embedded local images) and the pull
 * requests they linked, newest first. The panel reads it from the messages
 * the browser has loaded; `GET /api/conv/:id/outputs` reads it from the whole
 * log, so older outputs do not drop out of the panel when they scroll out of
 * the loaded tail.
 *
 * Pure: it imports nothing from the server, so the browser uses it too.
 */

import { parseGalleryBlock } from '../../utils/gallery-block.js';

export interface OutputImage {
  path: string;
  caption: string;
  messageId: string;
}

export interface OutputLink {
  href: string;
  /** `#421`, or the link's own text. */
  label: string;
  /** The words the message gave the link, when it gave any beyond the number. */
  title?: string;
  kind: 'pr' | 'link';
}

export interface ProjectOutputs {
  images: OutputImage[];
  links: OutputLink[];
}

/** One message's text, for reading outputs from. */
export interface OutputSource {
  messageId: string;
  text: string;
}

export const OUTPUT_IMAGE_LIMIT = 4;
export const OUTPUT_LINK_LIMIT = 6;
const GALLERY_FENCE = /```lattice-gallery\s*\n([\s\S]*?)```/g;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\((\/[^)\s]+\.(?:png|jpe?g|gif|webp))\)/gi;
const MARKDOWN_LINK = /(?<!!)\[([^\]]+)\]\((https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)[^)]*\)/g;
const BARE_PR = /(?<![(\w/])(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+))(?![\w/])/g;

function prNumber(href: string): string | null {
  return /\/pull\/(\d+)/.exec(href)?.[1] ?? null;
}

export interface OutputCollectorOptions {
  /** Whether an image is worth showing; one turned away takes none of the image slots. */
  acceptImage?: (path: string) => boolean;
}

/** Collects outputs from messages given newest first, up to the limits. */
export class OutputCollector {
  readonly images: OutputImage[] = [];
  readonly links: OutputLink[] = [];
  private readonly seenImages = new Set<string>();
  private readonly seenLinks = new Set<string>();
  private readonly acceptImage: (path: string) => boolean;

  constructor(options: OutputCollectorOptions = {}) {
    this.acceptImage = options.acceptImage ?? (() => true);
  }

  get full(): boolean {
    return this.images.length >= OUTPUT_IMAGE_LIMIT && this.links.length >= OUTPUT_LINK_LIMIT;
  }

  add({ messageId, text }: OutputSource): void {
    if (!text) return;
    const found: OutputImage[] = [];
    for (const match of text.matchAll(GALLERY_FENCE)) {
      const parsed = parseGalleryBlock(match[1] ?? '');
      if (!parsed.ok) continue;
      for (const image of parsed.images) found.push({ path: image.path, caption: image.caption, messageId });
    }
    for (const match of text.matchAll(MARKDOWN_IMAGE)) {
      found.push({ path: match[2]!, caption: match[1] ?? '', messageId });
    }
    for (const image of found) {
      if (this.images.length >= OUTPUT_IMAGE_LIMIT || this.seenImages.has(image.path)) continue;
      this.seenImages.add(image.path);
      if (this.acceptImage(image.path)) this.images.push(image);
    }
    const link = (href: string, words: string | undefined) => {
      if (this.links.length >= OUTPUT_LINK_LIMIT || this.seenLinks.has(href)) return;
      this.seenLinks.add(href);
      const number = prNumber(href);
      const title = words?.replace(/^PR\s*/i, '').replace(new RegExp(`^#?${number}\\b\\s*`), '').trim();
      this.links.push({ href, label: number ? `#${number}` : href, title: title || undefined, kind: number ? 'pr' : 'link' });
    };
    for (const match of text.matchAll(MARKDOWN_LINK)) link(match[2]!, match[1]);
    for (const match of text.matchAll(BARE_PR)) link(match[1]!, undefined);
  }

  result(): ProjectOutputs {
    return { images: [...this.images], links: [...this.links] };
  }
}

/** Outputs from messages given newest first. */
export function outputsFromSources(sources: Iterable<OutputSource>): ProjectOutputs {
  const collector = new OutputCollector();
  for (const source of sources) {
    collector.add(source);
    if (collector.full) break;
  }
  return collector.result();
}

/**
 * Both lists, newest first: `fresh` (what the browser has just streamed)
 * ahead of `indexed` (the server's read of the whole log), each kept to its
 * limit and without repeats.
 */
export function mergeOutputs(fresh: ProjectOutputs | null, indexed: ProjectOutputs | null): ProjectOutputs | null {
  if (!fresh) return indexed;
  if (!indexed) return fresh;
  const unique = <T>(items: T[], key: (item: T) => string, limit: number) => {
    const seen = new Set<string>();
    return items.filter((item) => !seen.has(key(item)) && seen.add(key(item))).slice(0, limit);
  };
  return {
    images: unique([...fresh.images, ...indexed.images], (image) => image.path, OUTPUT_IMAGE_LIMIT),
    links: unique([...fresh.links, ...indexed.links], (link) => link.href, OUTPUT_LINK_LIMIT),
  };
}
