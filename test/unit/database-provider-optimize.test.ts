/**
 * The shared SQLite connection must build query-planner statistics.
 *
 * The live ~/.lattice/session-info.db has never had ANALYZE run against it, so
 * sqlite_stat1 does not exist and the planner works from guesses — it full-scans
 * a covering index during the 30-minute summary tick. DatabaseProvider now runs
 * SQLite's incremental `PRAGMA optimize` (bounded by `analysis_limit`) just off
 * the boot path, again on a slow interval, and once more before close.
 *
 * These tests drive a scratch DB in a temp dir. Nothing here touches ~/.lattice.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';

let scratchDir: string;

/** Give the planner something worth analyzing: a real index over real rows. */
function seedAnalyzableTable(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS summary_rows (session_id TEXT, bucket INTEGER, body TEXT)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_summary_rows ON summary_rows (session_id, bucket)');
  const insert = db.prepare('INSERT INTO summary_rows VALUES (?, ?, ?)');
  const seed = db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      insert.run(`conv-${i % 40}`, i % 7, `body-${i}`);
    }
  });
  seed();
}

function statsTableCount(dbPath: string): number {
  const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = probe
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'")
      .get() as { n: number };
    return row.n;
  } finally {
    probe.close();
  }
}

function statsRows(dbPath: string): Array<{ tbl: string; idx: string | null; stat: string }> {
  const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return probe.prepare('SELECT tbl, idx, stat FROM sqlite_stat1').all() as Array<{
      tbl: string;
      idx: string | null;
      stat: string;
    }>;
  } finally {
    probe.close();
  }
}

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-db-optimize-'));
  DatabaseProvider.resetInstance();
});

afterEach(() => {
  DatabaseProvider.resetInstance();
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('DatabaseProvider query-planner statistics', () => {
  it('has no sqlite_stat1 before anything optimizes — the state the live DB is in', () => {
    const provider = DatabaseProvider.getInstance(scratchDir);
    const dbPath = provider.getDbPath();
    seedAnalyzableTable(provider.getDb());

    expect(statsTableCount(dbPath)).toBe(0);
  });

  it('creates sqlite_stat1 when the deferred startup optimize fires', async () => {
    const provider = DatabaseProvider.getInstance(scratchDir);
    const dbPath = provider.getDbPath();
    seedAnalyzableTable(provider.getDb());

    // The constructor schedules the first-run optimize as a macrotask so it
    // never blocks boot. Yield once and it will have run.
    expect(statsTableCount(dbPath)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(statsTableCount(dbPath)).toBe(1);
    const rows = statsRows(dbPath);
    expect(rows.some((r) => r.tbl === 'summary_rows' && r.idx === 'idx_summary_rows')).toBe(true);
  });

  it('optimizeStatistics() writes stats for the seeded index and reports a duration', () => {
    const provider = DatabaseProvider.getInstance(scratchDir);
    const dbPath = provider.getDbPath();
    seedAnalyzableTable(provider.getDb());

    const durationMs = provider.optimizeStatistics(0x10002);

    expect(durationMs).not.toBeNull();
    expect(durationMs as number).toBeGreaterThanOrEqual(0);
    expect(statsTableCount(dbPath)).toBe(1);
    expect(statsRows(dbPath).map((r) => r.idx)).toContain('idx_summary_rows');
  });

  it('bounds ANALYZE with analysis_limit rather than scanning whole indexes', () => {
    const provider = DatabaseProvider.getInstance(scratchDir);
    const limit = provider.getDb().pragma('analysis_limit', { simple: true });
    expect(limit).toBe(400);
  });

  it('runs a final optimize on close', () => {
    const provider = DatabaseProvider.getInstance(scratchDir);
    const dbPath = provider.getDbPath();
    seedAnalyzableTable(provider.getDb());
    expect(statsTableCount(dbPath)).toBe(0);

    provider.close();

    expect(statsTableCount(dbPath)).toBe(1);
  });

  it('never attempts to write statistics on a readonly connection', () => {
    // Materialize a DB file first, then reopen it readonly.
    const seedProvider = DatabaseProvider.getInstance(scratchDir);
    const dbPath = seedProvider.getDbPath();
    seedAnalyzableTable(seedProvider.getDb());
    seedProvider.close();
    DatabaseProvider.resetInstance();
    // close() optimized on the way out; drop the table so we can prove the
    // readonly path adds nothing of its own.
    const scrub = new Database(dbPath);
    scrub.exec('DROP TABLE IF EXISTS sqlite_stat1');
    scrub.close();
    expect(statsTableCount(dbPath)).toBe(0);

    const readonlyProvider = DatabaseProvider.getInstance(scratchDir, { readonly: true });
    expect(readonlyProvider.optimizeStatistics()).toBeNull();
    readonlyProvider.close();

    expect(statsTableCount(dbPath)).toBe(0);
  });
});
