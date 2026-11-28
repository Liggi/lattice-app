/**
 * Images agents save under /tmp: a copy is kept under the config dir when one
 * is served or listed, refreshed when the original changes, and served once
 * the original has been cleared away.
 */

import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImageRoutes } from '../../src/routes/system/image.routes.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { cachedImagePath, findCachedImage, isTempPath, persistTempImage } from '../../src/services/images/temp-image-cache.js';
import { imageStillShown, outputsFromEvents } from '../../src/services/sessions/conversation-outputs.js';
import type { RawEvent } from '../../src/session-history/types.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PNG2 = Buffer.concat([PNG, Buffer.from('redrawn')]);
const PHONE = Buffer.concat([PNG, Buffer.from('phone')]);

let tmp: string;
let cacheDir: string;
let opts: { cacheDir: string };

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-image-cache-'));
  cacheDir = fs.mkdtempSync(path.join(os.homedir(), '.tmp-image-cache-store-'));
  opts = { cacheDir };
});
afterAll(() => {
  for (const d of [tmp, cacheDir]) fs.rmSync(d, { recursive: true, force: true });
});

describe('temp image cache', () => {
  it('treats /private/tmp and /tmp as one path', () => {
    expect(isTempPath('/tmp/a.png')).toBe(true);
    expect(isTempPath('/private/tmp/a.png')).toBe(true);
    expect(isTempPath(path.join(os.homedir(), 'a.png'))).toBe(false);
    expect(cachedImagePath('/private/tmp/a.png', opts)).toBe(cachedImagePath('/tmp/a.png', opts));
    expect(cachedImagePath('/tmp/a.txt', opts)).toBeNull();
  });

  it('keeps a copy, refreshes it when the original is newer, and keeps the phone layout beside it', () => {
    const file = path.join(tmp, 'shot.png');
    const past = new Date(Date.now() - 60_000);
    fs.writeFileSync(file, PNG);
    fs.utimesSync(file, past, past);
    fs.writeFileSync(path.join(tmp, 'shot.phone.png'), PHONE);

    const kept = persistTempImage(file, opts)!;
    expect(kept.startsWith(cacheDir)).toBe(true);
    expect(fs.readFileSync(kept).equals(PNG)).toBe(true);
    expect(fs.readFileSync(findCachedImage(path.join(tmp, 'shot.phone.png'), opts)!).equals(PHONE)).toBe(true);

    fs.writeFileSync(file, PNG2);
    expect(fs.readFileSync(persistTempImage(file, opts)!).equals(PNG2)).toBe(true);
    expect(fs.readdirSync(cacheDir).some((f) => f.endsWith('.partial'))).toBe(false);
  });

  it('keeps nothing that is not really an image in a temp directory', () => {
    fs.writeFileSync(path.join(tmp, 'fake.png'), 'not a png');
    expect(persistTempImage(path.join(tmp, 'fake.png'), opts)).toBeNull();
    expect(persistTempImage(path.join(tmp, 'missing.png'), opts)).toBeNull();
    const outside = fs.mkdtempSync(path.join(os.homedir(), '.tmp-image-cache-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'private.png'), PNG);
      fs.symlinkSync(path.join(outside, 'private.png'), path.join(tmp, 'link.png'));
      expect(persistTempImage(path.join(tmp, 'link.png'), opts)).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('GET /api/images for a cleared temp image', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use('/api/images', createImageRoutes({ listWorkingDirectories: async () => [], listAgentImageRoots: () => [], tempImageCache: opts }));
    app.use(errorHandler);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/images?path=`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const get = (p: string, variant = '') => fetch(baseUrl + encodeURIComponent(p) + variant);

  it('serves the kept copy, and its phone layout, after the original is deleted', async () => {
    const file = path.join(tmp, 'fig.png');
    const past = new Date(Date.now() - 60_000);
    fs.writeFileSync(file, PNG);
    fs.utimesSync(file, past, past);
    fs.writeFileSync(path.join(tmp, 'fig.phone.png'), PHONE);
    expect((await get(file)).status).toBe(200);

    fs.rmSync(file);
    fs.rmSync(path.join(tmp, 'fig.phone.png'));
    const res = await get(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    const phone = await get(file, '&variant=phone');
    expect(Buffer.from(await phone.arrayBuffer()).equals(PHONE)).toBe(true);
  });

  it('serves the redrawn image after the original changes and is then deleted', async () => {
    const file = path.join(tmp, 'redraw.png');
    const past = new Date(Date.now() - 60_000);
    fs.writeFileSync(file, PNG);
    fs.utimesSync(file, past, past);
    await get(file);
    fs.writeFileSync(file, PNG2);
    await get(file);
    fs.rmSync(file);
    expect(Buffer.from(await (await get(file)).arrayBuffer()).equals(PNG2)).toBe(true);
  });

  it('still checks a kept copy is an image and 404s when there is none', async () => {
    const file = path.join(tmp, 'tampered.png');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachedImagePath(file, opts)!, 'not a png');
    expect((await get(file)).status).toBe(415);
    expect((await get(path.join(tmp, 'never-was.png'))).status).toBe(404);
  });
});

describe('outputs with cleared images', () => {
  const content = (seq: number, text: string) =>
    ({ seq, type: 'content', data: { messageId: `m${seq}`, blocks: [{ type: 'text', text }] } }) as unknown as RawEvent;

  it('drops dead images before they take a slot, so older live ones surface', () => {
    const live = (n: number) => path.join(tmp, `live-${n}.png`);
    for (const n of [1, 2, 3, 4]) fs.writeFileSync(live(n), PNG);
    const events = [
      content(9, `![dead](${path.join(tmp, 'dead-a.png')}) ![dead](${path.join(tmp, 'dead-b.png')})`),
      content(8, `![one](${live(1)}) ![two](${live(2)})`),
      content(7, `![three](${live(3)}) ![four](${live(4)})`),
    ];
    const outputs = outputsFromEvents(events, undefined, { acceptImage: (p) => imageStillShown(p, opts) });
    expect(outputs.images.map((image) => image.path)).toEqual([live(1), live(2), live(3), live(4)]);
    // Without a check every image is listed, as the browser-side reader does.
    expect(outputsFromEvents(events).images.map((image) => image.caption)).toEqual(['dead', 'dead', 'one', 'two']);
  });

  it('keeps a listed temp image so it is still shown after the original is cleared', () => {
    const file = path.join(tmp, 'listed.png');
    fs.writeFileSync(file, PNG);
    expect(imageStillShown(file, opts)).toBe(true);
    fs.rmSync(file);
    expect(imageStillShown(file, opts)).toBe(true);
    expect(imageStillShown(path.join(tmp, 'never-listed.png'), opts)).toBe(false);
  });

  it('accepts an image outside a temp directory only while it is on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.homedir(), '.tmp-image-cache-work-'));
    try {
      fs.writeFileSync(path.join(dir, 'repo.png'), PNG);
      expect(imageStillShown(path.join(dir, 'repo.png'), opts)).toBe(true);
      expect(imageStillShown(path.join(dir, 'gone.png'), opts)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
