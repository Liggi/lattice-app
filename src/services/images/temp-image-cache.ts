/**
 * Durable copies of images agents saved under a temp directory. macOS clears
 * /tmp on reboot and after a few days, which broke every screenshot an agent
 * had shown from there. A copy is kept under the config dir's
 * `evidence/tmp-images/`, keyed by the hash of the original path, and served
 * when the original has gone.
 */

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configDirNow } from '../../utils/constants.js';

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

// SVG is left out on purpose: it can carry script.
export const IMAGE_TYPES: Record<string, { mime: string; matches: (head: Buffer) => boolean }> = {
  '.png': { mime: 'image/png', matches: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.jpg': { mime: 'image/jpeg', matches: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  '.jpeg': { mime: 'image/jpeg', matches: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  '.gif': { mime: 'image/gif', matches: (h) => h.subarray(0, 4).toString('latin1') === 'GIF8' },
  '.webp': { mime: 'image/webp', matches: (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP' },
};

export interface TempImageCacheOptions {
  /** Where copies are kept; defaults to `<config dir>/evidence/tmp-images`. */
  cacheDir?: string;
  /** Temp directories whose images are copied; defaults to /tmp and os.tmpdir(). */
  tempRoots?: string[];
}

/** macOS reaches /tmp and /var through /private; one spelling per file keeps its key stable. */
function canonical(p: string): string {
  const resolved = path.resolve(p);
  return /^\/private\/(tmp|var)(\/|$)/.test(resolved) ? resolved.slice('/private'.length) : resolved;
}

function inside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function roots(opts: TempImageCacheOptions): string[] {
  return (opts.tempRoots ?? ['/tmp', os.tmpdir()]).map(canonical);
}

function cacheDir(opts: TempImageCacheOptions): string {
  return opts.cacheDir ?? path.join(configDirNow(), 'evidence', 'tmp-images');
}

/** Whether a path sits inside a temp directory, however /private is spelled. */
export function isTempPath(p: string, opts: TempImageCacheOptions = {}): boolean {
  const file = canonical(p);
  return roots(opts).some((root) => inside(file, root));
}

/** Where the copy of a temp image is, or would be, kept; null for anything else. */
export function cachedImagePath(p: string, opts: TempImageCacheOptions = {}): string | null {
  const ext = path.extname(p).toLowerCase();
  if (!IMAGE_TYPES[ext] || !isTempPath(p, opts)) return null;
  const key = createHash('sha256').update(canonical(p)).digest('hex');
  return path.join(cacheDir(opts), `${key}${ext}`);
}

/** The kept copy of a temp image, when there is one. */
export function findCachedImage(p: string, opts: TempImageCacheOptions = {}): string | null {
  const cached = cachedImagePath(p, opts);
  try {
    return cached && fs.statSync(cached).isFile() ? cached : null;
  } catch {
    return null;
  }
}

function persistOne(p: string, opts: TempImageCacheOptions): string | null {
  const dest = cachedImagePath(p, opts);
  if (!dest) return null;
  // Follow symlinks, and keep only files that really live in a temp directory.
  const real = fs.realpathSync(p);
  if (!isTempPath(real, opts)) return null;
  const live = fs.statSync(real);
  if (!live.isFile() || live.size > MAX_IMAGE_BYTES) return null;
  try {
    if (fs.statSync(dest).mtimeMs >= live.mtimeMs) return dest;
  } catch { /* not kept yet */ }
  const body = fs.readFileSync(real);
  if (!IMAGE_TYPES[path.extname(p).toLowerCase()]!.matches(body.subarray(0, 12))) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Written beside the copy and renamed over it, so a reader never sees half a file.
  const partial = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.partial`;
  try {
    fs.writeFileSync(partial, body);
    fs.utimesSync(partial, live.atime, live.mtime);
    fs.renameSync(partial, dest);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  return dest;
}

/**
 * Keeps a copy of a temp image that is still on disk, refreshing it when the
 * original is newer, along with figkit's `.phone.png` beside a PNG. Returns
 * the copy's path, or null when nothing was kept. Never throws.
 */
export function persistTempImage(p: string, opts: TempImageCacheOptions = {}): string | null {
  let kept: string | null = null;
  try {
    kept = persistOne(p, opts);
  } catch {
    return null;
  }
  if (kept && /\.png$/i.test(p) && !/\.phone\.png$/i.test(p)) {
    const phone = p.replace(/\.png$/i, '.phone.png');
    try {
      if (fs.existsSync(phone)) persistOne(phone, opts);
    } catch { /* the figure itself is kept */ }
  }
  return kept;
}
