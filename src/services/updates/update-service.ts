/**
 * Telling a running Lattice about newer releases of the lattice-app package,
 * and installing one in place.
 *
 * Once a day the server asks the npm registry for lattice-app's latest version;
 * the request carries nothing about this install. An update runs
 * `npm install -g` into the prefix this copy was installed in, checks that the
 * new copy's native modules load on this Node, then restarts the server into
 * the new code in the same process (process.execve), so a terminal, tmux or a
 * service manager keeps holding it. Installs that npm -g did not make (npx, a
 * source checkout, pnpm) are only told the command to run.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import semver from 'semver';
import { createLogger } from '../infrastructure/logger.js';
import { parseJson } from '@/utils/json.js';
import type { InstallInfo, ReleaseNote, UpdateStatus } from '@/types/update.js';

const logger = createLogger('UpdateService');

const PACKAGE = 'lattice-app';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const PREVIEW_INSTALL_MS = 2_500;

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

function readVersion(root = packageRoot): string {
  const raw = parseJson(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version?: unknown };
  return typeof raw.version === 'string' ? raw.version : '0.0.0';
}

function repoSlug(): string | null {
  try {
    const raw = parseJson(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')) as { repository?: { url?: unknown } };
    const url = typeof raw.repository?.url === 'string' ? raw.repository.url : '';
    return /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

function registryUrl(): string {
  const configured = process.env.npm_config_registry || 'https://registry.npmjs.org/';
  return configured.endsWith('/') ? configured : `${configured}/`;
}

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The npm beside the running node, so the install builds native modules for this Node. */
function npmBin(): string {
  const beside = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(beside) ? beside : 'npm';
}

/** Where `npm install -g` put this copy, or null if it wasn't npm -g. */
function npmGlobalPrefix(root: string): string | null {
  const nodeModules = path.dirname(root);
  const lib = path.dirname(nodeModules);
  if (path.basename(root) !== PACKAGE || path.basename(nodeModules) !== 'node_modules' || path.basename(lib) !== 'lib') {
    return null;
  }
  const prefix = path.dirname(lib);
  try {
    const bin = fs.realpathSync(path.join(prefix, 'bin', PACKAGE));
    return bin === fs.realpathSync(path.join(root, 'dist', 'cli.js')) ? prefix : null;
  } catch {
    return null;
  }
}

export function detectInstall(root = packageRoot): InstallInfo & { prefix: string | null } {
  const parts = root.split(path.sep);
  if (!parts.includes('node_modules')) {
    return { kind: 'source', canUpdate: false, command: null, reason: null, prefix: null };
  }
  if (parts.includes('_npx')) {
    return {
      kind: 'npx',
      canUpdate: false,
      command: `npx ${PACKAGE}@latest`,
      reason: 'Lattice is running through npx. Stop it and start it again with this command.',
      prefix: null,
    };
  }
  const manual = `npm install -g ${PACKAGE}@latest`;
  const prefix = npmGlobalPrefix(root);
  if (!prefix) {
    return {
      kind: 'other',
      canUpdate: false,
      command: manual,
      reason: "Lattice wasn't installed with npm install -g, so it can't update itself. Update it the way you installed it, then restart it. With npm:",
      prefix: null,
    };
  }
  if (!isWritable(path.dirname(root)) || !isWritable(path.join(prefix, 'bin'))) {
    return {
      kind: 'npm-global',
      canUpdate: false,
      command: manual,
      reason: `Lattice can't write to ${path.dirname(root)}. Run this yourself (it may need sudo), then restart Lattice:`,
      prefix,
    };
  }
  if (typeof process.execve !== 'function') {
    return {
      kind: 'npm-global',
      canUpdate: false,
      command: manual,
      reason: `Node ${process.version} can't restart Lattice in place (that needs Node 22.15 or newer). Run this, then restart Lattice:`,
      prefix,
    };
  }
  return { kind: 'npm-global', canUpdate: true, command: manual, reason: null, prefix };
}

interface RunResult { code: number | null; output: string }

