/**
 * Waiting workers that nothing will wake.
 *
 * A worker ends a turn with `Waiting on: <what>` when it has stopped to wait
 * for something other than its coordinator (see `workerWaitPhrase`). The line
 * is a claim, not a mechanism: the worker only speaks again if something
 * delivers it a turn — a background command or Monitor finishing, a
 * ScheduleWakeup firing, or a message arriving. On 24–26 Sep workers sat for
 * between 25 minutes and a day on waits where none of those was set up: the
 * process had exited, the worker never armed anything, or the thing it waited
 * on was another worker that had itself stopped.
 *
 * Lattice can see all three from the event log, the moment they happen, so
 * this checks for them rather than asking agents to estimate how long they
 * will wait. A worker caught this way gets one line of its own saying so —
 * the worker is the one that can arm something or go and look. Its card is
 * not flagged: the user can do nothing about it. Only if the worker answers
 * that line and still leaves nothing armed does its coordinator get one line,
 * since the coordinator can send it something or stop waiting on it.
 *
 * Waits on the user, the coordinator or a decision are left alone: the thread
 * record already tracks those, and a message from them is what wakes the
 * worker. Waits on a restart are left to `wakeRestartWaiters`, which runs at
 * server start.
 */

import { deriveSessionStatusFromEvents } from '../../harness/derive-session-status.js';
import { getEventStorage } from '../../harness/event-message-reader.js';
import { createLogger } from '../infrastructure/logger.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { userName } from '../user-profile.js';
import { drainInbox, enqueueInboxItem, hasUnreadInboxItems } from './session-inbox.js';
import { readWorkerStates } from './worker-events.js';
import { readWorkerRuntime } from './worker-runtime.js';
import type { WorkerRuntime, WorkerState } from '../../types/worker-events.js';

const logger = createLogger('WaitWatch');

/** Who the lines this sends are from; the same voice as the restart carry-on note. */
const SENDER = 'the server';

/** How many status events back to look for a background task or wakeup still pending. */
const STATUS_WINDOW = 1000;

export type WaitKind = 'exempt' | 'restart' | 'worker' | 'self';

/**
 * What kind of wait a phrase describes. `exempt`: someone who will message the
 * worker (the user, the coordinator, a decision). `restart`: woken at server
 * start. `worker`: names another session of the project, which is checked
 * instead of the waiter. `self`: anything else, which only the worker's own
 * armed task or wakeup can end.
 */
