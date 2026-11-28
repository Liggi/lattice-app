/**
 * A long job, as Lattice counts it from the work itself (2026-10-11, thread
 * 38265). The project panel shows a running job as "N of M, about X left"
 * (2026-10-09, thread 35160). Until now the agent typed the counts in with
 * `lattice progress`, and Jason stopped trusting them ("i don't trust the
 * display, which makes it kinda pointless"): of the 25 real jobs in this file
 * on 11 Oct, one sat at 0 of 2,295 while its worker's own message said 989
 * were done, one read Finished at 116 of 180 after a spend stop cut it short,
 * one sat at 1 of 59 while all 59 were checked, and one closed as Finished at
 * 0 of 2.
 *
 * So the agent now says once where the count lives (`lattice job start`):
 * files appearing in a folder, lines in a file, or a number a command prints,
 * with the total and, if it has one, the process doing the work. The server
 * reads the count every 30 seconds (`job-watch.ts`) and keeps a sample at each
 * move, so the rate and the time left come from what was measured. The server
 * also decides how a job ends: Finished only when the count reaches the total,
 * stopped short when its process exits first. An agent can stop a job it
 * gives up on, but cannot call one finished. Work with nothing Lattice can
 * read (an agent doing items by hand in its own turn) is kept off Running.
 *
 * A job is keyed by the session that started it and its label. Rows sit in
 * one small JSON file: there are a handful at a time.
 *
 * A finished or stopped job stays on the panel until it has been dealt with
 * (2026-10-10, thread 36545): a worker's job goes once the coordinator has
 * given the report the worker wrote after it a disposition (`isDealtWith`).
 * The file keeps an ended job a week.
 *
 * A job whose worker stopped working on it ends too (2026-10-10, thread
 * 38188): once a worker's turn has ended with nothing running or armed and no
 * wait declared, the server ends its open jobs as `abandoned`
 * (`job-stall-watch.ts`), unless the job's own process is still running.
 * Starting it again carries on where it was.
 *
 * Records from before (hand-reported, no `source`) are kept: the first time
 * the server sees them it copies the file aside once (`job-progress.hand-
 * reported.json`) and ends any still open as stopped, saying why.
 *
 * Nothing here imports the app's path aliases, so tests can load it outside
 * the server.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parseJson } from '../../utils/json.js';
import { PROCESS_ENDED_REASON, READ_FAILURES_SHOWN } from '../../types/job-stall.js';

export { PROCESS_ENDED_REASON };

/** Where a job's count is read from. Paths are absolute. */
export type JobSource =
  | { kind: 'files'; glob: string }
  | { kind: 'lines'; file: string; match?: string }
  | { kind: 'command'; command: string; cwd: string; every: number }
  | { kind: 'events'; file?: string };

/** The count at a moment it changed. */
export interface JobSample {
  at: number;
  done: number;
}

export interface JobProgress {
  /** The session that started it. */
  session: string;
  /** What the job is, in a few plain words: "Turns checked". */
  label: string;
  /** Where the count is read from. Absent only on hand-reported records from before 11 Oct. */
  source?: JobSource;
  /** The count as last read. */
  done: number;
  total: number;
  /** Optional unit name ("conversations", "files", "examples"). */
  unit?: string;
  /** Items cleanly skipped or filtered out during the run. */
  skipped?: number;
  /** Per-item failures recorded during the run. */
  failedCount?: number;
  /** Current stage subtitle for multi-step jobs. */
  stage?: string;
  /** Latest plain status note from the job. */
  message?: string;
  /** Where the total was measured, when it was ("lines in /x/input.jsonl"); absent when the agent stated it. */
  totalFrom?: string;
  /** The process doing the work, when the agent named it or `lattice run` spawned it. */
  pid?: number;
  /** Process group id owned by `lattice run`, for reliable Stop. */
  pgid?: number;
  /** True when launched and owned by `lattice run` (exact exit code + log tail + Stop). */
  managed?: boolean;
  /** Command string launched by `lattice run`. */
  command?: string;
  /** Exact exit code reported by `lattice run` when the process ended. */
  exitCode?: number;
  /** Rolling tail of stdout/stderr captured by `lattice run`. */
  logTail?: string[];
  /** How long one item takes, as the agent said: how long "Starting" may last before it turns amber. */
  each?: number;
  /** When the job was started. */
  startedAt: number;
  /** The count when the job was started: the work's first item is the first move past it. */
  startDone: number;
  /** When the server last read the count, or when the job ended. */
  reportedAt: number;
  /** When the count last changed (the start, until it moves). */
  movedAt: number;
  /** When a `lattice run` command last printed output or sent a stage or message; how a job without a count shows it is alive. */
  lastOutputAt?: number;
  /** The start, then every move, oldest first; the rate comes from these. */
  samples?: JobSample[];
  /** Set while reads fail: the latest error in full, since when, and how many reads in a row. */
  readError?: { message: string; since: number; failures: number };
  /** Set once the job completed cleanly (reached total, or exited 0 under `lattice run`). */
  finishedAt?: number;
  /** Set when the job stopped or failed without completing cleanly, with why. */
  stopped?: string;
  /** Set with `stopped` when the server ended the job because its worker stopped working without ending it. */
  abandoned?: true;
}

