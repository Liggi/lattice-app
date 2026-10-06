/**
 * A text file too large to send inline is saved unchanged and the agent is
 * given its path, size, line count and first lines; small files stay inline.
 * A file the composer streamed up front is moved into place the same way.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { receiveUpload, saveLargeAttachedFiles, uploadsDir } from '../../src/services/sessions/large-attached-files.js';
import {
  formatAttachedTextFile,
  formatUploadedTextFile,
  parseAttachedTextFile,
  parseSavedTextFile,
} from '../../src/constants/attached-text-file.js';

const now = new Date('2026-10-06T19:00:00.000Z');
const fileBlock = (name: string, content: string) => ({ type: 'text', text: formatAttachedTextFile(name, content) } as const);
const csv = ['id,region,units', ...Array.from({ length: 9999 }, (_, i) => `${i},north,${i % 50}`)].join('\n') + '\n';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-attached-files-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('saveLargeAttachedFiles', () => {
  it('saves a large file unchanged and sends its path and first lines', async () => {
    const typed = { type: 'text', text: 'what is in this?' } as const;
    const blocks = await saveLargeAttachedFiles('conv-a', [fileBlock('sales.csv', csv), typed], { configDir: dir, now });
    const saved = path.join(dir, 'attachments', 'conv-a', '2026-10-06T19-00-00-000Z-1-sales.csv');
    expect(fs.readFileSync(saved, 'utf8')).toBe(csv);
    expect(blocks[1]).toBe(typed);

    const file = parseAttachedTextFile((blocks[0] as { text: string }).text)!;
    expect(file.fileName).toBe('sales.csv');
    expect(parseSavedTextFile(file.content)).toEqual({
      path: saved,
      size: `${(Buffer.byteLength(csv) / 1024).toFixed(1)} KB`,
      lines: 10000,
      preview: csv.split('\n').slice(0, 20).join('\n'),
      previewLines: 20,
    });
  });

  it('leaves small files inline and saves the largest until the rest fit', async () => {
    const small = fileBlock('a.json', '{"a":1}');
    expect(await saveLargeAttachedFiles('conv-a', [small], { configDir: dir })).toEqual([small]);
    expect(fs.existsSync(path.join(dir, 'attachments'))).toBe(false);

    const sixty = fileBlock('sixty.txt', 'x'.repeat(60 * 1024));
    const seventy = fileBlock('seventy.txt', 'y'.repeat(70 * 1024));
    const blocks = await saveLargeAttachedFiles('conv-a', [sixty, seventy, small], { configDir: dir, now });
    expect(blocks[0]).toEqual(sixty);
    expect(blocks[2]).toEqual(small);
    const saved = parseSavedTextFile(parseAttachedTextFile((blocks[1] as { text: string }).text)!.content)!;
    expect(saved.path).toBe(path.join(dir, 'attachments', 'conv-a', '2026-10-06T19-00-00-000Z-2-seventy.txt'));
    // One 70 KB line: too long to preview, and said so.
    expect(saved.previewLines).toBe(0);
  });

  it('writes nothing again for blocks it already replaced, and keeps names inside the folder', async () => {
    const once = await saveLargeAttachedFiles('conv-a', [fileBlock('../../etc/x.csv', csv)], { configDir: dir, now });
    expect(fs.readdirSync(path.join(dir, 'attachments', 'conv-a'))).toEqual(['2026-10-06T19-00-00-000Z-1-x.csv']);
    expect(await saveLargeAttachedFiles('conv-a', once, { configDir: dir, now: new Date() })).toBe(once);
    expect(fs.readdirSync(path.join(dir, 'attachments', 'conv-a'))).toHaveLength(1);
  });

  it('moves a streamed upload into the session folder and previews whole lines only', async () => {
    const { uploadId, bytes } = await receiveUpload(Readable.from([Buffer.from(csv)]), { configDir: dir });
    expect(bytes).toBe(Buffer.byteLength(csv));
    const blocks = await saveLargeAttachedFiles('conv-b', [fileBlock('sales.csv', formatUploadedTextFile(uploadId, bytes))], { configDir: dir, now });
    const saved = path.join(dir, 'attachments', 'conv-b', '2026-10-06T19-00-00-000Z-1-sales.csv');
    expect(fs.readFileSync(saved, 'utf8')).toBe(csv);
    expect(fs.readdirSync(uploadsDir(dir))).toEqual([]);
    expect(parseSavedTextFile(parseAttachedTextFile((blocks[0] as { text: string }).text)!.content)).toMatchObject({
      path: saved, lines: 10000, previewLines: 20, preview: csv.split('\n').slice(0, 20).join('\n'),
    });
  });

  it('refuses a missing upload, and an id that is not one', async () => {
    const missing = fileBlock('gone.csv', formatUploadedTextFile('00000000-0000-0000-0000-000000000000', 10));
    await expect(saveLargeAttachedFiles('conv-b', [missing], { configDir: dir })).rejects.toThrow(/no longer on the server/);
    // Not an upload id, so it is ordinary (small) inline text and stays as it is.
    const trick = fileBlock('x.csv', 'Lattice upload ../../../etc/passwd, 10 bytes');
    expect(await saveLargeAttachedFiles('conv-b', [trick], { configDir: dir })).toEqual([trick]);
  });
});
