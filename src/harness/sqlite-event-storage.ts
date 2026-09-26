/**
 * SQLite-backed EventStorageAdapter for the harness EventLog.
 *
 * Stores raw SessionEvents as-is (JSON-serialized data field).
 * No lossy conversion — the event is the source of truth.
 *
 * Uses the same better-sqlite3 connection as the rest of Lattice
 * via DatabaseProvider. Writes are synchronous (called from
 * EventLog.append() which is synchronous).
 */

import type Database from 'better-sqlite3';
import type { EventStorageAdapter } from '@liggi/agent-ui-harness/server';
import type { LostTask, SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { createLogger } from '../services/infrastructure/logger.js';
import { parseJson } from '../utils/json.js';

const logger = createLogger('SqliteEventStorage');

// WITHOUT ROWID: the (session_id, seq) primary key is the clustering key, so
// a session's events are contiguous on disk and full-session reads are
// sequential I/O instead of one random seek per row. Existing installs with
// the old rowid layout keep working (IF NOT EXISTS) — migrate them with
// scripts/rebuild-harness-events-clustered.mjs.
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS harness_events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    meta TEXT,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID
`;

const CREATE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_harness_events_ts
  ON harness_events (session_id, timestamp)
`;

// Lets findLatestRunReady do a single index seek + LIMIT 1 instead of
// scanning the (session_id, seq) primary key for a type filter. Important
// for sessions with thousands of stored events, where the run:ready can be
// arbitrarily deep in history.
const CREATE_INDEX_TYPE_SEQ = `
  CREATE INDEX IF NOT EXISTS idx_harness_events_session_type_seq
  ON harness_events (session_id, type, seq DESC)
`;

// Lets a lookup by type across all sessions (the worker dispatch events that
// name a message's sender) seek its rows instead of scanning the whole table.
const CREATE_INDEX_GLOBAL_TYPE_SEQ = `
  CREATE INDEX IF NOT EXISTS idx_harness_events_type_seq
  ON harness_events (type, seq)
`;

/**
 * Create the harness_events table and indexes. Idempotent.
 *
 * This adapter is constructed during harness setup, which is late in startup —
 * but other services prepare statements against harness_events before that, and
 * a prepare() on a missing table throws. The schema bootstrap calls this first
 * so the table always exists; keeping the DDL here means it has one owner.
 */
export function ensureHarnessEventsSchema(db: Database.Database): void {
  db.exec(CREATE_TABLE);
  db.exec(CREATE_INDEX);
  db.exec(CREATE_INDEX_TYPE_SEQ);
  db.exec(CREATE_INDEX_GLOBAL_TYPE_SEQ);
}

/**
 * Event types that can change canonical runtime status or pending-work state.
 * Exported so read-only consumers such as the ambient scanner can derive the
 * same lifecycle without maintaining a competing "latest event" heuristic.
 */
export const STATUS_BEARING_EVENT_TYPES = [
  'run:end',
  'run:error',
  'turn:end',
  'stop:requested',
  'content',
  'result',
  'input:sent',
  'run:ready',
  'run:start',
  'task:started',
  'task:updated',
  'task:notification',
  // Carries phase started/completed/failed; drives the sidebar's compacting
  // indicator. deriveStatus explicitly skips it, so including it here cannot
  // change ongoing/idle answers.
  'context:compaction',
] as const;

export class SqliteEventStorageAdapter implements EventStorageAdapter {
  private stmtWrite: Database.Statement;
  private stmtReadAfter: Database.Statement;
  private stmtReadBefore: Database.Statement;
  private stmtReadRange: Database.Statement;
  private stmtCount: Database.Statement;
  private stmtMaxSeq: Database.Statement;
  private stmtCopyFrom: Database.Statement;
  private stmtFindLatestRunReady: Database.Statement;
  private stmtListSessionsWithNonTerminalTail: Database.Statement;
  private stmtListUnfinishedTasks: Database.Statement;
  private stmtReadStatusWindow: Database.Statement;
  private stmtReadTail: Database.Statement;

  constructor(db: Database.Database) {
    ensureHarnessEventsSchema(db);

    this.stmtWrite = db.prepare(`
      INSERT OR IGNORE INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtReadAfter = db.prepare(`
      SELECT * FROM harness_events
      WHERE session_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `);

    this.stmtReadBefore = db.prepare(`
      SELECT * FROM harness_events
      WHERE session_id = ? AND seq < ?
      ORDER BY seq DESC
      LIMIT ?
    `);

    this.stmtReadRange = db.prepare(`
      SELECT * FROM harness_events
      WHERE session_id = ? AND seq > ? AND seq < ?
      ORDER BY seq ASC
    `);

    this.stmtCount = db.prepare(`
      SELECT COUNT(*) as count FROM harness_events
      WHERE session_id = ?
    `);

    // Cheapest possible change-detector: single index seek on the
    // (session_id, seq) primary key for the rightmost (max) seq. Used by the
    // status route to skip re-reading + re-deriving a session's status window
    // when no new events have landed since the last poll.
    this.stmtMaxSeq = db.prepare(`
      SELECT seq FROM harness_events
      WHERE session_id = ?
      ORDER BY seq DESC
      LIMIT 1
    `);

    this.stmtCopyFrom = db.prepare(`
      INSERT OR IGNORE INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta)
      SELECT ?, seq, run_id, timestamp, type, data, meta
      FROM harness_events
      WHERE session_id = ? AND seq <= ?
    `);

    this.stmtFindLatestRunReady = db.prepare(`
      SELECT * FROM harness_events
      WHERE session_id = ? AND type = 'run:ready'
      ORDER BY seq DESC
      LIMIT 1
    `);

    // Tasks started in a session's current process and never reported
    // finished: no process boundary since, and no task:notification or
    // non-running task:updated for the same taskId after it. At boot every
    // one of these belongs to a process this server cannot hear.
    this.stmtListUnfinishedTasks = db.prepare(`
      SELECT s.session_id AS session_id, s.run_id AS run_id,
             json_extract(s.data, '$.taskId') AS task_id,
             json_extract(s.data, '$.taskType') AS task_type,
             json_extract(s.data, '$.description') AS description
      FROM harness_events s
      WHERE s.type = 'task:started'
        AND s.seq > COALESCE((
          SELECT MAX(b.seq) FROM harness_events b
          WHERE b.session_id = s.session_id AND b.type IN ('run:start', 'run:end', 'run:error')
        ), 0)
        AND NOT EXISTS (
          SELECT 1 FROM harness_events d
          WHERE d.session_id = s.session_id AND d.seq > s.seq
            AND d.type IN ('task:updated', 'task:notification')
            AND json_extract(d.data, '$.taskId') = json_extract(s.data, '$.taskId')
            AND (d.type = 'task:notification' OR COALESCE(json_extract(d.data, '$.patch.status'), '') != 'running')
        )
        -- A background task's tool call has already returned; one that has not is a
        -- foreground call, cut off with its turn (see deriveUnfinishedTasks).
        AND EXISTS (
          SELECT 1 FROM harness_events r, json_each(r.data, '$.blocks') b
          WHERE r.session_id = s.session_id AND r.seq > s.seq AND r.type = 'result'
            AND json_extract(b.value, '$.tool_use_id') = json_extract(s.data, '$.toolUseId')
        )
      ORDER BY s.session_id, s.seq
    `);

    // Sessions whose latest "status-bearing" event is non-terminal — i.e.
    // candidates that need recovery on server boot. We exclude terminal
    // types directly (run:end, run:error, turn:end) and also task:* events
    // (they can land *after* turn:end without changing derived status, so
    // a session whose literal last event is task:notification but with a
    // turn:end before it is genuinely idle). The harness's deriveStatus
    // ultimately decides — this query is a coarse pre-filter.
    this.stmtListSessionsWithNonTerminalTail = db.prepare(`
      SELECT he.session_id AS session_id
      FROM harness_events he
      INNER JOIN (
        SELECT session_id, MAX(seq) AS max_seq
        FROM harness_events
        WHERE type NOT IN ('task:started', 'task:updated', 'task:notification')
        GROUP BY session_id
      ) latest
        ON he.session_id = latest.session_id AND he.seq = latest.max_seq
      WHERE he.type NOT IN ('run:end', 'run:error', 'turn:end')
    `);

    this.stmtReadStatusWindow = db.prepare(`
      SELECT * FROM harness_events
      WHERE session_id = ?
        AND type IN (${STATUS_BEARING_EVENT_TYPES.map(() => '?').join(', ')})
      ORDER BY seq DESC
      LIMIT ?
    `);

    this.stmtReadTail = db.prepare(`
      SELECT * FROM harness_events
      WHERE session_id = ?
      ORDER BY seq DESC
      LIMIT ?
    `);

    logger.info('Event storage initialized');
  }

  write(event: SessionEvent): void {
    this.stmtWrite.run(
      event.sessionId,
      event.seq,
      event.runId,
      event.timestamp,
      event.type,
      JSON.stringify(event.data),
      event.meta ? JSON.stringify(event.meta) : null,
    );
  }

  read(sessionId: string, opts?: {
    afterSeq?: number;
    beforeSeq?: number;
    limit?: number;
  }): SessionEvent[] {
    const afterSeq = opts?.afterSeq;
    const beforeSeq = opts?.beforeSeq;
    const limit = opts?.limit ?? 10000;

    let rows: Array<Record<string, unknown>>;

    if (afterSeq !== undefined && beforeSeq !== undefined) {
      rows = this.stmtReadRange.all(sessionId, afterSeq, beforeSeq) as Array<Record<string, unknown>>;
    } else if (beforeSeq !== undefined) {
      rows = this.stmtReadBefore.all(sessionId, beforeSeq, limit) as Array<Record<string, unknown>>;
      rows.reverse();
    } else {
      rows = this.stmtReadAfter.all(sessionId, afterSeq ?? 0, limit) as Array<Record<string, unknown>>;
    }

    return rows.map(rowToEvent);
  }

  readTail(sessionId: string, limit: number): SessionEvent[] {
    const rows = this.stmtReadTail.all(sessionId, limit) as Array<Record<string, unknown>>;
    rows.reverse();
    return rows.map(rowToEvent);
  }

  count(sessionId: string): number {
    const row = this.stmtCount.get(sessionId) as { count: number };
    return row.count;
  }

  /**
   * Highest stored seq for a session, or 0 if it has no events. seq is strictly
   * increasing per session (events are append-only), so an unchanged maxSeq
   * means no new events — and therefore no possible change in derived status.
   */
  maxSeq(sessionId: string): number {
    const row = this.stmtMaxSeq.get(sessionId) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  readStatusWindow(sessionId: string, limit = 200): SessionEvent[] {
    const rows = this.stmtReadStatusWindow.all(
      sessionId,
      ...STATUS_BEARING_EVENT_TYPES,
      limit,
    ) as Array<Record<string, unknown>>;
    rows.reverse();
    return rows.map(rowToEvent);
  }

  findLatestRunReady(sessionId: string): SessionEvent | null {
    const row = this.stmtFindLatestRunReady.get(sessionId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEvent(row) : null;
  }

  /**
   * Returns session IDs whose latest non-task event is *not* a terminal type
   * (run:end / run:error / turn:end). These are the candidates for boot-time
   * recovery — sessions that were mid-stream or mid-stop when the previous
   * server/daemon went down.
   *
   * Coarse pre-filter; the harness's deriveStatus is the authoritative check.
   */
  listSessionsWithNonTerminalTail(): string[] {
    const rows = this.stmtListSessionsWithNonTerminalTail.all() as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
  }

  listUnfinishedTasks(): Array<{ sessionId: string; runId: string; task: LostTask }> {
    const rows = this.stmtListUnfinishedTasks.all() as Array<{
      session_id: string; run_id: string; task_id: string; task_type: string | null; description: string | null;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      runId: r.run_id,
      task: {
        taskId: r.task_id,
        taskType: r.task_type ?? 'unknown',
        ...(r.description ? { description: r.description } : {}),
      },
    }));
  }

  copyFrom(parentSessionId: string, targetSessionId: string, upToSeq: number): void {
    const result = this.stmtCopyFrom.run(targetSessionId, parentSessionId, upToSeq);
    logger.info('Copied events for branch', {
      parentSessionId,
      targetSessionId,
      upToSeq,
      copied: result.changes,
    });
  }
}

function rowToEvent(row: Record<string, unknown>): SessionEvent {
  const event: SessionEvent = {
    sessionId: row.session_id as string,
    runId: row.run_id as string,
    seq: row.seq as number,
    timestamp: row.timestamp as number,
    type: row.type as SessionEvent['type'],
    data: parseJson(row.data as string),
  };
  if (row.meta) {
    event.meta = parseJson(row.meta as string) as SessionEvent['meta'];
  }
  return event;
}