export interface JobStart {
  session: string;
  label: string;
  source: JobSource;
  total: number;
  unit?: string;
  totalFrom?: string;
  pid?: number;
  pgid?: number;
  managed?: boolean;
  command?: string;
  each?: number;
}

export interface JobUpdatePatch {
  done?: number;
  total?: number;
  skipped?: number;
  failedCount?: number;
  stage?: string;
  message?: string;
  logTail?: string[];
  /** When the command last printed output, as `lattice run` saw it. */
  outputAt?: number;
}

export interface JobFinishInput {
  exitCode: number;
  done?: number;
  total?: number;
  skipped?: number;
  failedCount?: number;
  stage?: string;
  message?: string;
  logTail?: string[];
  reason?: string;
}

/** What one read of the count gave. */
export type JobRead = { count: number } | { error: string };

/** How long the file keeps an ended job whose report is never dealt with. */
const KEEP_ENDED_MS = 7 * 24 * 60 * 60_000;
/** A job reported by a session that writes no report (the coordinator itself) leaves this long after it ends. */
const KEEP_UNREPORTED_MS = 3 * 60 * 60_000;
/** Moves kept per job: enough for the recent rate, small enough for the file. */
const MAX_SAMPLES = 60;
const MAX_LABEL = 80;
/** Why an open hand-reported job ended when Lattice started counting jobs itself. */
export const HAND_REPORTED_REASON = 'Its count was typed in by hand, which Lattice no longer follows.';


/** What `lattice progress` and its old route answer now that counts are no longer typed in. */
export const PROGRESS_GONE = 'lattice progress no longer takes counts: Lattice counts a job from its work. '
  + 'Start it once with lattice job start, naming where its count lives (--files, --lines or --command) and its total, '
  + 'and Lattice reads it every 30 seconds (lattice job --help). '
  + 'Work with nothing Lattice can read, such as items you do by hand in your own turn, stays off Running: do not report it.';

export class JobProgressStore {
  /**
   * 'changed' with { session, label } whenever what the panel shows of a job
   * changes: started, moved, ended, or its count became unreadable or
   * readable again. The activity stream pushes it, so an open panel refetches
   * at once instead of waiting for its poll.
   */
  readonly changes = new EventEmitter().setMaxListeners(0);

  constructor(private readonly file: string) {}

  /** Start a job whose count was just read as `count`. */
  start(input: JobStart, count: number, now = Date.now()): JobProgress {
    const label = input.label.trim();
    if (!label) throw new ProgressError('A job needs a label.');
    if (label.length > MAX_LABEL) throw new ProgressError(`Keep the label under ${MAX_LABEL} characters; it is one line in a narrow panel.`);
    const indeterminate = input.managed === true && input.source.kind === 'events' && input.total === 0;
    if (!indeterminate && (!Number.isInteger(input.total) || input.total <= 0)) throw new ProgressError('The total must be a whole number above 0.');
    if (input.each !== undefined && (!Number.isFinite(input.each) || input.each <= 0)) throw new ProgressError('--each needs a length of time, such as 25m.');
    if (!indeterminate && count >= input.total) throw new ProgressError(`The count is already ${count.toLocaleString('en-GB')} of ${input.total.toLocaleString('en-GB')}: there is nothing left to count, so this would not be a running job. Check the source and the total.`);
    const jobs = this.read(now);
    const index = jobs.findIndex((job) => job.session === input.session && job.label === label);
    const previous = index >= 0 ? jobs[index] : undefined;
    if (previous && endedAt(previous) === undefined) {
      throw new ProgressError(`"${label}" is already running (${previous.done.toLocaleString('en-GB')} of ${previous.total.toLocaleString('en-GB')}). Stop it first with lattice job stop, or give the new job another label.`);
    }
    const fields = {
      source: input.source,
      total: input.total,
      ...(input.unit ? { unit: input.unit } : {}),
      ...(input.totalFrom ? { totalFrom: input.totalFrom } : {}),
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      ...(input.pgid !== undefined ? { pgid: input.pgid } : {}),
      ...(input.managed ? { managed: true } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.each !== undefined ? { each: input.each } : {}),
    };
    // A job the server ended under a worker that went quiet, started again,
    // carries on where it was rather than starting over.
    const job: JobProgress = previous?.abandoned && previous.source && count >= previous.done
      ? { ...stripEnd(previous), ...fields, ...moved(previous, count, now), reportedAt: now }
      : { session: input.session, label, ...fields, done: count, startedAt: now, startDone: count, reportedAt: now, movedAt: now, samples: [{ at: now, done: count }] };
    if (index >= 0) jobs[index] = job;
    else jobs.push(job);
    this.write(jobs);
    this.changed(job);
    return job;
  }