function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    // node's own folder first, so npm and any install scripts run on this Node.
    const env = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    };
    let output = '';
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      output += `\nStopped after ${Math.round(timeoutMs / 1000)}s without finishing.`;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Loads the new copy's native modules on this Node, the part most likely to break across versions. */
const NATIVE_SMOKE = `
const { createRequire } = require('module');
const req = createRequire(process.argv[1] + '/package.json');
new (req('better-sqlite3'))(':memory:').close();
req('node-pty');
req('sharp');
`;

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json() as Promise<unknown>;
}

const PREVIEW_NOTES = (version: string): ReleaseNote[] => [{
  version,
  name: `Lattice ${version}`,
  body: [
    'Preview notes: this Lattice was started with LATTICE_UPDATE_PREVIEW, and these lines stand in for a real release.',
    '',
    '- A running Lattice tells you when a new version is out, and Update installs it and restarts.',
    '- Workers wait on each other without polling.',
    '- The sidebar keeps its order while sessions work.',
  ].join('\n'),
  url: `https://github.com/${repoSlug() ?? 'Liggi/lattice-app'}/releases`,
  publishedAt: new Date().toISOString(),
}];

type RestartHandler = () => Promise<void>;

class UpdateService {
  private readonly current = readVersion();
  private readonly preview = process.env.LATTICE_UPDATE_PREVIEW || null;
  private readonly install = detectInstall();
  private latest: string | null = null;
  private checkedAt: Date | null = null;
  private phase: UpdateStatus['phase'] = 'idle';
  private error: UpdateStatus['error'] = null;
  private notes: { version: string; notes: ReleaseNote[] } | null = null;
  private restartHandler: RestartHandler | null = null;
  private timer: NodeJS.Timeout | null = null;

  setRestartHandler(handler: RestartHandler): void {
    this.restartHandler = handler;
  }

