import fs from 'fs';
import path from 'path';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_DIR } from '../../src/utils/constants.js';
import { listPlugins, loadPlugins, stopPlugins } from '../../src/services/plugins/plugin-registry.js';
import { createPluginsRoutes } from '../../src/routes/system/plugins.routes.js';

const repo = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(repo, 'test/fixtures/plugins/hello-plugin');

/** Installs a package.json (and optionally a build) as `<config dir>/plugins/node_modules/<name>`. */
function install(name: string, pkg: object): string {
  const dir = path.join(CONFIG_DIR, 'plugins', 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

describe('plugins', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const dir = install('hello-plugin', JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf-8')) as object);
    const { buildLatticePlugin } = await import('../../packages/plugin-kit/src/build.mjs') as {
      buildLatticePlugin: (opts: Record<string, string>) => Promise<void>;
    };
    await buildLatticePlugin({ root: fixture, server: 'src/server.ts', web: 'src/web.tsx', css: 'src/web.css', outdir: path.join(dir, 'dist') });
    install('wrong-api', { name: 'wrong-api', version: '0.1.0', lattice: { id: 'wrong', api: 2 } });
    install('escapes', { name: 'escapes', lattice: { id: 'escapes', api: 1, server: '../../../outside.js' } });

    await loadPlugins(['hello-plugin', 'wrong-api', 'not-installed', '../../etc', 'escapes']);

    const app = express();
    app.use(express.json());
    app.use('/api/plugins', createPluginsRoutes());
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plugins`;
  }, 60_000);

  afterAll(async () => {
    await stopPlugins();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('loads what config names from the config dir, and lists every failure with its reason', () => {
    const byName = new Map(listPlugins().map((plugin) => [plugin.name, plugin]));
    expect(byName.get('hello-plugin')).toMatchObject({ id: 'hello', version: '1.0.0', status: 'loaded', web: true, css: true });
    expect(byName.get('wrong-api')).toMatchObject({ status: 'failed', error: expect.stringContaining('plugin API 2') });
    expect(byName.get('not-installed')).toMatchObject({ status: 'failed', error: expect.stringContaining('Not installed') });
    expect(byName.get('../../etc')).toMatchObject({ status: 'failed', error: expect.stringContaining('is not a package name') });
    expect(byName.get('escapes')).toMatchObject({ status: 'failed', error: expect.stringContaining('inside the package') });
    expect(fs.existsSync(path.join(CONFIG_DIR, 'plugin-data', 'hello'))).toBe(true);
  });

  it('mounts the plugin\'s router under its id, with state in its data folder', async () => {
    expect(await (await fetch(`${base}/hello/count`)).json()).toEqual({ count: 0 });
    expect(await (await fetch(`${base}/hello/bump`, { method: 'POST' })).json()).toEqual({ count: 1 });
    expect(fs.readFileSync(path.join(CONFIG_DIR, 'plugin-data', 'hello', 'count.json'), 'utf-8')).toBe('1');
    expect((await fetch(`${base}/wrong/count`)).status).toBe(404);
  });

  it('serves a web entry that uses the host\'s React instead of bundling its own', async () => {
    const web = await fetch(`${base}/hello/assets/web.js`);
    expect(web.status).toBe(200);
    const code = await web.text();
    expect(code).toContain('__latticePluginHost');
    expect(code).not.toContain('__SECRET_INTERNALS');
    expect(code.length).toBeLessThan(10_000);
    const css = await (await fetch(`${base}/hello/assets/web.css`)).text();
    expect(css).toContain('var(--color-surface-2)');
    // Scoped to the plugin's page, and nothing on :root, where it would override Lattice's own rules and variables.
    expect(css).not.toContain(':root');
    expect(css).toContain('[data-lattice-plugin] .flex{');
    expect(css).not.toMatch(/(^|[{}])\.flex\{/);
  });

  it('refuses a browser request from another site', async () => {
    const response = await fetch(`${base}/hello/count`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(response.status).toBe(403);
  });

  it('passes an agent\'s command to the plugin and its error back', async () => {
    const post = (body: object) => fetch(`${base}/hello/commands/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ args: {}, text: 'x' })).status).toBe(400);
    const empty = await post({ session: 'conv-x', args: {}, text: '  ' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'Pipe the note on standard input.' });
    expect((await fetch(`${base}/hello/commands/nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"session":"conv-x"}' })).status).toBe(404);
  });

  it('keeps the kit\'s theme names the same as the host\'s', () => {
    const block = (css: string) => css.slice(css.indexOf('@theme inline {'), css.indexOf('\n}\n', css.indexOf('@theme inline {')) + 2);
    const host = block(fs.readFileSync(path.join(repo, 'src/web/styles/index.css'), 'utf-8'));
    const kit = block(fs.readFileSync(path.join(repo, 'packages/plugin-kit/theme.css'), 'utf-8'));
    expect(host.length).toBeGreaterThan(100);
    expect(kit).toBe(host);
  });
});