  /**
   * Push structured progress, stage, message, or log tail updates from a
   * managed `lattice run` wrapper (or `lattice job update`).
   */
  update(session: string, label: string, patch: JobUpdatePatch, now = Date.now()): JobProgress | null {
    const jobs = this.read(now);
    const index = jobs.findIndex((job) => job.session === session && job.label === label.trim());
    if (index < 0 || endedAt(jobs[index]) !== undefined) return null;
    const previous = jobs[index];
    const nextDone = patch.done !== undefined && Number.isFinite(patch.done) && patch.done >= 0 ? Math.floor(patch.done) : previous.done;
    const nextTotal = patch.total !== undefined && Number.isInteger(patch.total) && patch.total >= 0 ? patch.total : previous.total;
    const movePatch = nextDone !== previous.done ? moved(previous, nextDone, now) : {};
    const { readError: _cleared, ...rest } = previous;
    const outputAt = lastOutput(previous, patch, now);
    const next: JobProgress = {
      ...(nextDone !== previous.done ? rest : previous),
      ...(outputAt !== undefined ? { lastOutputAt: outputAt } : {}),
      ...movePatch,
      total: nextTotal,
      reportedAt: now,
      ...(patch.skipped !== undefined ? { skipped: Math.max(0, Math.floor(patch.skipped)) } : {}),
      ...(patch.failedCount !== undefined ? { failedCount: Math.max(0, Math.floor(patch.failedCount)) } : {}),
      ...(patch.stage !== undefined ? { stage: patch.stage.trim() || undefined } : {}),
      ...(patch.message !== undefined ? { message: patch.message.trim() || undefined } : {}),
      ...(patch.logTail !== undefined ? { logTail: patch.logTail.slice(-40) } : {}),
    };
    // For non-managed jobs, reaching total finishes immediately; for `lattice run`
    // managed jobs we wait for process exit so post-processing and exit code are truthful.
    if (!next.managed && next.total > 0 && next.done >= next.total) {
      next.finishedAt = now;
    }
    jobs[index] = next;
    this.write(jobs);
    const visualChange = next.done !== previous.done
      || next.total !== previous.total
      || next.skipped !== previous.skipped
      || next.failedCount !== previous.failedCount
      || next.stage !== previous.stage
      || next.message !== previous.message
      || endedAt(next) !== undefined;
    if (visualChange) this.changed(next);
    return next;
  }

  /**
   * Record the exact exit outcome of a `lattice run` managed job.
   * Exit code 0 always finishes cleanly (even when `done < total` due to
   * skipped/filtered items); non-zero exit records a failure with exit code.
   */
  finish(session: string, label: string, outcome: JobFinishInput, now = Date.now()): JobProgress | null {
    const jobs = this.read(now);
    const index = jobs.findIndex((job) => job.session === session && job.label === label.trim());
    if (index < 0 || endedAt(jobs[index]) !== undefined) return null;
    const previous = jobs[index];
    const nextDone = outcome.done !== undefined && Number.isFinite(outcome.done) && outcome.done >= 0 ? Math.floor(outcome.done) : previous.done;
    const nextTotal = outcome.total !== undefined && Number.isInteger(outcome.total) && outcome.total >= 0 ? outcome.total : previous.total;
    const movePatch = nextDone !== previous.done ? moved(previous, nextDone, now) : {};
    const { readError: _cleared, ...rest } = previous;
    const next: JobProgress = {
      ...rest,
      ...movePatch,
      total: nextTotal,
      reportedAt: now,
      exitCode: outcome.exitCode,
      ...(outcome.skipped !== undefined ? { skipped: Math.max(0, Math.floor(outcome.skipped)) } : {}),
      ...(outcome.failedCount !== undefined ? { failedCount: Math.max(0, Math.floor(outcome.failedCount)) } : {}),
      ...(outcome.stage !== undefined ? { stage: outcome.stage.trim() || undefined } : {}),
      ...(outcome.message !== undefined ? { message: outcome.message.trim() || undefined } : {}),
      ...(outcome.logTail !== undefined ? { logTail: outcome.logTail.slice(-40) } : {}),
    };
    if (outcome.exitCode === 0) {
      next.finishedAt = now;
    } else {
      next.stopped = outcome.reason?.trim() || `Exited with code ${outcome.exitCode}`;
    }
    jobs[index] = next;
    this.write(jobs);
    this.changed(next);
    return next;
  }

