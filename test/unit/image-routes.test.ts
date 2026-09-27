import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImageRoutes } from '../../src/routes/system/image.routes.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { localImageUrl } from '../../src/web/chat/components/MessageList/MessageItem.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('GET /api/images', () => {
  let server: Server;
  let baseUrl: string;
  let tmp: string;
  let workDir: string;
  let outside: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'img-route-'));
    fs.writeFileSync(path.join(tmp, 'shot.png'), PNG);
    fs.writeFileSync(path.join(tmp, 'secret.png'), 'not really a png');
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'hello');
    // Session working dirs and "outside" live under $HOME, away from temp roots.
    workDir = fs.mkdtempSync(path.join(os.homedir(), '.img-route-work-'));
    outside = fs.mkdtempSync(path.join(os.homedir(), '.img-route-outside-'));
    fs.writeFileSync(path.join(workDir, 'repo-shot.png'), PNG);
    fs.writeFileSync(path.join(outside, 'private.png'), PNG);
    fs.symlinkSync(path.join(outside, 'private.png'), path.join(tmp, 'link.png'));

    const app = express();
    app.use('/api/images', createImageRoutes({ listWorkingDirectories: async () => [workDir] }));
    app.use(errorHandler);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/images?path=`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const d of [tmp, workDir, outside]) fs.rmSync(d, { recursive: true, force: true });
  });

  const get = (p: string) => fetch(baseUrl + encodeURIComponent(p));

  it('serves a PNG from a temp directory and from a session working directory', async () => {
    for (const p of [path.join(tmp, 'shot.png'), path.join(workDir, 'repo-shot.png')]) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    }
  });

  it('refuses files outside the allowed roots, including through a symlink', async () => {
    expect((await get(path.join(outside, 'private.png'))).status).toBe(403);
    expect((await get(path.join(tmp, 'link.png'))).status).toBe(403);
  });

  it('refuses non-images and files whose bytes are not the claimed image type', async () => {
    expect((await get(path.join(tmp, 'notes.txt'))).status).toBe(415);
    expect((await get(path.join(tmp, 'secret.png'))).status).toBe(415);
    expect((await get('relative/shot.png')).status).toBe(400);
  });
});

describe('localImageUrl', () => {
  it('routes absolute host paths through the image route and leaves URLs alone', () => {
    expect(localImageUrl('/tmp/a%20b.png')).toBe('/api/images?path=%2Ftmp%2Fa%20b.png');
    expect(localImageUrl('https://example.com/x.png')).toBe('https://example.com/x.png');
    expect(localImageUrl('/api/images?path=x')).toBe('/api/images?path=x');
    expect(localImageUrl('//cdn.example.com/x.png')).toBe('//cdn.example.com/x.png');
  });
});
