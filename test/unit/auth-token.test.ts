/**
 * With `server.authToken` set, the API takes the bearer header (CLI, hooks)
 * or the cookie the web app gets by entering the token once. Without a token
 * nothing is checked.
 */

import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const server = { authToken: undefined as string | undefined };
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: { getInstance: () => ({ getConfig: () => ({ server }) }) },
}));

const { createAuthMiddleware } = await import('../../src/middleware/auth-token.js');
const { createAuthRoutes } = await import('../../src/routes/system/auth.routes.js');

const TOKEN = 'secret-token-123';
const page = { 'sec-fetch-site': 'same-origin' };

describe('auth token', () => {
  let http: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(createAuthMiddleware());
    app.use('/api/auth', createAuthRoutes());
    app.get('/api/thing', (_req, res) => { res.json({ ok: true }); });
    http = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  beforeEach(() => { server.authToken = TOKEN; });

  const login = (token: string, headers: Record<string, string> = page) => fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token }),
  });

  it('checks nothing when no token is set', async () => {
    server.authToken = undefined;
    expect((await fetch(`${base}/api/thing`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/auth/status`)).json()).toEqual({ required: false, authenticated: true });
  });

  it('takes the bearer token and refuses a missing or wrong one', async () => {
    expect((await fetch(`${base}/api/thing`)).status).toBe(401);
    expect((await fetch(`${base}/api/thing`, { headers: { authorization: 'Bearer nope' } })).status).toBe(403);
    expect((await fetch(`${base}/api/thing`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it('trades the right token for a cookie the API then accepts from the page', async () => {
    expect(await (await fetch(`${base}/api/auth/status`, { headers: page })).json()).toEqual({ required: true, authenticated: false });

    const wrong = await login('wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();

    const right = await login(TOKEN);
    expect(right.status).toBe(200);
    const setCookie = right.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).not.toContain(TOKEN);
    const cookie = setCookie.split(';')[0];

    expect((await fetch(`${base}/api/thing`, { headers: { ...page, cookie } })).status).toBe(200);
    expect(await (await fetch(`${base}/api/auth/status`, { headers: { ...page, cookie } })).json()).toEqual({ required: true, authenticated: true });
    // Another site's page (or another port on this host) cannot ride the cookie.
    expect((await fetch(`${base}/api/thing`, { headers: { 'sec-fetch-site': 'same-site', cookie } })).status).toBe(401);
    // A new token signs the browser out.
    server.authToken = 'rotated';
    expect((await fetch(`${base}/api/thing`, { headers: { ...page, cookie } })).status).toBe(401);
  });

  it('refuses a sign-in posted from another site', async () => {
    expect((await login(TOKEN, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });
});
