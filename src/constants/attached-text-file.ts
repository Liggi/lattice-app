/**
 * A text file attached in the composer travels to the agent as a text block
 * headed `[File: <name>]`. The thread recognises that header to show the file
 * as a collapsed row instead of inlining its content into the user's bubble.
 *
 * A file too large to send inline is saved on the server's disk and the block
 * carries its path and a preview instead (large-attached-files.ts). That form
 * keeps the same header, so it is still one file row in the thread.
 */

const HEADER = /^\[File: ([^\]\n]+)\]\n/;

/** Larger text files are saved to disk and sent as their path. */
export const INLINE_TEXT_FILE_MAX_BYTES = 100 * 1024;
/**
 * The largest text file the composer accepts. A file over
 * INLINE_TEXT_FILE_MAX_BYTES is streamed to the server as it is attached and
 * never held in memory, so the bound is disk, not the browser or a request
 * body; this cap only stops a mistaken multi-gigabyte drop filling the disk.
 */
export const UPLOADED_TEXT_FILE_MAX_BYTES = 1024 * 1024 * 1024;
/** The preview of a saved file is at most this many whole lines... */
export const SAVED_FILE_PREVIEW_MAX_LINES = 20;
/** ...and at most this many characters. */
export const SAVED_FILE_PREVIEW_MAX_CHARS = 4000;

export interface SavedTextFile {
  /** Where the full file is on the machine Lattice runs on. */
  path: string;
  /** Human size, e.g. "2.0 MB". */
  size: string;
  lines: number;
  /** The file's first lines, whole, as the agent was shown them. */
  preview: string;
  previewLines: number;
}

export function formatAttachedTextFile(fileName: string, content: string): string {
  return `[File: ${fileName}]\n${content}`;
}

export function parseAttachedTextFile(text: string): { fileName: string; content: string } | null {
  const match = HEADER.exec(text);
  return match ? { fileName: match[1], content: text.slice(match[0].length) } : null;
}

/** True for a content block that is an attached text file rather than typed text. */
export function isAttachedTextFileBlock(block: { type: string; text?: string }): boolean {
  return block.type === 'text' && typeof block.text === 'string' && parseAttachedTextFile(block.text) !== null;
}

/**
 * The body of a file the composer already streamed to the server: only its
 * upload id travels in the message, and the server swaps this for the saved
 * path and preview before anything reaches the agent.
 */
export function formatUploadedTextFile(uploadId: string, bytes: number): string {
  return `Lattice upload ${uploadId}, ${bytes} bytes`;
}

const UPLOADED = /^Lattice upload ([0-9a-f-]{36}), (\d+) bytes$/;

export function parseUploadedTextFile(content: string): { uploadId: string; bytes: number } | null {
  const match = UPLOADED.exec(content);
  return match ? { uploadId: match[1], bytes: Number(match[2]) } : null;
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

/** The body of a saved file's block: what the agent reads in place of the content. */
export function formatSavedTextFile(file: SavedTextFile): string {
  const head = `This file is too large to include in the message (${file.size}, ${plural(file.lines, 'line')}), so Lattice saved it here:\n${file.path}\nRead it from that path with your tools.`;
  if (file.previewLines === 0) {
    return `${head} No preview: its first line alone is over ${SAVED_FILE_PREVIEW_MAX_CHARS.toLocaleString('en-US')} characters.`;
  }
  return `${head} Its first ${plural(file.previewLines, 'line')}:\n\n${file.preview}`;
}

const SAVED = /^This file is too large to include in the message \(([^,]+), ([\d,]+) lines?\), so Lattice saved it here:\n(.+)\nRead it from that path with your tools\.(?: No preview: .*$| Its first ([\d,]+) lines?:\n\n([\s\S]*)$)/;

/** The saved-file details in an attached file's content, or null for an inline file. */
export function parseSavedTextFile(content: string): SavedTextFile | null {
  const match = SAVED.exec(content);
  if (!match) return null;
  const count = (value: string) => Number(value.replace(/,/g, ''));
  const lines = count(match[2]);
  const preview = match[5] ?? '';
  return {
    size: match[1],
    lines,
    path: match[3],
    preview,
    previewLines: match[4] ? count(match[4]) : 0,
  };
}
