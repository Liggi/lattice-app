/**
 * Archiving workers whose work is done, without waiting for the coordinator
 * to remember to.
 *
 * Coordinators archive workers by hand (`session archive`), and sending an
 * archived worker more work un-archives it so its card is back while it runs.
 * Nothing archived it again after that, and workers kept visible while their
 * thread waited on the user were never archived at all: one project was
 * found with 8 finished workers still on its panel.
 *
 * A worker is archived here when it is not running, holds nothing that will
 * wake it and has nothing queued, its latest report or question is not still
 * owed a disposition, and either:
 *
 * - every thread it was carrying is closed, or
 * - it last reported, its coordinator has dealt with that report (an
 *   `--addresses` on a note, or closing the thread), and the report was not
 *   a `Waiting on:` one.
 *
 * Archiving is reversible and loses nothing: the next `session send` to the
 * worker brings its card back (`reopenArchivedWorker`).
 */

import { deriveSessionStatusFromEvents } from '../../harness/derive-session-status.js';
import { getEventStorage } from '../../harness/event-message-reader.js';
import { createLogger } from '../infrastructure/logger.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { setArchived } from '../../session-history/repository.js';
import { hasUnreadInboxItems } from './session-inbox.js';
import { readProjectState } from './project-state.js';
import { readWorkerStates } from './worker-events.js';
import { readWorkerRuntime } from './worker-runtime.js';
import type { ProjectState } from '../../types/project-state.js';
import type { WorkerRuntime, WorkerState } from '../../types/worker-events.js';

const logger = createLogger('WorkerAutoArchive');

export type ArchiveReason = 'threads-closed' | 'report-dealt-with';

export interface ArchiveDecision {
  worker: string;
  reason: ArchiveReason;
}

/** What the rule reads about one worker beyond its folded state. */
export interface WorkerFacts {
  archived: boolean;
  /** A turn in progress, a compaction, pending background work, or something queued. */
  live: boolean;
  /** Seq of its latest report or question in the coordinator's log; null when it has written none. */
  latestEventSeq: number | null;
}

/**
 * The rule, over facts already read. Pure so it can be tested against the
 * cases it was written for. Returns the reason to archive, or null to leave
 * the worker where it is.
 */
export function archiveReason(state: WorkerState, facts: WorkerFacts, project: ProjectState): ArchiveReason | null {
  if (facts.archived || facts.live) return null;
  if (state.phase === 'asked') return null;
  if (facts.latestEventSeq !== null) {
    const owed = [...project.attention, ...project.historical].some((item) => item.seq === facts.latestEventSeq);
    if (owed) return null;
  }
  const threads = [...project.open, ...project.closed].filter((thread) =>
    thread.workers.includes(state.worker) || thread.seq === state.thread
    || (thread.owner?.kind === 'worker' && thread.owner.worker === state.worker));
  const openThreads = threads.filter((thread) => thread.closedAt === undefined);
  if (threads.length > 0 && openThreads.length === 0) return 'threads-closed';
  if (state.phase === 'reported' && facts.latestEventSeq !== null && !state.waitingOn) return 'report-dealt-with';
  return null;
}

function latestEventSeqs(coordinator: string): Map<string, number> {
  const rows = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT json_extract(data, '$.worker') AS worker, MAX(seq) AS seq FROM harness_events
      WHERE session_id = ? AND type IN ('worker:reported', 'worker:asked')
      GROUP BY worker`,
  ).all(coordinator) as Array<{ worker: string | null; seq: number }>;
  return new Map(rows.filter((row) => row.worker).map((row) => [row.worker as string, row.seq]));
}

function isArchived(sessionId: string): boolean {
  const row = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT archived FROM sessions WHERE session_id = ? OR conversation_id = ? LIMIT 1`,
  ).get(sessionId, sessionId) as { archived: number } | undefined;
  return row?.archived === 1;
}

function isLive(sessionId: string, runtime: WorkerRuntime): boolean {
  // No harness to ask is not evidence the worker has stopped.
  if (runtime === 'unknown') return true;
  if (runtime === 'working' || runtime === 'starting' || runtime === 'stopping') return true;
  if (hasUnreadInboxItems(sessionId)) return true;
  const derived = deriveSessionStatusFromEvents(getEventStorage().readStatusWindow(sessionId, 1000));
  return derived.status === 'ongoing' || derived.status === 'stopping' || derived.compacting || derived.pendingWork !== null;
}

/**
 * Apply the rule to every worker of one coordinator. With `dryRun` it only
 * says what it would archive. Never throws.
 */
export function archiveFinishedWorkers(coordinator: string, options: { dryRun?: boolean } = {}): ArchiveDecision[] {
  const decisions: ArchiveDecision[] = [];
  try {
    const project = readProjectState(coordinator);
    const latest = latestEventSeqs(coordinator);
    for (const state of readWorkerStates(coordinator)) {
      const archived = isArchived(state.worker);
      if (archived) continue;
      const facts: WorkerFacts = {
        archived,
        live: isLive(state.worker, readWorkerRuntime(state.worker)),
        latestEventSeq: latest.get(state.worker) ?? null,
      };
      const reason = archiveReason(state, facts, project);
      if (!reason) continue;
      if (!options.dryRun) setArchived(state.worker, true);
      decisions.push({ worker: state.worker, reason });
    }
    if (decisions.length > 0 && !options.dryRun) {
      logger.info('Archived finished workers', { coordinator, decisions });
    }
  } catch (err) {
    logger.error('Archiving finished workers failed', err, { coordinator });
  }
  return decisions;
}

/** Every coordinator, for the one-off pass over workers that finished before this rule existed. */
export function archiveFinishedWorkersEverywhere(options: { dryRun?: boolean } = {}): Array<{ coordinator: string; decisions: ArchiveDecision[] }> {
  const coordinators = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT conversation_id AS id FROM conversations WHERE coordinator = 1`,
  ).all() as Array<{ id: string }>;
  return coordinators
    .map(({ id }) => ({ coordinator: id, decisions: archiveFinishedWorkers(id, options) }))
    .filter((entry) => entry.decisions.length > 0);
}
