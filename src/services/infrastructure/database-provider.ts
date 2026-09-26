/**
 * DatabaseProvider - Single shared SQLite connection for all services.
 *
 * Previously, 9 services each opened their own better-sqlite3 connection
 * to ~/.lattice/session-info.db with inconsistent PRAGMA settings.
 * This provider centralizes the connection with:
 * - One WAL-mode connection with busy_timeout
 * - One place for directory creation and PRAGMA setup
 * - Test injection via `:memory:` or custom paths
 *
 * Services still own their own table schemas — they call getDb() and
 * run CREATE TABLE IF NOT EXISTS as before.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { configDirNow } from '@/utils/constants.js';
import { createLogger } from './logger.js';

const logger = createLogger('DatabaseProvider');

const DB_FILENAME = 'session-info.db';

function safeClose(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // Already closed
  }
}

/**
 * Resolve the config directory at call time (not import time).
 * This is critical for tests: vitest reuses fork processes across files,
 * so each file's setup.ts sets a new LATTICE_CONFIG_DIR env var. The old
 * module-level CONFIG_DIR constant would be stale in reused forks.
 */
function resolveConfigDir(): string {
  return configDirNow();
}

const CHECKPOINT_INTERVAL_MS = 30_000;

/**
 * Query-planner statistics (PRAGMA optimize) tuning.
 *
 * The database has never had ANALYZE run, so sqlite_stat1 does not exist and
 * the planner falls back to guesses — it full-scans a covering index in the
 * 30-minute summary tick.
 *
 * `analysis_limit` caps how many rows ANALYZE samples per index, which is what
 * makes this affordable on a 5GB file: without it, ANALYZE scans whole indexes.
 * 400 is the value SQLite's own documentation recommends.
 *
 * Mask 0x10002 = "run ANALYZE on tables that would benefit, including the ones
 * that look expensive" — the form SQLite documents for the first optimize on a
 * freshly opened connection. Plain `PRAGMA optimize` (mask 0x0002) is the
 * cheaper recurring form, for the interval timer and for close.
 */
const ANALYSIS_LIMIT = 400;
const OPTIMIZE_FIRST_RUN_MASK = 0x10002;
const OPTIMIZE_INTERVAL_MS = 60 * 60_000;

export interface DatabaseProviderOptions {
  /**
   * Open the connection read-only. Used by the `lattice session ...` CLI
   * subcommands so they work under read-only sandboxes (e.g. codex
   * `--sandbox read-only`) where the WAL `-shm` file cannot be written.
   *
   * Skips all PRAGMA writes (journal_mode, wal_autocheckpoint) and the
   * checkpoint timer. Reads still see WAL contents — better-sqlite3
   * `readonly: true` preserves WAL visibility, unlike `?immutable=1`.
   */
  readonly?: boolean;
}

export class DatabaseProvider {
  private static instance: DatabaseProvider | null = null;
  private db: Database.Database;
  private dbPath: string;
  private isReadonly: boolean;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private optimizeTimer: NodeJS.Timeout | null = null;
  private firstOptimizeTimer: NodeJS.Timeout | null = null;

