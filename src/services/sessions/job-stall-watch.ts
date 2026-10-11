/**
 * Telling a coordinator when a job in its Running list stops moving
 * (2026-10-10, thread 36890; Jason: "feels like the coordinator should be
 * aware if jobs just stop or stall"). The panel already turns a stalled job
 * amber, but only someone looking at it sees that. Each pass checks the live
 * jobs of every recently active coordinator against the same rule the panel
 * uses (`types/job-stall.ts`), and the first time a job is found stalled its
 * coordinator gets one line from the server. Nothing more while it stays
 * stalled; once it moves, the next stall gets its own line, since the line
 * is keyed by when the job last moved.
 *
 * Before that, a worker's open jobs are ended when the worker has stopped
 * working on them (2026-10-10, thread 38188): no turn running, nothing armed
 * or queued, and no `Waiting on:` in its last report. Every job Jason saw as
 * stalled in CK3's Running list that night was one of these, with no process
 * behind it. The job leaves Running as stopped (`job-progress.ts`) and the
 * coordinator gets one line. A worker that declared a wait keeps its jobs,
 * and the stall rule below still applies to them. So does a job whose own
 * process (`--pid`) is still running: its count is real, whoever watches it.
 *
 * A job that has not finished its first item in time, or whose count can't
 * be read, is reported the same way, in its own words.
 *
 * Left alone: finished and stopped jobs (they are not stuck, they ended), jobs
 * of a worker archived out of a live project (its coordinator is done with
 * it; a fixture project's workers are archived from the start, so there the
 * check still runs), jobs of workers on a parked thread, and jobs that last
 * moved over a day ago, whose stall long predates anyone acting on this line.
 */

import { createLogger } from '../infrastructure/logger.js';
import { cannotRead, hasStarted, needsLook } from '../../types/job-stall.js';
import { type JobProgress } from './job-progress.js';
import { processAlive } from './job-count.js';
import { jobWatch } from './job-watch.js';
import { readProjectState } from './project-state.js';
import { drainInbox, enqueueInboxItem, hasUnreadInboxItems } from './session-inbox.js';
import { ACTIVE_WINDOW_MS, activeCoordinators, alreadyQueued, isArchived, readLiveness } from './wait-watch.js';
import { readWorkerStates } from './worker-events.js';
import { readWorkerRuntime } from './worker-runtime.js';
import type { WorkerState } from '../../types/worker-events.js';

const logger = createLogger('JobStallWatch');

const SENDER = 'the server';

/** A job that last moved longer ago than this is not reported: its stall is old news. */
const STALE_STALL_MS = 24 * 60 * 60_000;

/** Who reported the job, as the line names it. */
export type JobOwner =
  | { kind: 'coordinator' }
  | { kind: 'worker'; worker: string; task: string; stopped: boolean };

/** The line the coordinator gets. Exported for tests. */
export function jobStallLine(job: JobProgress, owner: JobOwner, now: number): string {
  const error = cannotRead(job);
  const what = error !== null
    ? `"${job.label}" can't read its count: ${error}`
    : !hasStarted(job)
      ? `"${job.label}" has not finished its first item ${minutes(now - job.startedAt)} after it started${job.each ? ` (its agent said one takes about ${minutes(job.each)})` : ''}`
      : `"${job.label}" is at ${count(job.done)} of ${count(job.total)} and has not moved for ${minutes(now - job.movedAt)}${rhythm(job)}`;
  if (owner.kind === 'coordinator') return `A job you started is stuck: ${what}.`;
  const whose = `A job in Running is stuck: ${what}. It was started by ${owner.worker} (${owner.task}).`;
  return owner.stopped
    ? `${whose} Its worker has stopped: no turn is running and nothing is armed, so nobody is watching it unless you send it something.`
    : `${whose} Its worker is still running.`;
}

/** " (it usually moves every 7 min)", from the measured moves. */
function rhythm(job: JobProgress): string {
  const moves = (job.samples ?? []).slice(1);
  return moves.length >= 2 ? ` (it usually moves every ${minutes((moves.at(-1)!.at - moves[0].at) / (moves.length - 1))})` : '';
}

/** Why the server ends a job whose worker stopped working on it; the panel shows it under the job. */
export const ABANDONED_REASON = 'Its worker stopped without finishing it';

/** The line the coordinator gets when it does. Exported for tests. */
export function jobAbandonedLine(job: JobProgress, worker: string, task: string): string {
  return `"${job.label}" left Running at ${count(job.done)} of ${count(job.total)}: ${worker} (${task}) ended its turn ` +
    'without finishing it, with nothing running or armed, no wait declared and no process of the job\'s running, so the server marked it stopped. ' +
    'If the job should go on, send the worker something.';
}

/** Injection seams for tests. */
export interface JobStallDeps {
  jobs?: (sessions: string[]) => JobProgress[];
  workerStopped?: (worker: string) => boolean;
  abandon?: (job: JobProgress) => JobProgress | null;
  alive?: (pid: number) => boolean;
}

/** Whether the worker said in its last report that it is waiting on something, and has not worked since. */
function declaredWait(state: WorkerState): boolean {
  return state.phase === 'reported' && !state.workedSinceReport && Boolean(state.waitingOn);
}

