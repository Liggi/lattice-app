import { Router } from 'express';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { asyncHandler } from '@/middleware/error-handler.js';
import { LatticeError } from '@/types/index.js';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const WORKING_DIRS_TTL_MS = 10_000;

// SVG is left out on purpose: it can carry script.
const IMAGE_TYPES: Record<string, { mime: string; matches: (head: Buffer) => boolean }> = {
  '.png': { mime: 'image/png', matches: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.jpg': { mime: 'image/jpeg', matches: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  '.jpeg': { mime: 'image/jpeg', matches: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  '.gif': { mime: 'image/gif', matches: (h) => h.subarray(0, 4).toString('latin1') === 'GIF8' },
  '.webp': { mime: 'image/webp', matches: (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP' },
};

export interface ImageRoutesDeps {
  /** Working directories of the sessions Lattice knows about. */
  listWorkingDirectories: () => Promise<string[]>;
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
 * path renders in the UI. Only PNG/JPEG/GIF/WebP files under a temp directory
 * or a Lattice session's working directory are served.
 */
export function createImageRoutes(deps: ImageRoutesDeps): Router {
  const router = Router();
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
    const file = await realpathOrNull(requested);
    if (!file) throw new LatticeError('NOT_FOUND', 'Image not found', 404);

    const tempRoots = (await Promise.all(['/tmp', os.tmpdir()].map(realpathOrNull))).filter((d): d is string => d !== null);
    const allowed = tempRoots.some((r) => isInside(file, r))
      || (await sessionRoots(false)).some((r) => isInside(file, r))
      || (await sessionRoots(true)).some((r) => isInside(file, r));
    if (!allowed) {
      throw new LatticeError('PATH_NOT_ALLOWED', 'Images are served only from a temp directory or a session working directory', 403);
    }

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
  }));

  return router;
}
