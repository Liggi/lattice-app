/**
 * Startup recovery sweep — closes interrupted sessions on server boot.
 *
 * Without this, sessions that were mid-stream or mid-stop when the previous
 * server (or daemon) went down stay stuck in non-terminal status forever.
 * The harness's `deriveStatus` keeps returning `streaming` / `stopping` from
 * the stored events, so the UI shows "WORKING" indefinitely and the `/send`
 * route rejects with 400 ("Cannot send while stopping"). The harness's lazy
 * `recoverFromStorage` only fires on SSE *if the session isn't already in
 * memory*, which leaves orphaned sessions wedged between restarts.
 *
 * This sweep runs once at boot:
 *
 *   1. Query storage for sessions whose latest event is non-terminal
 *      (a coarse pre-filter — small set in practice).
 *   2. For each, call `sessionManager.recoverFromStorage(sessionId)`. The
 *      harness's recovery synthesizes a `run:end` (reason: 'server_restart')
 *      when its own deriveStatus returns non-idle, otherwise it just hydrates
 *      the in-memory log. Either way the session is interactable afterward.
 *
 * We deliberately do NOT cross-check the daemon's active-process list. The
 * new server has no event subscription for any process from the previous
 * server's lifetime — they're functionally dead from the user's POV, and the
 * server stops every one of them before this sweep runs (lattice-server.ts
 * stopOrphanedDaemonProcesses), so none goes on acting with nothing reaching
 * its transcript. The carry-on note below still asks a session to check what
 * its last step actually did, because the process may have got further than
 * the log shows before it was stopped.
 *
 * The failure this prevents: a session stuck on `stop:requested`
 * after `pnpm deploy` killed both server and daemon mid-run. UI showed
 * "WORKING" with the input box silently failing — `POST /send` returned
 * 400 "Cannot send while stopping" with no surface-level error.
 *
 * A session can also be idle, its turn ended, with a background task still
 * running in its process. Its tail is `turn:end`, so the pass above never
 * sees it, and the stored log goes on saying the task runs: the session
 * waits for a result that cannot reach this server, whether the process
 * died with the old server or lives on in a daemon nobody is listening to.
 * Those get a `run:end` with reason `process_lost` naming the tasks, written
 * before recovery so the log ends where the process stopped being heard.
 *
 * A session that was inside a turn when the previous server went down (status
 * `starting` or `streaming`), or whose turn had ended while it waited on
 * background tasks that the restart lost, is also told so and carries on by
 * itself: the sweep queues one note in its inbox, and the boot drain delivers
 * it once the send route is listening. Without it every restart had to wait
 * for a quiet fleet, or someone had to list the interrupted sessions by hand.
 * Its state is read before the lost-task pass writes its run:end, which would
 * otherwise make a mid-turn session with a background command read as idle.
 * A session that was `stopping` is not woken, since somebody asked it to
 * stop, and an idle one with nothing running never reaches this pass.
 *
 * A session cut off mid-compaction compacts again before anything is sent
 * to it (`rerunCutOffCompactions`, awaited before the boot drain). When the
 * compaction was the whole turn — a `/compact`, typed or automatic — there is
 * nothing else to carry on and no note is queued.
 */

import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { type LostTask, type RunEndData, type SessionEvent } from '@liggi/agent-ui-harness/protocol';
import type { SqliteEventStorageAdapter } from './sqlite-event-storage.js';
import { createLogger } from '../services/infrastructure/logger.js';
import { noteCompactionCutOff, queueCarryOnNote, shouldCarryOn } from '../services/sessions/restart-carry-on.js';

const logger = createLogger('StartupRecoverySweep');

export interface StartupRecoverySweepResult {
  candidatesFound: number;
  recovered: number;
  skipped: number;
  errors: number;
  /** Sessions closed because tasks were still running in a process this server cannot hear. */
  lostTaskSessions: number;
  /** Sessions cut off mid-turn, or waiting on lost background tasks, and queued a note to carry on. */
  resumed: number;
}

export { RESTART_NOTE_SENDER } from '../services/sessions/restart-carry-on.js';

