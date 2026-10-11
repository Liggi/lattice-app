/**
 * Plugins: packages named in `config.json`'s `plugins`, installed under
 * `<config dir>/plugins/node_modules`, each with a `lattice` field in its
 * package.json (`@liggi/lattice-plugin-kit` has the contract).
 *
 * A plugin's server entry is imported at startup and its default export is
 * called with a host: a router mounted at `/api/plugins/<id>`, a data folder,
 * agent commands, new sessions and confirm cards. Its web entry is served to
 * the web app, which imports it at runtime (`web/chat/plugins`).
 *
 * A plugin runs with all of Lattice's access, so nothing is loaded that the
 * config does not name, and only from the config dir: never from a project
 * or working directory an agent writes to. One that fails to load is logged,
 * listed with its error, and skipped; Lattice runs on without it.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { Router } from 'express';
import type {
  LatticePluginCommandInput,
  LatticePluginHost,
  LatticePluginManifest,
} from '@liggi/lattice-plugin-kit';
import { CONFIG_DIR } from '@/utils/constants.js';
import { parseJson } from '@/utils/json.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { latticeCli } from '@/services/sessions/pickup-prompts.js';
import { askPluginConfirm } from './plugin-confirm.js';
import { createPluginSession } from './plugin-sessions.js';

const logger = createLogger('Plugins');

export const PLUGIN_API_VERSION = 1;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

type CommandHandler = (input: LatticePluginCommandInput) => string | Promise<string>;
type ConfirmHandler = (payload: unknown, context: { conversationId: string; cardId: string }) => string | Promise<string>;

/** What Settings and the web app are told about a plugin. */
export interface PluginInfo {
  /** The name in config.json. */
  name: string;
  id: string | null;
  version: string | null;
  status: 'loaded' | 'failed';
  error?: string;
  web: boolean;
  css: boolean;
}

interface LoadedPlugin {
  info: PluginInfo;
  dir: string;
  manifest: LatticePluginManifest | null;
  router: Router;
  commands: Map<string, CommandHandler>;
  confirmHandlers: Map<string, ConfirmHandler>;
  stoppers: Array<() => void | Promise<void>>;
}

const plugins = new Map<string, LoadedPlugin>();
let listed: PluginInfo[] = [];

export function pluginsDir(): string {
  return path.join(CONFIG_DIR, 'plugins');
}

function pluginDataDir(id: string): string {
  return path.join(CONFIG_DIR, 'plugin-data', id);
}

/** A package name, resolved inside `<config dir>/plugins/node_modules` and refused if it leads out of it. */
function packageDir(name: string): string {
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) {
    throw new Error(`"${name}" is not a package name. Install the plugin into ${pluginsDir()} and name its package.`);
  }
  return path.join(pluginsDir(), 'node_modules', name);
}

