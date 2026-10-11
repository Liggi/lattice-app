/**
 * When a running job counts as stuck, and how fast it is going (2026-10-10,
 * thread 36890; counted from the work since 2026-10-11, thread 38265). The
 * panel draws a stuck job's amber line from this, and the server tells the
 * job's coordinator from it, so the two never disagree.
 *
 * Before its first item a job is Starting, and stuck once that has taken
 * twice as long as its agent said one item takes (`--each`), or 20 minutes if
 * it said nothing. After that, a job is judged against its own rhythm: stuck
 * once it has gone twice its usual gap between moves without one, and never
 * sooner than ten minutes (Historical Figure, 10 Oct, moved about every 15
 * minutes in batches). A job with a process behind it ends when the process
 * does (`job-progress.ts`), so a stuck one always has its process alive. A
 * job whose count can't be read says so instead.
 */

import type { JobProgress, JobSample } from '../services/sessions/job-progress.js';

/** How many reads in a row must fail before the panel says the count can't be read. */
export const READ_FAILURES_SHOWN = 3;

/** Why a job stopped when the process doing it ended before the count reached the total; the panel says "Stopped at N of M when its process ended." */
export const PROCESS_ENDED_REASON = 'Its process ended before the count reached the total';

export const MIN_STALL_MS = 10 * 60_000;
/** How long a job may sit before its first item when its agent did not say how long one takes. */
export const FIRST_ITEM_MS = 20 * 60_000;
/** The rate is taken over the moves of about this long before the latest one. */
const RATE_WINDOW_MS = 30 * 60_000;

type StallFacts = Pick<JobProgress, 'done' | 'startDone' | 'startedAt' | 'movedAt' | 'samples' | 'each'>;

/** Whether the job's first item has finished: until then it is Starting, with no count shown. */
export function hasStarted(job: Pick<JobProgress, 'done' | 'startDone'>): boolean {
  return job.done > job.startDone;
}

/** The moves after the start, oldest first. */
function moves(job: Pick<JobProgress, 'samples'>): JobSample[] {
  return (job.samples ?? []).slice(1);
}

/**
 * Items finished per ms, from the measured moves only: the latest move
 * against the earliest one within half an hour before it. The time from the
 * start to the first move is left out, since it holds setup (motto worker,
 * 10 Oct: 16 minutes of warm-up before the first of 96 calls). Zero until the
 * job has moved twice.
 */
export function jobRate(job: Pick<JobProgress, 'samples'>): number {
  const after = moves(job);
  const last = after.at(-1);
  if (!last) return 0;
  const from = after.find((sample) => sample.at >= last.at - RATE_WINDOW_MS && sample !== last) ?? null;
  if (!from || last.at <= from.at) return 0;
  return Math.max(0, (last.done - from.done) / (last.at - from.at));
}

/** How long this job may go without moving before it counts as stuck. */
export function stallAfterMs(job: StallFacts): number {
  if (!hasStarted(job)) return job.each ? 2 * job.each : FIRST_ITEM_MS;
  const after = moves(job);
  const usualGap = after.length >= 2 ? (after.at(-1)!.at - after[0].at) / (after.length - 1) : job.each ?? 0;
  return Math.max(MIN_STALL_MS, 2 * usualGap);
}

/** Whether a running job has stopped moving, or never got to its first item. Says nothing of an ended one. */
export function isStalled(job: StallFacts, now: number): boolean {
  return now - job.movedAt > stallAfterMs(job);
}

/** The error to show when reads of the count keep failing, in full; null while they work. */
export function cannotRead(job: Pick<JobProgress, 'readError'>): string | null {
  return job.readError && job.readError.failures >= READ_FAILURES_SHOWN ? job.readError.message : null;
}

/** Stuck in either way the panel turns amber for. */
export function needsLook(job: StallFacts & Pick<JobProgress, 'readError'>, now: number): boolean {
  return cannotRead(job) !== null || isStalled(job, now);
}