export function classifyWait(phrase: string, projectSessions: readonly string[] = []): { kind: WaitKind; named: string[] } {
  const lower = phrase.toLowerCase();
  // What is waited on, without the reason it is waited on: in "the first real
  // message to be classified, so I can confirm a verdict" the wait is on the
  // message, not on anyone's confirmation.
  // Likewise the first sentence only, and not a "which …" clause describing it.
  const what = lower.split(/\.\s|,?\s+so\s+(?:that\s+)?(?:i|we)\b|,?\s+so\s+that\b|,?\s+before\s+i\b|,?\s+then\s+i\b|,?\s+which\b/)[0];
  const person = new RegExp(
    `\\b(${escapeRegExp(userName().toLowerCase())}|you|your|user|front|coordinator|decision|decide|approval|approve|go-ahead|sign-off|someone|somebody)\\b`,
  );
  if (person.test(what)) return { kind: 'exempt', named: [] };
  if (/\brestart/.test(what)) return { kind: 'restart', named: [] };
  // Sessions of this project may be named without their `conv-` prefix; any
  // other session only counts when it is named in full.
  const named = new Set(projectSessions.filter((id) => lower.includes(id.replace(/^conv-/, '').toLowerCase())));
  for (const match of phrase.matchAll(/conv-[A-Za-z0-9_-]{8,}/g)) named.add(match[0]);
  if (named.size > 0) return { kind: 'worker', named: [...named] };
  return { kind: 'self', named: [] };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A session's liveness from its event log: running a turn, holding pending work, or neither. */
interface Liveness {
  active: boolean;
  pendingWork: boolean;
  processAlive: boolean;
}

function readLiveness(sessionId: string, runtime: WorkerRuntime): Liveness {
  const events = getEventStorage().readStatusWindow(sessionId, STATUS_WINDOW);
  const derived = deriveSessionStatusFromEvents(events);
  return {
    active: runtime === 'working' || runtime === 'starting' || runtime === 'stopping'
      || derived.status === 'ongoing' || derived.status === 'stopping' || derived.compacting,
    pendingWork: derived.pendingWork !== null,
    processAlive: derived.processAlive,
  };
}

/** Injection seams for tests. */
export interface WaitWatchDeps {
  runtime?: (sessionId: string) => WorkerRuntime;
  liveness?: (sessionId: string, runtime: WorkerRuntime) => Liveness;
  queued?: (sessionId: string) => boolean;
}

/**
 * Why nothing will wake this worker, or null when something will (or it is
 * not waiting, or its wait is not this check's to judge). The sentence
 * finishes "nothing will wake it: …", for the worker and its coordinator.
 */
export function unarmedWaitReason(
  coordinator: string,
  state: WorkerState,
  roster: readonly string[],
  deps: WaitWatchDeps = {},
): string | null {
  if (state.phase !== 'reported' || !state.waitingOn || state.workedSinceReport) return null;
  const runtimeOf = deps.runtime ?? readWorkerRuntime;
  const livenessOf = deps.liveness ?? readLiveness;
  const queuedOf = deps.queued ?? hasUnreadInboxItems;

  const runtime = runtimeOf(state.worker);
  // `unknown` is no harness to ask, which is not evidence of anything.
  if (runtime === 'unknown') return null;
  const self = livenessOf(state.worker, runtime);
  if (self.active || self.pendingWork || queuedOf(state.worker)) return null;

  const classified = classifyWait(state.waitingOn, [coordinator, ...roster].filter((id) => id !== state.worker));
  const { kind } = classified;
  const named = classified.named.filter((id) => id !== state.worker);
  if (kind === 'exempt' || kind === 'restart') return null;
  if (kind === 'worker' && named.length > 0) {
    if (named.includes(coordinator)) return null;
    const stalled = named.filter((other) => {
      const otherRuntime = runtimeOf(other);
      if (otherRuntime === 'unknown') return false;
      const live = livenessOf(other, otherRuntime);
      return !live.active && !live.pendingWork && !queuedOf(other);
    });
    // Only when every session it names has stopped: one still running may
    // well be the one that messages it.
    if (stalled.length < named.length) return null;
    return `it is waiting on ${stalled.join(', ')}, which ${stalled.length > 1 ? 'are' : 'is'} not running and ${stalled.length > 1 ? 'have' : 'has'} nothing queued, so no result is coming from ${stalled.length > 1 ? 'them' : 'it'}`;
  }
  return self.processAlive
    ? 'no background command, Monitor or ScheduleWakeup is pending in its session'
    : 'its process has exited, and with it anything it had armed';
}

/** The line the worker gets. Exported for tests. */
export function unarmedWaitLine(phrase: string, reason: string): string {
  return (
    `Your last report says you are waiting on ${phrase}, but nothing is set up to wake you: ${reason}. ` +
    'Nothing will reach you on its own. Check on it now; if it has not happened yet, arm a background command, ' +
    'Monitor or ScheduleWakeup that ends when it does, then end your turn with the same `Waiting on:` line. ' +
    `If what you are really waiting on is front or ${userName()}, say that in the line instead.`
  );
}

/** The line the coordinator gets when the worker answered its line and still armed nothing. Exported for tests. */
export function unansweredNudgeLine(worker: string, phrase: string, reason: string, nudgedAt: Date): string {
  return (
    `${worker} reported waiting on ${phrase}, but nothing will wake it: ${reason}. The server told it so at ` +
    `${nudgedAt.toTimeString().slice(0, 5)} and it ended its turn again without arming anything, so it will sit there ` +
    'until you send it something, or archive it if you no longer need it.'
  );
}

/**
 * When the worker's latest input was one of these lines, the time it was
 * delivered; otherwise null. A worker that answers one and still arms nothing
 * is not told again — a second line would only buy it another turn of the
 * same — and its coordinator is told instead.
 *
 * Judged by the inbox row the line went out as, not by its wording: a task
 * prompt that quotes the line is not one. The row's `read_seq` is the
 * `input:read` after the send, so no input has come since when it is past
 * the latest `input:sent`.
 */
function nudgeDeliveredAt(worker: string): Date | null {
  const row = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT read_at FROM session_inbox
      WHERE session_id = ? AND delivery_id LIKE 'unarmed-wait:%'
        AND read_seq > COALESCE((SELECT MAX(seq) FROM harness_events WHERE session_id = ? AND type = 'input:sent'), 0)
      ORDER BY read_seq DESC LIMIT 1`,
  ).get(worker, worker) as { read_at: string } | undefined;
  return row ? new Date(row.read_at) : null;
}

function isArchived(sessionId: string): boolean {
  const row = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT archived FROM sessions WHERE session_id = ? OR conversation_id = ? LIMIT 1`,
  ).get(sessionId, sessionId) as { archived: number } | undefined;
  return row?.archived === 1;
}