  /** Checks shortly after boot and then daily; a source checkout never checks. */
  start(): void {
    if (this.preview || this.install.kind === 'source' || this.timer) return;
    const tick = () => { void this.check(); };
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, CHECK_INTERVAL_MS);
      this.timer.unref();
    }, FIRST_CHECK_DELAY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    try {
      const body = await fetchJson(`${registryUrl()}${PACKAGE}/latest`) as { version?: unknown };
      const version = typeof body.version === 'string' ? body.version : null;
      this.checkedAt = new Date();
      this.latest = version && semver.valid(version) && !semver.prerelease(version) && semver.gt(version, this.current)
        ? version
        : null;
      logger.info('Checked for a newer Lattice', { current: this.current, published: version, newer: this.latest });
    } catch (err) {
      logger.warn('Could not check for a newer Lattice', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  status(): UpdateStatus {
    const { prefix: _prefix, ...install } = this.install;
    const preview = this.preview !== null;
    return {
      current: this.current,
      latest: preview ? this.preview : this.latest,
      checkedAt: this.checkedAt?.toISOString() ?? null,
      install: preview ? { kind: 'npm-global', canUpdate: true, command: `npm install -g ${PACKAGE}@latest`, reason: null } : install,
      phase: this.phase,
      error: this.error,
      preview,
    };
  }

  /** GitHub release notes for every version after this one up to the latest. */
  async releaseNotes(): Promise<ReleaseNote[]> {
    const latest = this.status().latest;
    if (!latest) return [];
    if (this.preview) return PREVIEW_NOTES(latest);
    if (this.notes?.version === latest) return this.notes.notes;
    const slug = repoSlug();
    if (!slug) return [];
    const releases = await fetchJson(`https://api.github.com/repos/${slug}/releases?per_page=30`, {
      accept: 'application/vnd.github+json',
    }) as Array<{ tag_name?: string; name?: string | null; body?: string | null; html_url?: string; published_at?: string | null; draft?: boolean }>;
    const notes = releases
      .filter((r) => !r.draft)
      .map((r) => ({ r, version: semver.valid(semver.clean(r.tag_name ?? '')) }))
      .filter((x): x is { r: typeof x.r; version: string } =>
        x.version !== null && semver.gt(x.version, this.current) && semver.lte(x.version, latest))
      .sort((a, b) => semver.rcompare(a.version, b.version))
      .map(({ r, version }) => ({
        version,
        name: r.name || `Lattice ${version}`,
        body: r.body ?? '',
        url: r.html_url ?? `https://github.com/${slug}/releases`,
        publishedAt: r.published_at ?? null,
      }));
    this.notes = { version: latest, notes };
    return notes;
  }

  /** Starts the update; progress is read back through status(). */
  startUpdate(): { ok: true } | { ok: false; message: string } {
    const { latest, install } = this.status();
    if (!latest) return { ok: false, message: 'There is no newer version to install.' };
    if (!install.canUpdate) return { ok: false, message: install.reason ?? 'This install cannot update itself.' };
    if (this.phase === 'installing' || this.phase === 'restarting') return { ok: false, message: 'An update is already running.' };
    this.phase = 'installing';
    this.error = null;
    void (this.preview ? this.runPreview() : this.runUpdate(latest)).catch((err: unknown) => {
      this.fail('The update stopped with an unexpected error. Lattice is still running.', err instanceof Error ? err.stack ?? err.message : String(err));
    });
    return { ok: true };
  }

  private fail(message: string, output: string): void {
    logger.error('Lattice update failed', { message, output });
    this.phase = 'failed';
    this.error = { message, output };
  }

  private async runPreview(): Promise<void> {
    await new Promise((r) => setTimeout(r, PREVIEW_INSTALL_MS));
    this.fail('Preview only: nothing was installed. This Lattice was started with LATTICE_UPDATE_PREVIEW.', '');
  }

  private async runUpdate(target: string): Promise<void> {
    const prefix = this.install.prefix!;
    const npm = npmBin();
    const installArgs = (version: string) => ['install', '--global', '--prefix', prefix, `${PACKAGE}@${version}`];
    logger.info('Installing Lattice update', { from: this.current, to: target, npm, prefix });

    const installed = await run(npm, installArgs(target), INSTALL_TIMEOUT_MS);
    const onDisk = readVersion();
    if (installed.code !== 0 || onDisk !== target) {
      const where = onDisk === this.current
        ? `Nothing changed: Lattice ${this.current} is still installed and running.`
        : `The files on disk are now ${onDisk} while ${this.current} is running. Run ${this.install.command} and restart Lattice.`;
      this.fail(`npm could not install ${target}. ${where}`, installed.output);
      return;
    }

    const smoke = await run(process.execPath, ['-e', NATIVE_SMOKE, packageRoot], 60_000);
    if (smoke.code !== 0) {
      const back = await run(npm, installArgs(this.current), INSTALL_TIMEOUT_MS);
      const recheck = back.code === 0 && readVersion() === this.current
        ? await run(process.execPath, ['-e', NATIVE_SMOKE, packageRoot], 60_000)
        : null;
      const restored = recheck?.code === 0;
      this.fail(
        `${target} installed but can't run on Node ${process.version}. ` + (restored
          ? `Lattice put ${this.current} back and is still running it.`
          : `Putting ${this.current} back did not work either: the files on disk are ${readVersion()}${recheck ? ' and do not load' : ''}. Run npm install -g ${PACKAGE}@${this.current} before restarting Lattice.`),
        [smoke.output, back.output, recheck?.output ?? ''].filter(Boolean).join('\n'),
      );
      return;
    }

    if (!this.restartHandler) {
      this.fail(`${target} is installed, but this server can't restart itself. Restart Lattice to finish.`, installed.output);
      return;
    }
    logger.info('Lattice update installed; restarting', { to: target });
    this.phase = 'restarting';
    // Long enough for a status poll to see 'restarting' before the server goes.
    setTimeout(() => { void this.restartHandler!(); }, 1_000);
  }
}

let instance: UpdateService | null = null;

export function getUpdateService(): UpdateService {
  instance ??= new UpdateService();
  return instance;
}
