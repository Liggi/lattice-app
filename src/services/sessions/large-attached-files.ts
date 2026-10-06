/**
 * Text files too large to send to the agent inline, saved to disk instead.
 *
 * The composer sends an attached text file as a `[File: <name>]` text block.
 * A large one (a working CSV) would overflow the model's context window and
 * the provider would refuse the turn as "prompt is too long". So before a
 * message reaches the provider, its large files are saved, unchanged, to the
 * session's attachments folder under this deployment's config dir, and each
 * one's block is replaced by one with the same header naming the path, the
 * size, the line count and the first few lines. The agent reads the file
 * with its own tools. The replaced block is what `input:sent` records, so the
 * thread shows exactly what the agent was given.
 *
 * A file arrives in one of two ways:
 *  - inline, its content in the block: one over INLINE_TEXT_FILE_MAX_BYTES,
 *    and then the largest of the rest until the message's inline files fit
 *    under it, is written out;
 *  - already uploaded: the composer streams any file over that size to
 *    `receiveUpload` as it is attached, and the block carries only the upload
 *    id. The upload is moved into the session's folder.
 *
 * A block that already names a saved file is left alone, so a resend of the
 * same blocks (an inbox drain) writes nothing twice.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  INLINE_TEXT_FILE_MAX_BYTES,
  SAVED_FILE_PREVIEW_MAX_CHARS,
  SAVED_FILE_PREVIEW_MAX_LINES,
  UPLOADED_TEXT_FILE_MAX_BYTES,
  formatAttachedTextFile,
  formatSavedTextFile,
  parseAttachedTextFile,
  parseSavedTextFile,
  parseUploadedTextFile,
} from '../../constants/attached-text-file.js';
import { configDirNow } from '../../utils/constants.js';
import { attachmentsDir } from './coordinator-attachments.js';

/** An upload not sent in a message within this long is removed. */
const UPLOAD_KEEP_MS = 24 * 60 * 60 * 1000;
/** Bytes read from the start of an uploaded file for its preview. */
const PREVIEW_READ_BYTES = 64 * 1024;

export class AttachedFileError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function uploadsDir(configDir: string = configDirNow()): string {
  return path.join(configDir, 'attachment-uploads');
}

/** Remove uploads that were never sent. Best effort: a failure here never blocks an upload. */
function sweepStaleUploads(dir: string, now: number): void {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > UPLOAD_KEEP_MS) fs.rmSync(file, { force: true });
    } catch { /* gone already */ }
  }
}

/**
 * Stream a request body to disk as a pending upload and return its id. The
 * body is never held in memory; one over UPLOADED_TEXT_FILE_MAX_BYTES is
 * stopped as soon as it passes the limit and nothing is kept.
 */
