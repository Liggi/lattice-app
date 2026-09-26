/**
 * The Claude sign-in routes, over a real listening Express server.
 *
 * Three things are pinned here. The relay routes that took an authorization
 * code are gone. Every terminal route refuses a page from another site. And
 * the screen stream replays what the terminal showed, then cuts over to live
 * chunks by offset, so a reconnecting phone sees each character once.
 */

import express from 'express';
import { EventEmitter } from 'events';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/provider-auth-service.js', () => ({
  getProviderAuthService: () => ({ getClaudeAuthStatus: async () => ({ available: true, installed: true, status: { loggedIn: false } }) }),
}));

import { createProviderAuthRoutes } from '../../src/routes/integrations/provider-auth.routes.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import type { ProcessManagerClient } from '../../src/process-daemon/process-manager-client.js';

const ATTEMPT = '11111111-2222-4333-8444-555555555555';

class FakeDaemon extends EventEmitter {
  connected = true;
  attachResult = { state: { phase: 'running', startedAt: 1, expiresAt: 2 }, output: 'Opening browser', outputEnd: 15 };
  inputs: Array<{ clientId: string; seq: number; data: string }> = [];
  started: Array<Record<string, unknown>> = [];
  cancelled: string[] = [];
  attachDelay: (() => void) | null = null;

  isConnected(): boolean { return this.connected; }
  async startLoginTerminal(params: Record<string, unknown>): Promise<unknown> {
    this.started.push(params);
    return { attemptId: ATTEMPT, state: this.attachResult.state, reused: false };
  }
  async attachLoginTerminal(): Promise<unknown> {
    if (this.attachDelay) await new Promise<void>((resolve) => { this.attachDelay = resolve; });
    return this.attachResult;
  }
  async sendLoginTerminalInput(_attemptId: string, clientId: string, seq: number, data: string): Promise<unknown> {
    this.inputs.push({ clientId, seq, data });
    return { accepted: true, lastSeq: seq };
  }
  async resizeLoginTerminal(): Promise<void> {}
  async getLoginTerminalState(): Promise<unknown> { return this.attachResult.state; }
  async cancelLoginTerminal(attemptId: string): Promise<boolean> { this.cancelled.push(attemptId); return true; }
}

let server: Server;
let baseUrl: string;
let daemon: FakeDaemon;

beforeEach(async () => {
  daemon = new FakeDaemon();
  const app = express();
  app.use(express.json());
  app.use('/api/provider-auth', createProviderAuthRoutes({ processManagerClient: daemon as unknown as ProcessManagerClient }));
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'No such endpoint' }); });
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/provider-auth`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const SAME_SITE = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

async function post(path: string, body: unknown, headers: Record<string, string> = SAME_SITE): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('Claude sign-in routes', () => {
  it('no longer offers a login relay or a place to hand in an authorization code', async () => {
    const login = await post('/claude/login', {});
    const exchange = await post('/claude/exchange', { sessionId: 'x', code: 'MARKER-code' });
    expect(login.status).toBe(404);
    expect(exchange.status).toBe(404);
  });

  it('starts the terminal for the page itself and refuses a page from another site', async () => {
    const ok = await post('/claude/login-terminal', { cols: 60, rows: 20 });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { attemptId: string }).attemptId).toBe(ATTEMPT);
    expect(daemon.started[0]).toEqual({ size: { cols: 60, rows: 20 }, restart: false });

    const crossSite = await post('/claude/login-terminal', {}, { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json() as { code: string }).code).toBe('CROSS_ORIGIN_REFUSED');

    // An older browser sends only Origin; a mismatch with Host is the same refusal.
    const foreignOrigin = await post('/claude/login-terminal', {}, { 'Content-Type': 'application/json', Origin: 'https://evil.example' });
    expect(foreignOrigin.status).toBe(403);
    expect(daemon.started).toHaveLength(1);
  });

  it('forwards keystrokes with their client and sequence, and refuses them cross-site', async () => {
    const ok = await post(`/claude/login-terminal/${ATTEMPT}/input`, { clientId: 'phone', seq: 3, data: 'MARKER-code\r' });
    expect(ok.status).toBe(200);
    expect(daemon.inputs).toEqual([{ clientId: 'phone', seq: 3, data: 'MARKER-code\r' }]);

    const bad = await post(`/claude/login-terminal/${ATTEMPT}/input`, { seq: 3, data: 'x' });
    expect(bad.status).toBe(400);

    const crossSite = await post(`/claude/login-terminal/${ATTEMPT}/input`, { clientId: 'p', seq: 4, data: 'y' }, { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    expect(daemon.inputs).toHaveLength(1);

    const badId = await post('/claude/login-terminal/not-an-id/input', { clientId: 'p', seq: 1, data: 'y' });
    expect(badId.status).toBe(400);
  });

  it('streams the replay, then only the live chunks the replay did not cover', async () => {
    daemon.attachDelay = () => {};
    const response = await fetch(`${baseUrl}/claude/login-terminal/${ATTEMPT}/stream`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    // Output arrives while the attach request is still in flight: one chunk the
    // replay already contains, one it does not.
    daemon.emit('login-terminal-output', { attemptId: ATTEMPT, data: 'browser', offset: 8 });
    daemon.emit('login-terminal-output', { attemptId: ATTEMPT, data: '…', offset: 15 });
    daemon.emit('login-terminal-output', { attemptId: 'other-attempt', data: 'NOT MINE', offset: 0 });
    daemon.attachDelay!();

    const reader = response.body!.getReader();
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('event: state')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    daemon.emit('login-terminal-output', { attemptId: ATTEMPT, data: '\nPaste code here > ', offset: 16 });
    daemon.emit('login-terminal-state', { attemptId: ATTEMPT, state: { phase: 'succeeded', startedAt: 1, endedAt: 3 } });
    while (!text.includes('"succeeded"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    const events = text.split('\n\n').filter(Boolean).map((block) => {
      const event = /event: (\w+)/.exec(block)?.[1];
      const data = /data: (.*)/.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
    expect(events).toEqual([
      { event: 'replay', data: { data: 'Opening browser' } },
      { event: 'output', data: { data: '…' } },
      { event: 'state', data: { phase: 'running', startedAt: 1, expiresAt: 2 } },
      { event: 'output', data: { data: '\nPaste code here > ' } },
      { event: 'state', data: { phase: 'succeeded', startedAt: 1, endedAt: 3 } },
    ]);
  });

  it('says the daemon is missing rather than failing generically, and cancels through it', async () => {
    const cancelled = await fetch(`${baseUrl}/claude/login-terminal/${ATTEMPT}`, { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(await cancelled.json()).toEqual({ cancelled: true });
    expect(daemon.cancelled).toEqual([ATTEMPT]);

    daemon.connected = false;
    const response = await post('/claude/login-terminal', {});
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toContain('daemon');
  });
});
