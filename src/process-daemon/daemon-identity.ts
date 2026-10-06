/**
 * What a daemon was started with: its code and the Claude settings it passes
 * to every agent.
 *
 * The daemon outlives server restarts, so a server has to tell whether the
 * daemon it finds is the one it would start itself. Both sides hash the
 * daemon's module graph (the entry file and every file it loads through
 * relative imports; type-only imports load nothing) together with the `env` block of ~/.claude/settings.json,
 * which the daemon reads once at start. The daemon hashes them as it starts,
 * the server when it finds a daemon already running; a difference means the
 * daemon is restarted. Changes elsewhere leave it running.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseJson } from '../utils/json.js';

const RELATIVE_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
/** `import type` / `export type` statements, which load nothing at run time. */
const TYPE_ONLY = /(?:import|export)\s+type\s[^;]*?from\s+['"][^'"]+['"]/gs;

/** A relative specifier as a file on disk: `./x.js` is `./x.ts` when running from source. */
function resolveImport(fromFile: string, specifier: string): string | null {
  const target = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}.js`, path.join(target, 'index.ts'), path.join(target, 'index.js')];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** The `env` block of ~/.claude/settings.json, as strings; the daemon adds it to every agent's environment. */
export function loadClaudeEnvOverrides(): Record<string, string> {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return {};
    const parsed = parseJson(fs.readFileSync(settingsPath, 'utf-8')) as { env?: Record<string, unknown> };
    if (!parsed.env || typeof parsed.env !== 'object') return {};
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.env)) {
      if (value !== undefined && value !== null) overrides[key] = String(value);
    }
    return overrides;
  } catch {
    return {};
  }
}

/** A short hash of the daemon entry's module graph and the settings env it was given. */
export function daemonIdentity(entryPath: string, envOverrides: Record<string, string>): string {
  const seen = new Set<string>();
  const queue = [path.resolve(entryPath)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8').replace(TYPE_ONLY, '');
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  const root = path.dirname(path.resolve(entryPath));
  const hash = createHash('sha256');
  for (const file of [...seen].sort()) {
    hash.update(path.relative(root, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  for (const key of Object.keys(envOverrides).sort()) hash.update(`env:${key}=${envOverrides[key]}\0`);
  return hash.digest('hex').slice(0, 16);
}