  /**
   * Record a read of a running job's count, and whether its process is still
   * alive (undefined when it has none). The job finishes when the count
   * reaches the total, and stops short when its process has ended first.
   * A job that has already ended is left exactly as it was.
   */
  observe(session: string, label: string, read: JobRead, alive: boolean | undefined, now = Date.now()): JobProgress | null {
    const jobs = this.read(now);
    const index = jobs.findIndex((job) => job.session === session && job.label === label);
    if (index < 0 || endedAt(jobs[index]) !== undefined) return null;
    const previous = jobs[index];
    let job: JobProgress;
    if ('count' in read) {
      const { readError: _cleared, ...rest } = previous;
      job = { ...rest, ...moved(previous, read.count, now), reportedAt: now };
      if (job.done >= job.total) job.finishedAt = now;
    } else {
      const since = previous.readError?.since ?? now;
      job = { ...previous, reportedAt: now, readError: { message: read.error, since, failures: (previous.readError?.failures ?? 0) + 1 } };
    }
    if (job.finishedAt === undefined && alive === false) {
      job.stopped = PROCESS_ENDED_REASON;
    }
    jobs[index] = job;
    this.write(jobs);
    const shown = (item: JobProgress) => (item.readError?.failures ?? 0) >= READ_FAILURES_SHOWN;
    if (job.done !== previous.done || endedAt(job) !== undefined || shown(job) !== shown(previous)) this.changed(job);
    return job;
  }

  /** An agent gives up on a running job, saying why. */
  stop(session: string, label: string, why: string, now = Date.now()): JobProgress {
    const reason = why.trim();
    if (!reason) throw new ProgressError('Say why the job stopped.');
    const jobs = this.read(now);
    const index = jobs.findIndex((job) => job.session === session && job.label === label.trim());
    if (index < 0) throw new ProgressError(`No job "${label.trim()}" was started from this session.`);
    const job = jobs[index];
    if (job.finishedAt !== undefined) throw new ProgressError(`"${job.label}" already finished; there is nothing to stop.`);
    if (job.stopped) throw new ProgressError(`"${job.label}" already stopped: ${job.stopped}`);
    jobs[index] = { ...job, reportedAt: now, stopped: reason };
    this.write(jobs);
    this.changed(jobs[index]);
    return jobs[index];
  }

  /**
   * End a running job whose worker stopped working on it (see the header).
   * Returns the ended job, or null when it is not running.
   */
  abandon(session: string, label: string, why: string, now = Date.now()): JobProgress | null {
    const jobs = this.read(now);
    const index = jobs.findIndex((job) => job.session === session && job.label === label);
    if (index < 0 || endedAt(jobs[index]) !== undefined) return null;
    jobs[index] = { ...jobs[index], reportedAt: now, stopped: why, abandoned: true };
    this.write(jobs);
    this.changed(jobs[index]);
    return jobs[index];
  }