/** Whether an inbox item with this delivery id was ever queued for the session, delivered or not. */
function alreadyQueued(sessionId: string, deliveryId: string): boolean {
  return DatabaseProvider.getInstance().getDb().prepare(
    `SELECT 1 FROM session_inbox WHERE session_id = ? AND delivery_id = ?`,
  ).get(sessionId, deliveryId) !== undefined;
}

/** The seq of the worker's latest report in the coordinator's log, which keys the line so it is sent once per report. */
function latestReportSeq(coordinator: string, worker: string): number | null {
  const row = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT MAX(seq) AS seq FROM harness_events
      WHERE session_id = ? AND type = 'worker:reported' AND json_extract(data, '$.worker') = ?`,
  ).get(coordinator, worker) as { seq: number | null } | undefined;
  return row?.seq ?? null;
}

/**
 * Check every waiting worker of one coordinator and send the line to each
 * that nothing will wake; for one already sent it that still armed nothing,
 * tell the coordinator. Each at most once per report. Returns the workers it
 * sent a line to. Never throws.
 */
export async function checkWaitingWorkers(coordinator: string, deps: WaitWatchDeps = {}): Promise<string[]> {
  const sent: string[] = [];
  let escalated = false;
  try {
    const states = readWorkerStates(coordinator);
    const roster = states.map((state) => state.worker);
    for (const state of states) {
      // An archived worker is one its coordinator is done with; waking it
      // over a wait from before that would be noise.
      if (isArchived(state.worker)) continue;
      const reason = unarmedWaitReason(coordinator, state, roster, deps);
      if (!reason || !state.waitingOn) continue;
      const reportSeq = latestReportSeq(coordinator, state.worker);
      if (reportSeq === null) continue;
      const nudgedAt = nudgeDeliveredAt(state.worker);
      if (nudgedAt) {
        const deliveryId = `unarmed-wait-coordinator:${coordinator}:${reportSeq}`;
        if (alreadyQueued(coordinator, deliveryId)) continue;
        enqueueInboxItem({
          sessionId: coordinator,
          source: 'agent',
          sender: SENDER,
          text: unansweredNudgeLine(state.worker, state.waitingOn, reason, nudgedAt),
          deliveryId,
        });
        logger.info('Waiting worker still has nothing set up to wake it after being told; told its coordinator', {
          coordinator,
          worker: state.worker,
          reportSeq,
          waitingOn: state.waitingOn,
          reason,
        });
        escalated = true;
        continue;
      }
      enqueueInboxItem({
        sessionId: state.worker,
        source: 'agent',
        sender: SENDER,
        text: unarmedWaitLine(state.waitingOn, reason),
        deliveryId: `unarmed-wait:${coordinator}:${reportSeq}`,
      });
      logger.info('Waiting worker has nothing set up to wake it; told it so', {
        coordinator,
        worker: state.worker,
        reportSeq,
        waitingOn: state.waitingOn,
        reason,
      });
      sent.push(state.worker);
    }
    await Promise.all(sent.map((worker) => drainInbox(worker)));
    if (escalated) await drainInbox(coordinator);
  } catch (err) {
    logger.error('Checking waiting workers failed', err, { coordinator });
  }
  return sent;
}

/** Coordinators with worker activity recently enough that a wait could still matter. */
function activeCoordinators(sinceMs: number): string[] {
  const rows = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT c.conversation_id AS id FROM conversations c
      WHERE c.coordinator = 1
        AND EXISTS (SELECT 1 FROM harness_events e
                     WHERE e.session_id = c.conversation_id
                       AND e.type IN ('worker:reported', 'worker:started', 'worker:answered')
                       AND e.timestamp >= ?)`,
  ).all(sinceMs) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** How far back a coordinator's last worker event may be for its waits to be checked. */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The periodic pass: every recently active coordinator. */
