/**
 * AutoArchiveService
 *
 * Archives sessions that have gone quiet for a week, so the sidebar stays a
 * working set rather than a scrollback. This is the tail end of the same
 * lifecycle the sidebar's relevance grouping shows: Active → Waiting → Idle
 * (under a day) → Sleeping (up to a week) → archived.
 *
 * Archiving is reversible and non-destructive — it flips `sessions.archived`,
 * which hides the row from the sidebar and moves it into the archive list.
 * Nothing is deleted.
 *
 * Two things it deliberately leaves alone:
 *
 * - Pinned sessions. Pinning is an explicit "keep this in front of me".
 * - Sessions the event log says are still live or still waiting on background
 *   work. A quiet timestamp is nearly always enough, but a session that spent
 *   a week inside one long-running turn would otherwise be archived out from
 *   under a running agent.
 */

import type Database from 'better-sqlite3';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import { getEventStorage } from '../../harness/event-message-reader.js';
import { deriveSessionStatusFromEvents } from '../../harness/derive-session-status.js';

/** How long a session must be quiet before it is archived. */
export const AUTO_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sessions quiet for longer than `@cutoff_ms`, quietest first.
 *
 * Quiet-ness is measured on the last harness event, not on
 * `conversations.updated_at`. `updated_at` only moves on the legacy /resume
 * route and on segment changes, so cutting on it would archive by roughly
 * creation date rather than by when the session was last worked in — the same
 * trap `lastUsedAt` in sidebar-ordering.ts documents. Falls back to updated_at
 * for conversations with no events at all. The (session_id, timestamp) index
 * makes the MAX an index seek per row.
 *
 * Exported so the unit test runs this exact query rather than a copy of it.
 */
export const AUTO_ARCHIVE_CANDIDATE_SQL = `
  SELECT c.conversation_id AS session_id,
         COALESCE(
           (SELECT MAX(e.timestamp) FROM harness_events e WHERE e.session_id = c.conversation_id),
           CAST(strftime('%s', c.updated_at) AS INTEGER) * 1000
         ) AS last_activity_ms
  FROM conversations c
  JOIN sessions s ON s.session_id = c.conversation_id
  WHERE s.archived = 0
    AND s.pinned = 0
    AND last_activity_ms < @cutoff_ms
  ORDER BY last_activity_ms ASC
`;

interface Candidate {
  sessionId: string;
  lastActivityMs: number;
}

export class AutoArchiveService {
  private static instance: AutoArchiveService | null = null;

  private readonly db: Database.Database;
  private readonly logger: Logger;
  private readonly selectCandidatesStmt: Database.Statement;
  private readonly archiveStmt: Database.Statement;

  private constructor() {
    this.db = DatabaseProvider.getInstance().getDb();
    this.logger = createLogger('AutoArchiveService');

    this.selectCandidatesStmt = this.db.prepare(AUTO_ARCHIVE_CANDIDATE_SQL);

    // updated_at is left untouched on purpose: the archive list is ordered by
    // sessions.updated_at, so stamping it here would file every session under
    // the day it was swept instead of the day it was last worked on.
    this.archiveStmt = this.db.prepare(`
      UPDATE sessions SET archived = 1 WHERE session_id = ? AND archived = 0
    `);
  }

  static getInstance(): AutoArchiveService {
    if (!AutoArchiveService.instance) {
      AutoArchiveService.instance = new AutoArchiveService();
    }
    return AutoArchiveService.instance;
  }

  /**
   * Archive every session quiet for longer than `AUTO_ARCHIVE_AFTER_MS`.
   * Returns the number archived. Safe to call repeatedly; already-archived
   * sessions are filtered out by the candidate query.
   */
  runSweep(now: number = Date.now()): number {
    const cutoffMs = now - AUTO_ARCHIVE_AFTER_MS;

    let candidates: Candidate[];
    try {
      candidates = (this.selectCandidatesStmt.all({ cutoff_ms: cutoffMs }) as Array<{
        session_id: string;
        last_activity_ms: number;
      }>).map(row => ({ sessionId: row.session_id, lastActivityMs: row.last_activity_ms }));
    } catch (error) {
      this.logger.error('Failed to read auto-archive candidates', error);
      return 0;
    }

    if (candidates.length === 0) return 0;

    const skipped: string[] = [];
    const archivable = candidates.filter((candidate) => {
      if (this.isStillLive(candidate.sessionId)) {
        skipped.push(candidate.sessionId);
        return false;
      }
      return true;
    });

    if (skipped.length > 0) {
      this.logger.info('Auto-archive skipped live sessions', { sessionIds: skipped });
    }

    if (archivable.length === 0) return 0;

    try {
      const archiveAll = this.db.transaction((rows: Candidate[]) => {
        let archived = 0;
        for (const row of rows) {
          archived += this.archiveStmt.run(row.sessionId).changes;
        }
        return archived;
      });

      const archivedCount = archiveAll(archivable);
      this.logger.info('Auto-archived quiet sessions', {
        archivedCount,
        cutoff: new Date(cutoffMs).toISOString(),
        oldest: archivable[0] ? new Date(archivable[0].lastActivityMs).toISOString() : null,
      });
      return archivedCount;
    } catch (error) {
      this.logger.error('Failed to auto-archive sessions', error);
      return 0;
    }
  }

  /**
   * True when the event log says this session is mid-turn, stopping, or has
   * background work outstanding. A session with no events at all is not live.
   */
  private isStillLive(sessionId: string): boolean {
    try {
      const events = getEventStorage().readStatusWindow(sessionId, 200);
      if (events.length === 0) return false;

      const derived = deriveSessionStatusFromEvents(events);
      return derived.status === 'ongoing'
        || derived.status === 'stopping'
        || derived.pendingWork !== null;
    } catch (error) {
      // Unreadable event log is not a reason to archive. Leave it for the next
      // sweep and say so.
      this.logger.warn('Could not check liveness before auto-archive; leaving session alone', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }
}