/**
 * The running jobs whose worker has stopped working on them, with that
 * worker: it has no turn running, nothing armed or queued, and no wait
 * declared. The coordinator's own jobs are never among them, nor a job whose
 * own process is still running. Exported for tests.
 */
export function abandonedJobs(
  running: JobProgress[],
  workers: WorkerState[],
  stopped: (worker: string) => boolean,
  alive: (pid: number) => boolean = processAlive,
): Array<{ job: JobProgress; state: WorkerState }> {
  const asked = new Map<string, boolean>();
  return running.flatMap((job) => {
    const state = workers.find((worker) => worker.worker === job.session);
    if (!state || declaredWait(state)) return [];
    if (job.pid !== undefined && alive(job.pid)) return [];
    if (!asked.has(state.worker)) asked.set(state.worker, stopped(state.worker));
    return asked.get(state.worker) ? [{ job, state }] : [];
  });
}

function workerHasStopped(worker: string): boolean {
  const runtime = readWorkerRuntime(worker);
  if (runtime === 'unknown') return false;
  const live = readLiveness(worker, runtime);
  return !live.active && !live.pendingWork && !hasUnreadInboxItems(worker);
}

/**
 * Send the coordinator one line for each of its jobs that has newly stalled.
 * Returns the lines sent. Never throws.
 */
export async function checkJobStalls(coordinator: string, now: number = Date.now(), deps: JobStallDeps = {}): Promise<string[]> {
  const sent: string[] = [];
  try {
    const workers = readWorkerStates(coordinator);
    const store = jobWatch().store;
    const jobsOf = deps.jobs ?? ((sessions: string[]) => store.forSessions(sessions, now));
    const stoppedOf = deps.workerStopped ?? workerHasStopped;
    const abandon = deps.abandon ?? ((job: JobProgress) => store.abandon(job.session, job.label, ABANDONED_REASON, now));
    const running = jobsOf([coordinator, ...workers.map((state) => state.worker)]).filter((job) => !job.finishedAt && !job.stopped);

    const left = new Set<JobProgress>();
    for (const { job, state } of abandonedJobs(running, workers, stoppedOf, deps.alive)) {
      if (!abandon(job)) continue;
      left.add(job);
      logger.info('A worker stopped without ending its job; ended it', { coordinator, session: job.session, label: job.label });
      const deliveryId = `job-abandoned:${job.session}:${job.label}:${job.startedAt}`;
      // A job quiet for over a day is cleared without a line: nobody is waiting on it.
      if (now - job.movedAt >= STALE_STALL_MS || alreadyQueued(coordinator, deliveryId)) continue;
      const text = jobAbandonedLine(job, state.worker, state.task);
      enqueueInboxItem({ sessionId: coordinator, source: 'agent', sender: SENDER, text, deliveryId });
      sent.push(text);
    }

    const live = running.filter((job) => !left.has(job) && needsLook(job, now) && now - job.movedAt < STALE_STALL_MS);
    if (live.length === 0) {
      if (sent.length > 0) await drainInbox(coordinator);
      return sent;
    }

    const project = readProjectState(coordinator);
    const parkedThreads = project.open.filter((thread) => thread.parked);
    const parked = new Set(parkedThreads.flatMap((thread) => [
      ...(thread.owner?.kind === 'worker' ? [thread.owner.worker] : []),
      ...(thread.workers ?? []),
    ]));
    const parkedSeqs = new Set(parkedThreads.map((thread) => thread.seq));
    const projectArchived = isArchived(coordinator);

    for (const job of live) {
      let owner: JobOwner;
      if (job.session === coordinator) {
        owner = { kind: 'coordinator' };
      } else {
        const state = workers.find((worker) => worker.worker === job.session);
        if (!state) continue;
        if (parked.has(state.worker) || (state.thread !== null && parkedSeqs.has(state.thread))) continue;
        if (!projectArchived && isArchived(state.worker)) continue;
        owner = { kind: 'worker', worker: state.worker, task: state.task, stopped: stoppedOf(state.worker) };
      }
      // Keyed by the last move, or by when reads began failing, so each new stretch gets one line.
      const deliveryId = cannotRead(job) !== null
        ? `job-unreadable:${job.session}:${job.label}:${job.readError!.since}`
        : `job-stall:${job.session}:${job.label}:${job.movedAt}`;
      if (alreadyQueued(coordinator, deliveryId)) continue;
      const text = jobStallLine(job, owner, now);
      enqueueInboxItem({ sessionId: coordinator, source: 'agent', sender: SENDER, text, deliveryId });
      logger.info('A job stalled; told its coordinator', { coordinator, session: job.session, label: job.label, movedAt: job.movedAt });
      sent.push(text);
    }
    if (sent.length > 0) await drainInbox(coordinator);
  } catch (err) {
    logger.error('Checking for stalled jobs failed', err, { coordinator });
  }
  return sent;
}

/** The periodic pass: every recently active coordinator. */
export async function checkAllJobStalls(now: number = Date.now()): Promise<void> {
  for (const coordinator of activeCoordinators(now - ACTIVE_WINDOW_MS)) {
    await checkJobStalls(coordinator, now);
  }
}

function minutes(ms: number): string {
  const total = Math.max(1, Math.round(ms / 60_000));
  if (total < 90) return `${total} min`;
  return `${Math.round(total / 30) / 2} hours`;
}

function count(n: number): string {
  return n.toLocaleString('en-GB');
}