export async function checkAllWaitingWorkers(now: number = Date.now()): Promise<void> {
  for (const coordinator of activeCoordinators(now - ACTIVE_WINDOW_MS)) {
    await checkWaitingWorkers(coordinator);
  }
}

/** The line a worker waiting on a restart gets when the server starts. Exported for tests. */
export function restartWaitLine(phrase: string, at: Date): string {
  return (
    `The Lattice server restarted (up again at ${at.toTimeString().slice(0, 5)}). Your last report says you are ` +
    `waiting on ${phrase}. This message is what wakes you: check whether the restart you were waiting for is the ` +
    'one that happened and whether what you needed from it is now true, then carry on, or report where it stands.'
  );
}

/**
 * At server start, wake every idle worker whose latest report waits on a
 * restart. Nothing else would: a worker that was not mid-turn and had nothing
 * running gets no carry-on note, and on 26 Sep two such workers slept through
 * the restart they were waiting for. One line per report, so a second restart
 * before the worker answers adds nothing. Returns the workers woken.
 */
export async function wakeRestartWaiters(now: number = Date.now(), deps: WaitWatchDeps = {}): Promise<string[]> {
  const woken: string[] = [];
  const runtimeOf = deps.runtime ?? readWorkerRuntime;
  const livenessOf = deps.liveness ?? readLiveness;
  const queuedOf = deps.queued ?? hasUnreadInboxItems;
  try {
    for (const coordinator of activeCoordinators(now - ACTIVE_WINDOW_MS)) {
      for (const state of readWorkerStates(coordinator)) {
        if (state.phase !== 'reported' || !state.waitingOn || state.workedSinceReport) continue;
        if (classifyWait(state.waitingOn).kind !== 'restart') continue;
        if (isArchived(state.worker)) continue;
        const runtime = runtimeOf(state.worker);
        const live = livenessOf(state.worker, runtime);
        // Busy (a re-run compaction, say) or already holding a note: whatever
        // runs next will see the restart for itself.
        if (live.active || queuedOf(state.worker)) continue;
        const reportSeq = latestReportSeq(coordinator, state.worker);
        if (reportSeq === null) continue;
        enqueueInboxItem({
          sessionId: state.worker,
          source: 'agent',
          sender: SENDER,
          text: restartWaitLine(state.waitingOn, new Date(now)),
          deliveryId: `restart-wait:${coordinator}:${reportSeq}`,
        });
        woken.push(state.worker);
      }
    }
    if (woken.length > 0) logger.info('Woke workers waiting on a restart', { workers: woken });
  } catch (err) {
    logger.error('Waking restart waiters failed', err);
  }
  return woken;
}
