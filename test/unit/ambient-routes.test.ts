import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAmbientRoutes } from '../../src/routes/ambient.routes.js';

describe('POST /ambient-watch/refresh', () => {
  let server: Server | undefined;

  async function listen(fetchUpstream: typeof fetch): Promise<string> {
    const app = express();
    app.use(createAmbientRoutes({ fetchUpstream }));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it('answers only after a successful watcher scan', async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    const baseUrl = await listen(upstream);

    const response = await fetch(`${baseUrl}/ambient-watch/refresh`, { method: 'POST' });

    expect(response.status).toBe(204);
    expect(upstream).toHaveBeenCalledWith(
      'http://127.0.0.1:43117/refresh',
      { method: 'POST' },
    );
  });

  it('propagates a watcher scan failure instead of reporting success', async () => {
    const upstream = vi.fn(
      async () => new Response('{"error":"ambient scan failed"}', { status: 502 }),
    ) as typeof fetch;
    const baseUrl = await listen(upstream);

    const response = await fetch(`${baseUrl}/ambient-watch/refresh`, { method: 'POST' });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'ambient scan refresh failed' });
  });

  it('reports an unreachable watcher as a failure', async () => {
    const upstream = vi.fn(async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const baseUrl = await listen(upstream);

    const response = await fetch(`${baseUrl}/ambient-watch/refresh`, { method: 'POST' });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'ambient watcher is not reachable' });
  });
});