  private constructor(dbPathOrMode?: string, opts: DatabaseProviderOptions = {}) {
    this.isReadonly = opts.readonly === true;
    if (dbPathOrMode === ':memory:') {
      this.dbPath = ':memory:';
      this.db = new Database(':memory:');
    } else {
      const dir = dbPathOrMode || resolveConfigDir();
      if (!fs.existsSync(dir)) {
        // In readonly mode, don't try to create the dir. If the DB doesn't
        // exist, the readonly open below will throw cleanly via fileMustExist.
        if (!this.isReadonly) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.dbPath = path.join(dir, DB_FILENAME);
      this.db = this.isReadonly
        ? new Database(this.dbPath, { readonly: true, fileMustExist: true })
        : new Database(this.dbPath);
    }

    if (!this.isReadonly) {
      this.db.pragma('journal_mode = WAL');
      // Disable WAL auto-checkpoint on the main thread entirely. Auto-checkpoint
      // runs DURING write operations — on a 630MB database with concurrent readers
      // (MessageStore worker), checkpoint I/O blocks the event loop for 2-57 seconds.
      // Instead, we run manual PASSIVE checkpoints on a timer (see startCheckpointTimer).
      this.db.pragma('wal_autocheckpoint = 0');
    } else {
      // Force temp tables / sort spill files into memory. Some queries
      // (notably listSessions, which uses a window function over several
      // joins) materialize transient state that SQLite would otherwise
      // write to a temp file under the system temp dir. Under a read-only
      // sandbox (codex `--sandbox read-only`) that write fails and the
      // query surfaces as `lattice: disk I/O error`. Memory temp_store
      // costs a small amount of RAM during the query and zero on disk.
      this.db.pragma('temp_store = MEMORY');
    }
    // busy_timeout is a connection-only runtime setting, safe in readonly mode.
    this.db.pragma('busy_timeout = 10000');

    if (!this.isReadonly) {
      // Connection-scoped: bounds every ANALYZE this connection runs.
      this.db.pragma(`analysis_limit = ${ANALYSIS_LIMIT}`);
      this.startCheckpointTimer();
      this.scheduleStatisticsOptimize();
    }
    logger.debug('Database connection opened', { path: this.dbPath, readonly: this.isReadonly });
  }

  /**
   * Get the singleton instance.
   *
   * In production: call with no args — uses ~/.lattice/session-info.db.
   * In tests: pass ':memory:' for an isolated in-memory DB.
   * In CLI/sandbox-restricted contexts: pass `{ readonly: true }` to skip
   * the WAL pragma writes and checkpoint timer.
   *
   * When ':memory:' is requested and a previous ':memory:' instance exists,
   * the old instance is closed and a fresh one is created. This gives tests
   * automatic isolation without requiring explicit resetInstance() calls.
   *
   * The `readonly` option is honoured only when the singleton is first
   * created — subsequent calls return the existing instance regardless of
   * the option passed. The CLI relies on this: it calls getInstance with
   * `readonly: true` before any repository function does a lazy init.
   */
  static getInstance(
    dbPathOrMode?: string,
    opts: DatabaseProviderOptions = {},
  ): DatabaseProvider {
    // For :memory: requests, always give a fresh DB to prevent test contamination
    if (dbPathOrMode === ':memory:' && DatabaseProvider.instance?.dbPath === ':memory:') {
      safeClose(DatabaseProvider.instance.db);
      DatabaseProvider.instance = null;
    }

    if (!DatabaseProvider.instance) {
      DatabaseProvider.instance = new DatabaseProvider(dbPathOrMode, opts);
    }
    return DatabaseProvider.instance;
  }

  /**
   * Reset the singleton (for tests only).
   * Closes the existing connection if open.
   */
  static resetInstance(): void {
    if (DatabaseProvider.instance) {
      DatabaseProvider.instance.close();
      DatabaseProvider.instance = null;
    }
  }

  /**
   * Get the underlying better-sqlite3 Database instance.
   * All services share this single connection.
   */
  getDb(): Database.Database {
    return this.db;
  }

  /**
   * Get the resolved database file path.
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * One-time full WAL drain (TRUNCATE checkpoint) for long-lived processes.
   *
   * The 30s PASSIVE timer copies pages on the main thread and skips anything
   * read-locked, so once the WAL balloons (335 MB observed 2026-08-07) the
   * debt compounds and each PASSIVE pass that does make progress is itself a
   * freeze. Draining once at server startup — before the HTTP listener, where
   * blocking is harmless — resets that debt. Concurrent readers can defeat
   * TRUNCATE (busy=1, partial progress); the outcome is logged either way.
   */
  drainWal(): void {
    if (this.isReadonly || this.dbPath === ':memory:') return;
    const started = Date.now();
    try {
      const result = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
        busy: number;
        log: number;
        checkpointed: number;
      }>;
      const r = result[0];
      logger.info('Startup WAL drain', {
        durationMs: Date.now() - started,
        busy: r?.busy,
        walPages: r?.log,
        checkpointed: r?.checkpointed,
      });
    } catch (err) {
      logger.warn('Startup WAL drain failed', {
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Run WAL checkpoints on a timer instead of during writes.
   * PASSIVE mode only checkpoints pages that aren't read-locked —
   * it never blocks writers or readers, making it safe to call frequently.
   */
  private startCheckpointTimer(): void {
    if (this.dbPath === ':memory:') return;
    if (this.isReadonly) return;

    this.checkpointTimer = setInterval(() => {
      try {
        const result = this.db.pragma('wal_checkpoint(PASSIVE)') as Array<{
          busy: number;
          log: number;
          checkpointed: number;
        }>;
        const r = result[0];
        if (r && r.log > 0) {
          logger.debug('WAL checkpoint', {
            busy: r.busy,
            walPages: r.log,
            checkpointed: r.checkpointed,
          });
        }
      } catch (err) {
        logger.warn('WAL checkpoint failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, CHECKPOINT_INTERVAL_MS);
    this.checkpointTimer.unref();
  }

  /**
   * Refresh query-planner statistics with `PRAGMA optimize`.
   *
   * Incremental and self-limiting: SQLite decides which tables have drifted
   * enough to be worth re-analyzing and skips the rest, and `analysis_limit`
   * caps the rows sampled per index. A no-op run costs nothing, which is why
   * this is safe to call on a timer and again at close.
   *
   * Returns the duration in ms, or null if the connection cannot run it.
   */
  optimizeStatistics(mask?: number): number | null {
    if (this.isReadonly) return null;
    const started = Date.now();
    try {
      this.db.pragma(mask === undefined ? 'optimize' : `optimize=${mask}`);
      const durationMs = Date.now() - started;
      logger.debug('Query-planner statistics optimized', { durationMs, mask });
      return durationMs;
    } catch (err) {
      logger.warn('PRAGMA optimize failed', {
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * First-run analysis just off the boot path, then a slow refresh loop.
   *
   * The first run uses the wider 0x10002 mask because this database has no
   * sqlite_stat1 at all — there is nothing for the incremental heuristic to
   * build on until one full (but analysis_limit-bounded) pass has happened.
   * It is deferred by a macrotask rather than run inline so the constructor
   * and the synchronous server boot sequence never wait on it.
   */
  private scheduleStatisticsOptimize(): void {
    if (this.dbPath === ':memory:') return;

    this.firstOptimizeTimer = setTimeout(() => {
      this.firstOptimizeTimer = null;
      const durationMs = this.optimizeStatistics(OPTIMIZE_FIRST_RUN_MASK);
      if (durationMs !== null) {
        logger.info('Initial query-planner analysis complete', {
          durationMs,
          analysisLimit: ANALYSIS_LIMIT,
        });
      }
    }, 0);
    this.firstOptimizeTimer.unref();

    this.optimizeTimer = setInterval(() => {
      this.optimizeStatistics();
    }, OPTIMIZE_INTERVAL_MS);
    this.optimizeTimer.unref();
  }

  /**
   * Close the database connection. Used during shutdown.
   */
  close(): void {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    if (this.optimizeTimer) {
      clearInterval(this.optimizeTimer);
      this.optimizeTimer = null;
    }
    if (this.firstOptimizeTimer) {
      clearTimeout(this.firstOptimizeTimer);
      this.firstOptimizeTimer = null;
    }
    // SQLite recommends a final `PRAGMA optimize` just before close: it is
    // where the stats gathered during this connection's lifetime get written.
    if (!this.isReadonly && this.dbPath !== ':memory:') {
      this.optimizeStatistics();
    }
    // Final checkpoint before close (readonly opens can't write)
    if (!this.isReadonly) {
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch { /* closing anyway */ }
    }
    safeClose(this.db);
    logger.debug('Database connection closed');
  }
}