export async function receiveUpload(body: Readable, options: { configDir?: string } = {}): Promise<{ uploadId: string; bytes: number }> {
  const dir = uploadsDir(options.configDir);
  fs.mkdirSync(dir, { recursive: true });
  sweepStaleUploads(dir, Date.now());
  const uploadId = randomUUID();
  const partial = path.join(dir, `${uploadId}.part`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > UPLOADED_TEXT_FILE_MAX_BYTES) {
        callback(new AttachedFileError(`File is over the ${UPLOADED_TEXT_FILE_MAX_BYTES / (1024 * 1024 * 1024)} GB limit`, 413));
      } else {
        callback(null, chunk);
      }
    },
  });
  try {
    await pipeline(body, limit, fs.createWriteStream(partial));
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  fs.renameSync(partial, path.join(dir, uploadId));
  return { uploadId, bytes };
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whole lines from the start of the file, within both preview limits.
 * `head` is the file's start; when it is not the whole file its last line may
 * be cut, so that line is never used.
 */
function previewOf(head: string, wholeFile: boolean): { preview: string; previewLines: number } {
  const candidates = head.split('\n');
  if (!wholeFile) candidates.pop();
  const lines: string[] = [];
  let chars = 0;
  for (const line of candidates.slice(0, SAVED_FILE_PREVIEW_MAX_LINES)) {
    if (chars + line.length > SAVED_FILE_PREVIEW_MAX_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return { preview: lines.join('\n'), previewLines: lines.length };
}

/** Line count from the number of line breaks and whether the file ends with one. */
function lineCount(breaks: number, bytes: number, endsWithBreak: boolean): number {
  if (bytes === 0) return 0;
  return endsWithBreak ? breaks : breaks + 1;
}

async function countLines(file: string, bytes: number): Promise<number> {
  let breaks = 0;
  let last = -1;
  for await (const chunk of fs.createReadStream(file) as AsyncIterable<Buffer>) {
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) breaks++;
    if (chunk.length > 0) last = chunk[chunk.length - 1];
  }
  return lineCount(breaks, bytes, last === 10);
}

function readHead(file: string, bytes: number): string {
  const length = Math.min(bytes, PREVIEW_READ_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

/** A file name safe to write: its last path part, with nothing that could name another folder. */
function safeFileName(fileName: string): string {
  const base = path.basename(fileName.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '');
  return base && base !== '.' && base !== '..' ? base : 'attached-file';
}

function savedBlock(fileName: string, saved: string, bytes: number, lines: number, preview: { preview: string; previewLines: number }): ContentBlockParam {
  return {
    type: 'text',
    text: formatAttachedTextFile(fileName, formatSavedTextFile({ path: saved, size: sizeLabel(bytes), lines, ...preview })),
  };
}

/**
 * Return the blocks with every uploaded file moved into the session's folder,
 * and every inline text file too large to send inline saved there, each
 * replaced by its path and preview. Returns the same array when nothing
 * needed saving. Throws AttachedFileError when an upload is missing.
 */
export async function saveLargeAttachedFiles(
  sessionId: string,
  blocks: ContentBlockParam[],
  options: { configDir?: string; now?: Date } = {},
): Promise<ContentBlockParam[]> {
  const files = blocks.flatMap((block, index) => {
    if (block.type !== 'text') return [];
    const file = parseAttachedTextFile(block.text);
    // Already saved: a resend of blocks this has replaced.
    if (!file || parseSavedTextFile(file.content)) return [];
    const upload = parseUploadedTextFile(file.content);
    return [{ index, ...file, upload, bytes: upload ? upload.bytes : Buffer.byteLength(file.content, 'utf8') }];
  });
  const toSave = new Set(files.filter((file) => file.upload).map((file) => file.index));
  let inlineBytes = 0;
  for (const file of files.filter((f) => !f.upload).sort((a, b) => a.bytes - b.bytes)) {
    if (inlineBytes + file.bytes > INLINE_TEXT_FILE_MAX_BYTES) toSave.add(file.index);
    else inlineBytes += file.bytes;
  }
  if (toSave.size === 0) return blocks;

  const configDir = options.configDir ?? configDirNow();
  const dir = attachmentsDir(sessionId, configDir);
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const replaced = [...blocks];
  for (const file of files) {
    if (!toSave.has(file.index)) continue;
    const saved = path.join(dir, `${stamp}-${file.index + 1}-${safeFileName(file.fileName)}`);
    if (file.upload) {
      const upload = path.join(uploadsDir(configDir), file.upload.uploadId);
      if (!fs.existsSync(upload)) {
        throw new AttachedFileError(`${file.fileName} is no longer on the server (uploads are kept for a day); attach it again`, 400);
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(upload, saved);
      const bytes = fs.statSync(saved).size;
      replaced[file.index] = savedBlock(file.fileName, saved, bytes, await countLines(saved, bytes),
        previewOf(readHead(saved, bytes), bytes <= PREVIEW_READ_BYTES));
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(saved, file.content, 'utf8');
      const breaks = file.content.split('\n').length - 1;
      replaced[file.index] = savedBlock(file.fileName, saved, file.bytes,
        lineCount(breaks, file.bytes, file.content.endsWith('\n')), previewOf(file.content, true));
    }
  }
  return replaced;
}
