/**
 * Workers that have moved since their last report, put in front of the
 * coordinator's next turn.
 *
 * A coordinator hears about a worker from its own sends and the worker's
 * end-of-turn reports. The user typing into a worker, another session's
 * `session send`, a server carry-on note after a restart, or a Monitor
 * opening a turn by itself all start work the coordinator never sees until
 * the next report. `markWorkedSinceReport` already knows; this says it to the
 * coordinator instead of waiting to be asked. On 2026-09-27 a coordinator told
 * the user its worker was "idle, waiting for the Metaculus access key" twenty
 * minutes into a turn a courier session had started by delivering that key.
 *
 * Shown once per worker turn: each note records a `workers:drift-shown` event
 * with the turn it described, and a worker reappears only when a newer turn
 * has started. Not a worker event, so it does not move the project revision.
 */

import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { createLogger } from '../infrastructure/logger.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { iterateEventsNewestFirst } from '../../session-history/repository.js';
import { userName } from '../user-profile.js';
import { ConversationService } from './conversation-service.js';
import { readWorkerStates } from './worker-events.js';
import { SERVER_NOTE_END, SERVER_NOTE_PREFIX, type WorkerState } from '../../types/worker-events.js';

const logger = createLogger('WorkerDrift');

export const WORKER_DRIFT_SHOWN_EVENT = 'workers:drift-shown';

export interface WorkerDriftShownData {
  /** Worker → seq of the latest turn start that was described. */
  shown: Record<string, number>;
}

/** What a worker's own log says it has done since its last report. */
export interface WorkerActivitySinceReport {
  /** Who started its turns since the report, in order, without the coordinator. */
  starters: string[];
  /** Seq of the latest turn start (an input, or output with no input before it). */
  turnSeq: number;
  /** When the first of those turns started. */
  firstAt: number;
  /** Whether it is in a turn now. */
  running: boolean;
}

export interface WorkerLogRow {
  seq: number;
  timestamp: number;
  type: 'input:sent' | 'turn:end' | 'content';
  /** Start of the input text, for `input:sent`. */
  text?: string;
}

/**
 * Who sent an input, from the prefix the server writes on it. Null for inputs
 * that start nothing the coordinator does not know of: its dispatch, a
 * compaction and the context restored after one.
 */
export function inputStarter(text: string): string | null {
  if (text.startsWith('/compact') || text.startsWith('[Context restored') || text.startsWith('Picked up from ')) return null;
  if (text.startsWith('[From the server')) return 'a server note';
  if (text.startsWith('[From an unidentified sender')) return 'an unidentified sender (a `session send` with no --from)';
  const from = /^\[From ([^\s·\]]+)/.exec(text);
  if (from) return from[1];
  return `${userName()}, typing into it directly`;
}

/** Folds a worker's log after its report. Null when nothing started work the coordinator does not know about. */
export function activitySinceReport(rows: readonly WorkerLogRow[], coordinator: string): WorkerActivitySinceReport | null {
  const starters: string[] = [];
  let turnSeq = -1;
  let firstAt = 0;
  let inTurn = false;
  let running = false;
  let foreign = false;
  for (const row of rows) {
    if (row.type === 'input:sent') {
      const starter = inputStarter(row.text ?? '');
      if (starter === null) continue;
      if (starter !== coordinator) {
        foreign = true;
        if (!starters.includes(starter)) starters.push(starter);
      }
      if (firstAt === 0) firstAt = row.timestamp;
      turnSeq = row.seq;
      inTurn = true;
      running = true;
    } else if (row.type === 'turn:end') {
      inTurn = false;
      running = false;
    } else if (!inTurn) {
      // Output with no input before it: a Monitor or background task opened the turn.
      foreign = true;
      if (!starters.includes('a background task or Monitor')) starters.push('a background task or Monitor');
      if (firstAt === 0) firstAt = row.timestamp;
      turnSeq = row.seq;
      inTurn = true;
      running = true;
    }
  }
  if (!foreign || turnSeq < 0) return null;
  return { starters, turnSeq, firstAt, running };
}

function readWorkerLogSince(worker: string, since: number): WorkerLogRow[] {
  const rows = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT seq, timestamp, type,
       CASE WHEN type = 'input:sent' THEN substr(json_extract(data, '$.text'), 1, 120) END AS text
     FROM harness_events
     WHERE session_id = ? AND timestamp > ? AND type IN ('input:sent', 'turn:end', 'content')
     ORDER BY seq ASC`,
  ).all(worker, since) as Array<{ seq: number; timestamp: number; type: WorkerLogRow['type']; text: string | null }>;
  return rows.map((row) => ({ seq: row.seq, timestamp: row.timestamp, type: row.type, text: row.text ?? undefined }));
}

function lastShown(coordinator: string): Record<string, number> {
  for (const event of iterateEventsNewestFirst(coordinator, [WORKER_DRIFT_SHOWN_EVENT])) {
    return (event.data as Partial<WorkerDriftShownData>)?.shown ?? {};
  }
  return {};
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** One line per drifted worker. */
export function describeDrift(state: WorkerState, activity: WorkerActivitySinceReport): string {
  const from = activity.starters.join(', ');
  const now = activity.running
    ? `working now, since ${formatTime(activity.firstAt)}`
    : `ran a turn from ${formatTime(activity.firstAt)} and is between turns now`;
  const before = state.waitingOn
    ? `Its last report to you (${formatTime(state.since)}) said it was waiting on ${state.waitingOn}.`
    : `Its last report to you was at ${formatTime(state.since)}.`;
  return `- ${state.worker} (${state.task}): ${now}, on input from ${from}, not you, with no report since. ${before}`;
}

/**
 * The note for a coordinator's next input, or '' when no worker has moved
 * since the coordinator last heard. Records what it showed.
 */
export function buildWorkerDriftNote(coordinator: string, cli: string): string {
  const conversation = ConversationService.getInstance().getConversation(coordinator);
  if (!conversation?.coordinator) return '';
  const drifted = readWorkerStates(coordinator).filter((state) => state.phase === 'reported' && state.workedSinceReport);
  if (drifted.length === 0) return '';
  const previously = lastShown(coordinator);
  const shown: Record<string, number> = { ...previously };
  const lines: string[] = [];
  for (const state of drifted) {
    const activity = activitySinceReport(readWorkerLogSince(state.worker, state.since), coordinator);
    if (!activity || (previously[state.worker] ?? -1) >= activity.turnSeq) continue;
    shown[state.worker] = activity.turnSeq;
    lines.push(describeDrift(state, activity));
  }
  if (lines.length === 0) return '';
  const manager = getHarnessSessionManager();
  if (manager) appendCustomHarnessEvent(manager, coordinator, WORKER_DRIFT_SHOWN_EVENT, { shown } satisfies WorkerDriftShownData);
  logger.info('Worker drift shown', { coordinator, workers: Object.keys(shown).filter((w) => shown[w] !== previously[w]) });
  return [
    `${SERVER_NOTE_PREFIX} These workers have been given work since they last reported to you, so what your context says about them is out of date.`,
    ...lines,
    `Before you tell ${userName()} what one is doing, check it: \`${cli} session workers ${coordinator}\`, \`${cli} session transcript <conv> --last 5\`.]`,
    SERVER_NOTE_END,
    '',
  ].join('\n');
}
