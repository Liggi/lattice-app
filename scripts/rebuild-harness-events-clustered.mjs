#!/usr/bin/env node
/**
 * Rebuild harness_events as WITHOUT ROWID (clustered on session_id, seq).
 *
 * Why: harness_events is a rowid table, so a session's events are scattered
 * across the whole file in insert order and every session read pays thousands
 * of random page seeks against a multi-GB cold file. WITHOUT ROWID makes the
 * (session_id, seq) primary key the clustering key — each session's events
 * become contiguous on disk and full-session reads turn into sequential I/O.
 * This was the highest-leverage single change from the 2026-08-07 UI-freeze
 * investigation (611 freezes / ~27 min in 13h from synchronous history reads).
 *
 * One-time, offline operation on a live-critical database, so it refuses to
 * run unless every other connection is closed, and takes a backup first.
 *
 * Usage:
 *   pnpm service:stop   (or stop the server however you started it)
 *   npx tsx scripts/rebuild-harness-events-clustered.mjs          # dry run
 *   npx tsx scripts/rebuild-harness-events-clustered.mjs --apply
 *   pnpm service:start
 *
 * Runs under tsx so it reads the config dir the server uses.
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '../src/utils/constants.js';

const DB_PATH = path.join(CONFIG_DIR, 'session-info.db');
const BACKUP_DIR = path.join(CONFIG_DIR, 'backups');
const apply = process.argv.includes('--apply');

function fail(msg) {
  console.error(`REFUSING: ${msg}`);
  process.exit(1);
}

function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

// ---- Preconditions ----------------------------------------------------------

// 1. No other process may hold the database open. A rebuild under a live
//    writer would stall it into busy-timeout errors mid-turn; under a live
//    reader, DROP TABLE blocks. lsof covers server, daemon, CLIs, everything.
let openHandles = '';
try {
  openHandles = execFileSync('lsof', ['-t', DB_PATH, `${DB_PATH}-wal`], { encoding: 'utf8' }).trim();
} catch {
  // lsof exits 1 when no process has the file open — that is the good case.
}
if (openHandles) {
  const pids = openHandles.split('\n').join(', ');
  fail(`database is open by pid(s) ${pids} — stop lattice-server (and anything else) first`);
}

// 2. Disk headroom: rebuild copy + WAL growth + backup ≈ 3× the table.
const dbSize = fs.statSync(DB_PATH).size;
const walSize = fs.existsSync(`${DB_PATH}-wal`) ? fs.statSync(`${DB_PATH}-wal`).size : 0;
const free = Number(execFileSync('df', ['-k', path.dirname(DB_PATH)], { encoding: 'utf8' })
  .trim().split('\n').at(-1).split(/\s+/)[3]) * 1024;
if (free < dbSize * 3) {
  fail(`only ${gb(free)} free; need ~${gb(dbSize * 3)} (3× db size) for backup + rebuild`);
}

console.log(`db: ${gb(dbSize)}  wal: ${gb(walSize)}  free: ${gb(free)}`);

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');

const before = db.prepare('SELECT COUNT(*) AS n FROM harness_events').get().n;
const isAlreadyClustered = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='harness_events'"
).get().sql.includes('WITHOUT ROWID');

console.log(`harness_events rows: ${before.toLocaleString()}  clustered: ${isAlreadyClustered}`);
if (isAlreadyClustered) {
  console.log('Nothing to do.');
  process.exit(0);
}
if (!apply) {
  console.log('Dry run only. Re-run with --apply after stopping lattice-server.');
  process.exit(0);
}

// ---- Backup -----------------------------------------------------------------

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUP_DIR, `session-info-pre-clustered-${stamp}.db`);
console.log(`Draining WAL and backing up to ${backupPath} ...`);
let t = Date.now();
db.pragma('wal_checkpoint(TRUNCATE)');
// better-sqlite3's backup API is async; VACUUM INTO is synchronous, produces a
// compact single file, and needs no other connections — which we've verified.
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
console.log(`Backup done in ${Math.round((Date.now() - t) / 1000)}s (${gb(fs.statSync(backupPath).size)})`);

// ---- Rebuild ----------------------------------------------------------------

console.log('Rebuilding (INSERT ... SELECT in primary-key order) ...');
t = Date.now();
db.exec(`
  CREATE TABLE harness_events_clustered (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    meta TEXT,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID;

  INSERT INTO harness_events_clustered
    SELECT session_id, seq, run_id, timestamp, type, data, meta
    FROM harness_events
    ORDER BY session_id, seq;
`);
console.log(`Copy done in ${Math.round((Date.now() - t) / 1000)}s`);

const copied = db.prepare('SELECT COUNT(*) AS n FROM harness_events_clustered').get().n;
if (copied !== before) {
  fail(`row count mismatch after copy: ${copied} vs ${before} — original table untouched, aborting`);
}

console.log('Swapping tables and recreating indexes ...');
t = Date.now();
db.exec(`
  DROP TABLE harness_events;
  ALTER TABLE harness_events_clustered RENAME TO harness_events;
  CREATE INDEX IF NOT EXISTS idx_harness_events_ts
    ON harness_events (session_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_harness_events_session_type_seq
    ON harness_events (session_id, type, seq DESC);
`);
console.log(`Swap done in ${Math.round((Date.now() - t) / 1000)}s`);

// ---- Compact + verify ---------------------------------------------------------

console.log('VACUUM (reclaims the old table and defragments — the slow part) ...');
t = Date.now();
db.exec('VACUUM');
db.pragma('wal_checkpoint(TRUNCATE)');
console.log(`VACUUM done in ${Math.round((Date.now() - t) / 1000)}s`);

const after = db.prepare('SELECT COUNT(*) AS n FROM harness_events').get().n;
const check = db.pragma('quick_check', { simple: true });
db.close();

console.log(`rows: ${before.toLocaleString()} -> ${after.toLocaleString()}  quick_check: ${check}`);
console.log(`db size now: ${gb(fs.statSync(DB_PATH).size)}`);
if (after !== before || check !== 'ok') {
  console.error(`PROBLEM detected — restore from ${backupPath} before restarting the server`);
  process.exit(1);
}
console.log(`OK. Backup retained at ${backupPath} — delete it once the server has run clean for a day.`);