function readManifest(dir: string): { manifest: LatticePluginManifest; version: string | null } {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist.`);
  const pkg = parseJson(fs.readFileSync(file, 'utf-8')) as { version?: string; lattice?: Partial<LatticePluginManifest> };
  const manifest = pkg.lattice;
  if (!manifest || typeof manifest !== 'object') throw new Error('Its package.json has no "lattice" field, so it is not a Lattice plugin.');
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) throw new Error(`Its id "${String(manifest.id)}" must be lowercase letters, digits and dashes.`);
  if (manifest.api !== PLUGIN_API_VERSION) throw new Error(`It was built for plugin API ${String(manifest.api)}; this Lattice has API ${PLUGIN_API_VERSION}.`);
  for (const key of ['server', 'web', 'css'] as const) {
    const entry = manifest[key];
    if (entry === undefined) continue;
    if (typeof entry !== 'string' || !isInside(dir, path.resolve(dir, entry))) throw new Error(`Its "${key}" entry must be a path inside the package.`);
  }
  return { manifest: manifest as LatticePluginManifest, version: typeof pkg.version === 'string' ? pkg.version : null };
}

function isInside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function makeHost(plugin: LoadedPlugin, id: string): LatticePluginHost {
  const log = createLogger(`plugin:${id}`);
  return {
    id,
    dataDir: pluginDataDir(id),
    log: {
      debug: (message, meta) => log.debug(message, meta),
      info: (message, meta) => log.info(message, meta),
      warn: (message, meta) => log.warn(message, meta),
      error: (message, meta) => log.error(message, meta),
    },
    router: plugin.router,
    onStop: (fn) => { plugin.stoppers.push(fn); },
    command: (name, handler) => { plugin.commands.set(name, handler); },
    get cli() { return latticeCli(); },
    sessions: { create: (opts) => createPluginSession(opts) },
    confirm: {
      ask: (conversationId, card, action) => askPluginConfirm(id, conversationId, card, action),
      handle: (name, fn) => { plugin.confirmHandlers.set(name, fn); },
    },
  };
}

async function loadOne(name: string): Promise<LoadedPlugin> {
  const plugin: LoadedPlugin = {
    info: { name, id: null, version: null, status: 'failed', web: false, css: false },
    dir: '',
    manifest: null,
    router: Router(),
    commands: new Map(),
    confirmHandlers: new Map(),
    stoppers: [],
  };
  try {
    const installed = packageDir(name);
    if (!fs.existsSync(installed)) throw new Error(`Not installed: ${installed} does not exist.`);
    plugin.dir = fs.realpathSync(installed);
    const { manifest, version } = readManifest(plugin.dir);
    if (plugins.has(manifest.id)) throw new Error(`Another plugin already has the id "${manifest.id}".`);
    plugin.manifest = manifest;
    plugin.info = { ...plugin.info, id: manifest.id, version, web: Boolean(manifest.web), css: Boolean(manifest.css) };
    fs.mkdirSync(pluginDataDir(manifest.id), { recursive: true });
    if (manifest.server) {
      const mod = await import(pathToFileURL(path.resolve(plugin.dir, manifest.server)).href) as { default?: unknown };
      if (typeof mod.default !== 'function') throw new Error(`Its server entry ${manifest.server} has no default export function.`);
      await (mod.default as (host: LatticePluginHost) => unknown)(makeHost(plugin, manifest.id));
    }
    plugin.info.status = 'loaded';
    logger.info('Plugin loaded', { name, id: manifest.id, version });
  } catch (error) {
    plugin.info.error = error instanceof Error ? error.message : String(error);
    logger.error('Plugin failed to load; Lattice carries on without it', { name, error: plugin.info.error });
  }
  return plugin;
}

/** Loads every plugin config.json names, in order. Called once, before routes are registered. */
export async function loadPlugins(names: readonly string[] | undefined): Promise<void> {
  listed = [];
  for (const name of names ?? []) {
    const plugin = await loadOne(name);
    listed.push(plugin.info);
    if (plugin.info.status === 'loaded' && plugin.manifest) plugins.set(plugin.manifest.id, plugin);
  }
}

export function listPlugins(): PluginInfo[] {
  return listed;
}

export function getPlugin(id: string): LoadedPlugin | undefined {
  return plugins.get(id);
}

/** The file a plugin's web entry or stylesheet names, or null. */
export function pluginAsset(id: string, kind: 'web' | 'css'): string | null {
  const plugin = plugins.get(id);
  const entry = plugin?.manifest?.[kind];
  return plugin && entry ? path.resolve(plugin.dir, entry) : null;
}

export function pluginConfirmHandler(id: string, name: string): ConfirmHandler | undefined {
  return plugins.get(id)?.confirmHandlers.get(name);
}

export async function stopPlugins(): Promise<void> {
  for (const plugin of plugins.values()) {
    for (const stop of plugin.stoppers) {
      try {
        await stop();
      } catch (error) {
        logger.warn('A plugin failed to stop cleanly', { id: plugin.manifest?.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  plugins.clear();
}