  /** The jobs these sessions started, newest first. */
  forSessions(sessions: Iterable<string>, now = Date.now()): JobProgress[] {
    const wanted = new Set(sessions);
    return this.read(now)
      .filter((job) => wanted.has(job.session))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Every job still running, for the server's reads. */
  running(now = Date.now()): JobProgress[] {
    return this.read(now).filter((job) => job.source && endedAt(job) === undefined);
  }

  /** All jobs (active and recently ended within the retention window), newest first. */
  all(now = Date.now()): JobProgress[] {
    return this.read(now).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Look up one job by session and label. */
  get(session: string, label: string, now = Date.now()): JobProgress | undefined {
    return this.read(now).find((job) => job.session === session && job.label === label);
  }

  /**
   * When the server first runs with counted jobs: copy the file aside as it
   * was, once, so the hand-reported records outlive the week this file keeps
   * an ended job, then end any hand-reported job still open, saying why.
   * Returns how many it ended.
   */
  retireHandReported(now = Date.now()): number {
    const jobs = this.read(now);
    if (!jobs.some((job) => !job.source)) return 0;
    const aside = this.file.replace(/\.json$/, '') + '.hand-reported.json';
    if (!fs.existsSync(aside)) fs.copyFileSync(this.file, aside, fs.constants.COPYFILE_EXCL);
    const open = jobs.filter((job) => !job.source && endedAt(job) === undefined);
    if (open.length === 0) return 0;
    this.write(jobs.map((job) => (open.includes(job) ? { ...job, reportedAt: now, stopped: HAND_REPORTED_REASON } : job)));
    return open.length;
  }

  private changed(job: JobProgress): void {
    this.changes.emit('changed', { session: job.session, label: job.label });
  }

  private read(now: number): JobProgress[] {
    let jobs: JobProgress[];
    try {
      jobs = parseJson(fs.readFileSync(this.file, 'utf-8')) as JobProgress[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return jobs.filter((job) => {
      const ended = endedAt(job);
      return ended === undefined || now - ended < KEEP_ENDED_MS;
    });
  }

  private write(jobs: JobProgress[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(jobs, null, 2));
    fs.renameSync(temp, this.file);
  }
}

export class ProgressError extends Error {}

/** The job's last sign of output after this update: new output, or a stage or message, advance it; never past now. */
function lastOutput(job: JobProgress, patch: JobUpdatePatch, now: number): number | undefined {
  const reported = patch.outputAt !== undefined && Number.isFinite(patch.outputAt) ? Math.min(patch.outputAt, now) : undefined;
  const signalled = patch.stage !== undefined || patch.message !== undefined ? now : undefined;
  const latest = Math.max(job.lastOutputAt ?? 0, reported ?? 0, signalled ?? 0);
  return latest > 0 ? latest : undefined;
}

/** The count and samples after a read of `count`. */
function moved(job: JobProgress, count: number, now: number): Pick<JobProgress, 'done' | 'movedAt' | 'samples'> {
  if (count === job.done) return { done: job.done, movedAt: job.movedAt, samples: job.samples ?? [] };
  const samples = [...(job.samples ?? []), { at: now, done: count }];
  // Keep the start: it says where the count began.
  if (samples.length > MAX_SAMPLES) samples.splice(1, samples.length - MAX_SAMPLES);
  return { done: count, movedAt: now, samples };
}

function stripEnd(job: JobProgress): JobProgress {
  const { stopped: _stopped, abandoned: _abandoned, finishedAt: _finished, readError: _error, ...rest } = job;
  return rest;
}

/** When the job finished or stopped; undefined while it runs. */
export function endedAt(job: JobProgress): number | undefined {
  return job.finishedAt ?? (job.stopped ? job.reportedAt : undefined);
}

/** What the coordinator's log says about the session that reported a job. */
export interface ReporterFacts {
  /** False for the coordinator itself, which writes no report to deal with. */
  worker: boolean;
  /** Its reports and questions in the coordinator's log, oldest first. */
  reports: Array<{ seq: number; at: number }>;
}

/**
 * Whether an ended job has been dealt with, so the panel can drop it. The
 * report that answers for a job is the first one its worker wrote after the
 * job ended; it is dealt with once that report is no longer in `owed` (the
 * project state's attention and historical lists). Until the worker has
 * written it, the job stays. A job the server ended because its worker went
 * quiet goes with the worker's last report instead. Whether the worker is archived says nothing:
 * a fixture's workers are archived from the start.
 */
export function isDealtWith(job: JobProgress, reporter: ReporterFacts | undefined, owed: ReadonlySet<number>, now = Date.now()): boolean {
  const ended = endedAt(job);
  if (ended === undefined) return false;
  if (!reporter?.worker) return now - ended >= KEEP_UNREPORTED_MS;
  // A job ended under a worker that went quiet is answered for by the last
  // report the worker wrote, which came before the server ended it.
  const report = job.abandoned ? reporter.reports.at(-1) : reporter.reports.find((item) => item.at >= ended);
  return report !== undefined && !owed.has(report.seq);
}
