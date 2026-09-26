/**
 * The `tail` helpers behind GET /logs/export each armed a 5s kill-and-resolve
 * watchdog that was never cleared when the child exited normally — which it
 * always does, in milliseconds. Six of them fired per export request.
 *
 * This drives the real Express route over supertest with HOME redirected, so
 * the `tail` children, the 'close' handlers and the watchdogs are the real
 * ones.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpHome: string;
let originalHome: string | undefined;
let originalConfigDir: string | undefined;

describe('GET /logs/export tail watchdogs', () => {
  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-log-routes-'));
    fs.mkdirSync(path.join(tmpHome, '.lattice', 'logs'), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // A Lattice session exports its own config dir, which would point the
    // route at that server's live log instead of this fixture's.
    originalConfigDir = process.env.LATTICE_CONFIG_DIR;
    process.env.LATTICE_CONFIG_DIR = path.join(tmpHome, '.lattice');
  });

  afterAll(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = originalConfigDir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(tmpHome, '.lattice', 'logs', 'server.jsonl'),
      JSON.stringify({ ts: now, level: 'info', msg: 'watchdog-fixture-line' }) + '\n',
    );
    fs.writeFileSync(
      path.join(tmpHome, 'lattice-debug.log'),
      `[${now}] [BROWSER] [info] watchdog-debug-line\n`,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves no armed timers behind after a successful export', async () => {
    vi.resetModules();
    const { createLogRoutes } = await import('../../src/routes/system/log.routes.js');

    const app = express();
    app.use('/api/logs', createLogRoutes());

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const before = vi.getTimerCount();

    const response = await request(app).get('/api/logs/export?minutes=60&includeDebug=true');

    expect(response.status).toBe(200);
    // Proves the children actually ran and their 'close' handlers resolved.
    expect(response.text).toContain('watchdog-fixture-line');
    expect(response.text).toContain('watchdog-debug-line');

    expect(vi.getTimerCount()).toBe(before);
  });

  it('raises the log stream listener ceiling above the default 10', async () => {
    vi.resetModules();
    const { createLogRoutes } = await import('../../src/routes/system/log.routes.js');
    const { logStreamBuffer } = await import('../../src/services/infrastructure/log-stream-buffer.js');

    expect(logStreamBuffer.getMaxListeners()).toBe(10);
    createLogRoutes();
    expect(logStreamBuffer.getMaxListeners()).toBe(100);
  });
});
