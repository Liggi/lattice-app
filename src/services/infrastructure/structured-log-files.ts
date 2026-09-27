import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from '@/utils/constants.js';
import { writeStderrSafely } from './fail-safe-log-writer.js';

export const LATTICE_LOG_DIR = path.join(CONFIG_DIR, 'logs');
export const SERVER_JSONL_LOG_PATH = path.join(LATTICE_LOG_DIR, 'server.jsonl');
export const DAEMON_JSONL_LOG_PATH = path.join(LATTICE_LOG_DIR, 'daemon.jsonl');
export const EVENT_JOURNAL_PATH = path.join(LATTICE_LOG_DIR, 'events.jsonl');
export const BROWSER_INCIDENTS_LOG_PATH = path.join(LATTICE_LOG_DIR, 'browser-incidents.jsonl');
export const BROWSER_CONSOLE_LOG_PATH = path.join(LATTICE_LOG_DIR, 'browser-console.jsonl');
export const PERMISSION_LOG_PATH = path.join(LATTICE_LOG_DIR, 'permissions.jsonl');
export const CONNECTION_DEBUG_LOG_PATH = path.join(LATTICE_LOG_DIR, 'connection-debug.log');

const MAX_JSONL_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

const ROTATABLE_FILES = [
  SERVER_JSONL_LOG_PATH,
  DAEMON_JSONL_LOG_PATH,
  EVENT_JOURNAL_PATH,
  BROWSER_INCIDENTS_LOG_PATH,
  BROWSER_CONSOLE_LOG_PATH,
  PERMISSION_LOG_PATH,
];

let ensured = false;

export function ensureLatticeLogDir(): string {
  if (!ensured) {
    fs.mkdirSync(LATTICE_LOG_DIR, { recursive: true });
    ensured = true;
  }
  return LATTICE_LOG_DIR;
}

/**
 * Rotate oversized JSONL files on startup.
 * Renames foo.jsonl → foo.old.jsonl (overwriting any previous .old).
 * Called once at process init, not on every write.
 */
export function rotateOversizedLogs(): void {
  ensureLatticeLogDir();
  for (const filePath of ROTATABLE_FILES) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_JSONL_SIZE_BYTES) {
        const ext = path.extname(filePath);
        const base = filePath.slice(0, -ext.length);
        fs.renameSync(filePath, `${base}.old${ext}`);
      }
    } catch {
      // File doesn't exist yet — nothing to rotate.
    }
  }
}

export function appendJsonlRecord(filePath: string, record: unknown): void {
  ensureLatticeLogDir();
  const line = JSON.stringify(record) + '\n';
  try {
    fs.appendFileSync(filePath, line);
  } catch (err) {
    // Best-effort — stderr so it doesn't recurse through pino.
    const message = err instanceof Error ? err.message : String(err);
    writeStderrSafely(`[log-append-error] ${filePath}: ${message}\n`);
  }
}
