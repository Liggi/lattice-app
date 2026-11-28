import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseJson } from '../utils/json.js';

/**
 * What a server run from source loaded: a hash of every server-side file under
 * src/ (everything but src/web) at startup. A client build compares the source
 * now against it, so a client that reads API fields the running server does not
 * send yet is caught before it ships (22 Nov 2026: a header widget read a field
 * a server started 40 minutes earlier lacked, and the whole UI went down).
 */
export interface RunningServerRecord {
  pid: number;
  port: number | null;
  startedAt: string;
  files: Record<string, string>;
}

/** Where running servers of this checkout leave their records; gitignored. */
export function runningServersDir(checkoutDir: string): string {
  return path.join(checkoutDir, '.running-servers');
}

/** Hash of each server-side source file, keyed by its path under src/. */
export function hashServerSource(checkoutDir: string): Record<string, string> {
  const srcDir = path.join(checkoutDir, 'src');
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(srcDir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (rel !== 'web') walk(full);
      } else if (entry.isFile()) {
        files[rel] = createHash('sha1').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(srcDir);
  return files;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Records the server source this process loaded. Replaces any earlier record for the pid. */
export function recordRunningServer(checkoutDir: string, port: number | null, pid = process.pid): void {
  const dir = runningServersDir(checkoutDir);
  fs.mkdirSync(dir, { recursive: true });
  const record: RunningServerRecord = { pid, port, startedAt: new Date().toISOString(), files: hashServerSource(checkoutDir) };
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify(record));
}

/** Removes this process's record, on a clean stop. */
export function forgetRunningServer(checkoutDir: string, pid = process.pid): void {
  fs.rmSync(path.join(runningServersDir(checkoutDir), `${pid}.json`), { force: true });
}

export interface StaleServer {
  pid: number;
  port: number | null;
  startedAt: string;
  /** Server-side files added, changed or removed since the server started. */
  changed: string[];
}

/**
 * Each running server of this checkout whose server-side source has changed
 * since it started. Records of servers no longer running are deleted.
 */
export function findStaleServers(checkoutDir: string, alive: (pid: number) => boolean = isAlive): StaleServer[] {
  const dir = runningServersDir(checkoutDir);
  if (!fs.existsSync(dir)) return [];
  const now = hashServerSource(checkoutDir);
  const stale: StaleServer[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let record: RunningServerRecord;
    try {
      record = parseJson(fs.readFileSync(file, 'utf8')) as RunningServerRecord;
    } catch {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (!alive(record.pid)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    const paths = new Set([...Object.keys(record.files), ...Object.keys(now)]);
    const changed = [...paths].filter((p) => record.files[p] !== now[p]).sort();
    if (changed.length > 0) stale.push({ pid: record.pid, port: record.port, startedAt: record.startedAt, changed });
  }
  return stale;
}
