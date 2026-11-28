import { Router, type Response } from 'express';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { asyncHandler } from '@/middleware/error-handler.js';
import { LatticeError } from '@/types/index.js';
import { configDirNow } from '@/utils/constants.js';
import {
  findCachedImage,
  IMAGE_TYPES,
  isTempPath,
  MAX_IMAGE_BYTES,
  persistTempImage,
  type TempImageCacheOptions,
} from '@/services/images/temp-image-cache.js';

const WORKING_DIRS_TTL_MS = 10_000;

/**
 * Standard output/artifact directories where supported agents and Lattice
 * itself save screenshots, scratch files, generated images, and attachments.
 * Narrowly scoped to output subdirectories — never top-level config dirs like
 * ~/.gemini, ~/.claude, or ~/.codex where credentials live.
 */
export function defaultAgentImageRoots(): string[] {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  const latticeConfigDir = configDirNow();
  return [
    path.join(home, '.gemini', 'antigravity-cli', 'brain'),
    path.join(home, '.gemini', 'antigravity', 'brain'),
    path.join(home, '.gemini', 'tmp'),
    path.join(codexHome, 'generated_images'),
    path.join(home, '.claude', 'projects'),
    path.join(latticeConfigDir, 'attachments'),
    path.join(latticeConfigDir, 'evidence'),
  ];
}

export interface ImageRoutesDeps {
  /** Working directories of the sessions Lattice knows about. */
  listWorkingDirectories: () => Promise<string[]>;
  /** Agent artifact/output directories allowed alongside temp and session dirs. */
  listAgentImageRoots?: () => string[];
  /** Where copies of temp images are kept; tests point it at their own directory. */
  tempImageCache?: TempImageCacheOptions;
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

function isInside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Serves an image file an agent saved, so a markdown image with an absolute
 * path renders in the UI. Only PNG/JPEG/GIF/WebP files under a temp directory,
 * a Lattice session's working directory, or a known agent output directory
 * are served. A temp image is copied aside when served, and the copy is served
 * once the temp directory has been cleared.
 */
/**
 * figkit draws a second, stacked layout of a figure whose sides sit next to each
 * other, as `name.phone.png` beside `name.png`, and writes it after the figure.
 * A phone asks for it with variant=phone; any figure without one, or with one
 * older than the figure, is served as it is.
 */
async function phoneLayout(desktop: string, isAllowed: (f: string) => Promise<boolean>): Promise<string> {
  if (!/\.png$/i.test(desktop)) return desktop;
  const phone = await realpathOrNull(desktop.replace(/\.png$/i, '.phone.png'));
  if (!phone || !(await isAllowed(phone))) return desktop;
  const [d, p] = await Promise.all([fs.stat(desktop), fs.stat(phone)]);
  return p.isFile() && p.mtimeMs >= d.mtimeMs ? phone : desktop;
}

async function sendImage(res: Response, file: string, type: { mime: string; matches: (head: Buffer) => boolean }): Promise<void> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new LatticeError('NOT_FOUND', 'Image not found', 404);
    if (stat.size > MAX_IMAGE_BYTES) throw new LatticeError('FILE_TOO_LARGE', 'Image is larger than 25 MB', 413);
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);
    if (!type.matches(head)) {
      throw new LatticeError('NOT_AN_IMAGE', 'File contents do not match its image extension', 415);
    }
    const body = await handle.readFile();
    res.set({
      'Content-Type': type.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'private, no-cache',
      'Last-Modified': stat.mtime.toUTCString(),
    });
    res.send(body);
  } finally {
    await handle.close();
  }
}

export function createImageRoutes(deps: ImageRoutesDeps): Router {
  const router = Router();
  const cacheOpts = deps.tempImageCache ?? {};
  let workingDirs: { roots: string[]; at: number } | null = null;

  // Cached; a miss re-reads the list (at most once a second) so a session
  // started moments ago can serve its images straight away.
  async function sessionRoots(onMiss: boolean): Promise<string[]> {
    const maxAge = onMiss ? 1000 : WORKING_DIRS_TTL_MS;
    if (workingDirs && Date.now() - workingDirs.at < maxAge) return workingDirs.roots;
    const dirs = await deps.listWorkingDirectories();
    const roots = (await Promise.all(dirs.map(realpathOrNull))).filter((d): d is string => d !== null);
    workingDirs = { roots, at: Date.now() };
    return roots;
  }

  router.get('/', asyncHandler(async (req, res) => {
    const requested = typeof req.query.path === 'string' ? req.query.path : '';
    if (!path.isAbsolute(requested)) {
      throw new LatticeError('INVALID_PATH', 'path must be an absolute file path', 400);
    }
    const type = IMAGE_TYPES[path.extname(requested).toLowerCase()];
    if (!type) {
      throw new LatticeError('NOT_AN_IMAGE', 'Only .png, .jpg, .jpeg, .gif and .webp files are served', 415);
    }
    const desktop = await realpathOrNull(requested);
    if (!desktop) {
      const kept = cachedCopy(requested, req.query.variant === 'phone');
      if (!kept) throw new LatticeError('NOT_FOUND', 'Image not found', 404);
      await sendImage(res, kept, type);
      return;
    }

    const candidateRoots = ['/tmp', os.tmpdir(), ...(deps.listAgentImageRoots ?? defaultAgentImageRoots)()];
    const staticRoots = (await Promise.all(candidateRoots.map(realpathOrNull))).filter((d): d is string => d !== null);
    const isAllowed = async (f: string) => staticRoots.some((r) => isInside(f, r))
      || (await sessionRoots(false)).some((r) => isInside(f, r))
      || (await sessionRoots(true)).some((r) => isInside(f, r));
    if (!(await isAllowed(desktop))) {
      throw new LatticeError('PATH_NOT_ALLOWED', 'Images are served only from a temp directory, a session working directory, or an agent output directory', 403);
    }
    if (isTempPath(requested, cacheOpts)) persistTempImage(requested, cacheOpts);
    const file = req.query.variant === 'phone' ? await phoneLayout(desktop, isAllowed) : desktop;
    await sendImage(res, file, type);
  }));

  // The kept copy of a temp image whose original has gone; for a phone, the
  // copy of its phone layout when that is as new as the figure's.
  function cachedCopy(requested: string, phone: boolean): string | null {
    const figure = findCachedImage(requested, cacheOpts);
    if (!figure || !phone || !/\.png$/i.test(requested)) return figure;
    const layout = findCachedImage(requested.replace(/\.png$/i, '.phone.png'), cacheOpts);
    if (!layout) return figure;
    return fsSync.statSync(layout).mtimeMs >= fsSync.statSync(figure).mtimeMs ? layout : figure;
  }

  return router;
}
