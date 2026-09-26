/**
 * Server-side writer and reader for worker events in a coordinator's event
 * log. The shapes and the fold live in `src/types/worker-events.ts` (shared
 * with the web client); this file is the only place that touches the harness.
 */

import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { createLogger } from '../infrastructure/logger.js';
import { appendProjectNote, readProjectState } from './project-state.js';
import { getEvents } from '../../session-history/repository.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import {
  WORKER_EVENT_TYPES,
  foldWorkerHistory,
  foldWorkerStates,
  type WorkerHistoryRow,
  type WorkerEventType,
  type WorkerState,
  type WorkerAnsweredData,
  type WorkerAskedData,
  type WorkerReportedData,
  type WorkerStartedData,
  type WorkerReassignedData,
  type WorkerMovedData,
} from '../../types/worker-events.js';

const logger = createLogger('WorkerEvents');

type WorkerEventData = WorkerStartedData | WorkerReassignedData | WorkerAskedData | WorkerAnsweredData | WorkerReportedData | WorkerMovedData;

/**
 * Append a worker event to the coordinator's log. Fans out live to SSE
 * listeners. Returns the seq it was written at, or null when it could not be
 * written: a report or question is identified by that seq everywhere else —
 * the project state's pending attention, `--addresses`, `--answers` — so the
 * caller that queues the delivery can carry the exact source event with it.
 */
export function appendWorkerEvent(
  coordinatorConversationId: string,
  type: WorkerEventType,
  data: WorkerEventData,
): SessionEvent | null {
  const manager = getHarnessSessionManager();
  if (!manager) {
    logger.warn('No harness session manager; worker event dropped', { coordinator: coordinatorConversationId, type });
    return null;
  }
  if (type === 'worker:started') startAccountingIfUnstarted(coordinatorConversationId);
  const appended = appendCustomHarnessEvent(manager, coordinatorConversationId, type, data);
  if (!appended) {
    logger.warn('Worker event not appended', { coordinator: coordinatorConversationId, type, worker: data.worker });
    return null;
  }
  return appended;
}

/**
 * A coordinator dispatching its first worker starts accounting for what that
 * worker sends back, from here on. Only its first: a coordinator that already
 * has reports in its log predates the mechanism, and drawing the boundary
 * behind them would turn work it may well have finished into a backlog it
 * never agreed to, since every such report was written before a thread
 * could be attached to anything.
 * Those need `--account-from-now` and then reconciling one at a time.
 */
export function startAccountingIfUnstarted(coordinatorConversationId: string): void {
  const state = readProjectState(coordinatorConversationId);
  if (state.accountingFrom !== null || state.historical.length > 0) return;
  appendProjectNote(coordinatorConversationId, {
    kind: 'accounting',
    text: 'Accounting for worker reports and questions starts here, with this project\'s first dispatch.',
    by: 'coordinator',
  });
}

/** Every worker the coordinator has dispatched, with its current phase, from the full log. */
export function readWorkerStates(coordinatorConversationId: string): WorkerState[] {
  return markWorkedSinceReport(foldWorkerStates(getEvents(coordinatorConversationId, { types: [...WORKER_EVENT_TYPES] })));
}

/** Whether the worker has written any output after `since`: a turn it ran, whoever or whatever started it. */
export function workerOutputSince(worker: string, since: number): boolean {
  const latest = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT timestamp FROM harness_events WHERE session_id = ? AND type = 'content' ORDER BY seq DESC LIMIT 1`,
  ).get(worker) as { timestamp: number } | undefined;
  return latest !== undefined && latest.timestamp > since;
}

/**
 * Sets `workedSinceReport` on each reported worker from its own log.
 *
 * Only a report or answer moves a worker in its coordinator's log, but a worker
 * is also started by the user typing into it, a server carry-on note after a
 * restart, a `session send` without `--answers`, and a Monitor or background
 * task opening a turn by itself. None of those write there, so the fold kept
 * the old report's wait. On 2026-09-26 a coordinator's restored roster said a
 * worker was waiting on an npm approval for as long as it kept working after
 * its Monitor fired.
 */
export function markWorkedSinceReport(
  states: WorkerState[],
  outputSince: (worker: string, since: number) => boolean = workerOutputSince,
): WorkerState[] {
  for (const state of states) {
    if (state.phase === 'reported') state.workedSinceReport = outputSince(state.worker, state.since);
  }
  return states;
}

/** The coordinator's moves with its workers, oldest first, from the full log. */
export function readWorkerHistory(coordinatorConversationId: string): WorkerHistoryRow[] {
  return foldWorkerHistory(getEvents(coordinatorConversationId, { types: [...WORKER_EVENT_TYPES] }));
}

/** The worker's open question in the coordinator's log, or null when it is not waiting on one. */
export function openQuestion(coordinatorConversationId: string, worker: string): string | null {
  const state = readWorkerStates(coordinatorConversationId).find((candidate) => candidate.worker === worker);
  return state?.phase === 'asked' && state.question ? state.question : null;
}

/**
 * What this worker is called now: the task from its dispatch, with any
 * reassignment since applied. Null when the coordinator has no card for it.
 * Read through the fold rather than off the last event so it gives the same
 * answer the card and the roster do.
 */
export function currentWorkerTask(coordinatorConversationId: string, worker: string): string | null {
  const state = readWorkerStates(coordinatorConversationId).find((candidate) => candidate.worker === worker);
  return state?.task?.trim() || null;
}

/** Whether `seq` is a question this worker asked its coordinator: what `--answers` may name. */
export function isWorkerQuestionSeq(coordinatorConversationId: string, worker: string, seq: number): boolean {
  const event = getEvents(coordinatorConversationId).find((candidate) => candidate.seq === seq);
  return event?.type === 'worker:asked' && (event.data as { worker?: string })?.worker === worker;
}