/** Close every session whose stored log has tasks running in a previous server's process. */
function closeSessionsWithLostTasks(
  sessionManager: SessionManager,
  storage: SqliteEventStorageAdapter,
): { closed: Map<string, LostTask[]>; errors: number } {
  const bySession = new Map<string, { runId: string; tasks: LostTask[] }>();
  for (const row of storage.listUnfinishedTasks()) {
    const entry = bySession.get(row.sessionId) ?? { runId: row.runId, tasks: [] };
    entry.tasks.push(row.task);
    bySession.set(row.sessionId, entry);
  }
  const closed = new Map<string, LostTask[]>();
  let errors = 0;
  for (const [sessionId, { runId, tasks }] of bySession) {
    if (sessionManager.hasSession(sessionId)) continue;
    try {
      const data: RunEndData = { reason: 'process_lost', code: null, lostTasks: tasks };
      const event: SessionEvent = {
        sessionId,
        runId,
        seq: storage.maxSeq(sessionId) + 1,
        timestamp: Date.now(),
        type: 'run:end',
        data,
        meta: { inferred: true, source: 'recovery' },
      };
      storage.write(event);
      closed.set(sessionId, tasks);
      logger.info('Closed session with tasks its process can no longer report', {
        sessionId,
        taskIds: tasks.map((t) => t.taskId),
      });
    } catch (err) {
      logger.error('Could not close session with lost tasks', err, { sessionId });
      errors += 1;
    }
  }
  return { closed, errors };
}

/**
 * Walk the harness_events store for sessions in non-terminal state and
 * trigger the harness's recoverFromStorage path for each. Best-effort:
 * any per-session failure is logged but doesn't abort the sweep.
 */
export function runStartupRecoverySweep(
  sessionManager: SessionManager,
  storage: SqliteEventStorageAdapter,
): StartupRecoverySweepResult {
  const result: StartupRecoverySweepResult = {
    candidatesFound: 0,
    recovered: 0,
    skipped: 0,
    errors: 0,
    lostTaskSessions: 0,
    resumed: 0,
  };

  let candidates: string[];
  let lostTasks: Map<string, LostTask[]>;
  // Each candidate's state as the previous server left it, read before
  // anything here appends to its log.
  const before = new Map<string, { events: SessionEvent[]; lastAt: number }>();
  try {
    const nonTerminal = storage.listSessionsWithNonTerminalTail();
    const withTasks = storage.listUnfinishedTasks().map((row) => row.sessionId);
    for (const sessionId of new Set([...nonTerminal, ...withTasks])) {
      if (sessionManager.hasSession(sessionId)) continue;
      // The same window the harness derives from when it decides to close a session.
      const tail = storage.read(sessionId, { beforeSeq: Number.MAX_SAFE_INTEGER, limit: 50 });
      if (tail.length > 0) before.set(sessionId, { events: tail, lastAt: tail[tail.length - 1].timestamp });
    }
    const lost = closeSessionsWithLostTasks(sessionManager, storage);
    lostTasks = lost.closed;
    result.lostTaskSessions = lost.closed.size;
    result.errors += lost.errors;
    candidates = [...new Set([...nonTerminal, ...lost.closed.keys()])];
  } catch (err) {
    logger.error('Failed to enumerate candidate sessions', err);
    result.errors += 1;
    return result;
  }

  result.candidatesFound = candidates.length;

  if (candidates.length === 0) {
    logger.info('No interrupted sessions to recover');
    return result;
  }

  for (const sessionId of candidates) {
    // Defensive: skip sessions already loaded into memory (shouldn't happen
    // at boot, but guards against double-recovery if the sweep is ever
    // invoked after init).
    if (sessionManager.hasSession(sessionId)) {
      result.skipped += 1;
      continue;
    }

    try {
      const prior = before.get(sessionId);
      const tasks = lostTasks.get(sessionId) ?? [];
      const log = sessionManager.recoverFromStorage(sessionId);
      if (log) {
        result.recovered += 1;
        const { wake, inTurn, compacting } = prior
          ? shouldCarryOn(prior.events, tasks)
          : { wake: false, inTurn: false, compacting: false };
        if (compacting) noteCompactionCutOff(sessionId);
        if (prior && wake) {
          queueCarryOnNote({
            sessionId,
            closedAtSeq: storage.maxSeq(sessionId),
            cutOffAt: new Date(prior.lastAt),
            inTurn,
            lostTasks: tasks,
            kind: 'server',
          });
          result.resumed += 1;
        }
      } else {
        result.skipped += 1;
      }
    } catch (err) {
      logger.error('Recovery failed for session', err, { sessionId });
      result.errors += 1;
    }
  }

  logger.info('Startup recovery sweep complete', {
    lostTaskSessions: result.lostTaskSessions,
    resumed: result.resumed,
    candidatesFound: result.candidatesFound,
    recovered: result.recovered,
    skipped: result.skipped,
    errors: result.errors,
  });

  return result;
}
