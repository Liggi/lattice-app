/**
 * Images the user attaches to a coordinator, kept on disk for its workers.
 *
 * A coordinator receives an attached image as bytes inside its own turn, but
 * the only way it can reach a worker is text: `lattice session new` and
 * `session send` carry no attachments. So each image attached to a
 * coordinator's message is also written to disk, unchanged, under this
 * deployment's config dir, and a text block naming the path is appended to
 * the attachments the coordinator sees. The coordinator hands the path to a
 * worker; the worker reads the file itself. Sessions that are not
 * coordinators get the bytes directly and nothing is written.
 *
 * The saved file is the provenance record: its name carries the conversation
 * it arrived in, when, and its position among that message's images, and the
 * same text block is on the message's `input:sent` event, which the thread
 * leaves out of the user's bubble (constants/saved-image-note.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { formatSavedImageNote } from '../../constants/saved-image-note.js';
import { configDirNow } from '../../utils/constants.js';

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function attachmentsDir(sessionId: string, configDir: string = configDirNow()): string {
  return path.join(configDir, 'attachments', sessionId);
}

/**
 * Write each base64 image block to disk and return the blocks with one text
 * block appended that names the saved paths. Returns the blocks untouched
 * when there is no image to save.
 */
export function persistCoordinatorImages(
  sessionId: string,
  blocks: ContentBlockParam[],
  options: { configDir?: string; now?: Date } = {},
): ContentBlockParam[] {
  const images = blocks.filter(
    (block): block is Extract<ContentBlockParam, { type: 'image' }> & { source: { type: 'base64'; media_type: string; data: string } } =>
      block.type === 'image' && block.source.type === 'base64',
  );
  if (images.length === 0) return blocks;

  const dir = attachmentsDir(sessionId, options.configDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const saved = images.map((image, index) => {
    const extension = EXTENSION_BY_MEDIA_TYPE[image.source.media_type] ?? 'bin';
    const file = path.join(dir, `${stamp}-${index + 1}.${extension}`);
    fs.writeFileSync(file, Buffer.from(image.source.data, 'base64'));
    return file;
  });

  return [...blocks, { type: 'text', text: formatSavedImageNote(saved) }];
}
