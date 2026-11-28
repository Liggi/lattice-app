/**
 * The server's side of counted jobs (2026-10-11, thread 38265; see
 * `job-progress.ts`): starting one, after reading its count once so a source
 * that can't be read is refused there and then, and reading every running
 * job's count every 30 seconds. A command source runs on its own interval.
 * When a job's process has ended, the count is read once more before the job
 * is judged, so the last items it wrote are counted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../infrastructure/logger.js';
import { CONFIG_DIR } from '../../utils/constants.js';
import { COMMAND_EVERY_MS, CountError, JobCounter, countAllLines, describeSource, processAlive } from './job-count.js';
import { JobProgressStore, ProgressError, endedAt, type JobProgress, type JobSource, type JobStart } from './job-progress.js';

const logger = createLogger('JobWatch');

/** How often running jobs are read as a safety-net poll. */
export const JOB_READ_INTERVAL_MS = 30_000;
/** Debounce for fs.watch live updates so rapid file writes coalesce to ~1s SSE ticks. */
const LIVE_WATCH_DEBOUNCE_MS = 1_000;

/** What `lattice job start` / `lattice run` sends. Paths are absolute; the CLI resolves them from where it runs. */
export interface JobStartRequest {
  session: string;
  label: string;
  files?: string;
  lines?: string;
  match?: string;
  command?: string;
  cwd?: string;
  every?: number;
  eventsFile?: string;
  total?: number;
  totalLines?: string;
  unit?: string;
  pid?: number;
  pgid?: number;
  managed?: boolean;
  runCommand?: string;
  each?: number;
}

export interface JobWatchDeps {
  store?: JobProgressStore;
  counter?: JobCounter;
  alive?: (pid: number) => boolean;
  /** Disable fs.watch in deterministic unit tests. */
  liveWatch?: boolean;
}

interface LiveWatcher {
  watcher: fs.FSWatcher;
  timer: NodeJS.Timeout | null;
}

export class JobWatch {
  readonly store: JobProgressStore;
  private readonly counter: JobCounter;
  private readonly alive: (pid: number) => boolean;
  private readonly liveWatchEnabled: boolean;
  private readonly fsWatchers = new Map<string, LiveWatcher>();
  private reading = false;

  constructor(deps: JobWatchDeps = {}) {
    this.store = deps.store ?? new JobProgressStore(path.join(CONFIG_DIR, 'job-progress.json'));
    this.counter = deps.counter ?? new JobCounter();
    this.alive = deps.alive ?? processAlive;
    this.liveWatchEnabled = deps.liveWatch ?? true;
  }

  /** Start a job: work out its source and total, read the count once, and record it. Throws ProgressError with what to fix. */
  async start(request: JobStartRequest, now = Date.now()): Promise<{ job: JobProgress; source: string }> {
    const source = sourceOf(request);
    let total = request.total;
    let totalFrom: string | undefined;
    if (request.totalLines !== undefined) {
      if (total !== undefined) throw new ProgressError('Give the total once: --total or --total-lines, not both.');
      if (!path.isAbsolute(request.totalLines)) throw new ProgressError('--total-lines needs a path.');
      try {
        total = countAllLines(request.totalLines);
      } catch (error) {
        throw new ProgressError(`Can't read the total: ${message(error)}.`);
      }
      totalFrom = `lines in ${request.totalLines}`;
      if (total === 0) throw new ProgressError(`${request.totalLines} has no lines, so the total would be 0.`);
    }
    if (total === undefined) {
      if (request.managed && source.kind === 'events') {
        total = 0;
      } else {
        throw new ProgressError('Say how many items there are: --total N, or --total-lines <file> to count the lines of the input.');
      }
    }
    if (request.pid !== undefined && (!Number.isInteger(request.pid) || request.pid <= 0 || !this.alive(request.pid))) {
      throw new ProgressError(`No process ${request.pid} is running. Give --pid the process doing the work (in a shell, $! right after starting it in the background).`);
    }
    const label = request.label.trim();
    const key = jobKey(request.session, label);
    this.counter.forget(key);
    let count = 0;
    if (source.kind !== 'events') {
      try {
        count = await this.counter.count(key, source);
      } catch (error) {
        this.counter.forget(key);
        throw new ProgressError(`Can't read the count from ${describeSource(source)}: ${message(error)}. Nothing was started; fix the source and start it again.`);
      }
    }
    const start: JobStart = {
      session: request.session,
      label,
      source,
      total,
      ...(request.unit ? { unit: request.unit } : {}),
      ...(totalFrom ? { totalFrom } : {}),
      ...(request.pid !== undefined ? { pid: request.pid } : {}),
      ...(request.pgid !== undefined ? { pgid: request.pgid } : {}),
      ...(request.managed ? { managed: true } : {}),
      ...(request.runCommand ? { command: request.runCommand } : {}),
      ...(request.each !== undefined ? { each: request.each } : {}),
    };
    try {
      const job = this.store.start(start, count, now);
      this.ensureWatcher(job);
      return { job, source: describeSource(source) };
    } catch (error) {
      this.counter.forget(key);
      throw error;
    }
  }

  /** Attach fs.watch handles for any already-running local file/line jobs (called on server startup). */
  ensureAllWatchers(now = Date.now()): void {
    for (const job of this.store.running(now)) {
      this.ensureWatcher(job);
    }
  }

  /** Stop a running local job (sending SIGTERM to its process group when Lattice owns it). */
  stopJob(session: string, label: string, why: string, now = Date.now()): JobProgress {
    const existing = this.store.get(session, label, now);
    if (existing && endedAt(existing) === undefined && existing.managed) {
      const target = existing.pgid ?? existing.pid;
      if (target) {
        try {
          process.kill(existing.pgid ? -existing.pgid : target, 'SIGTERM');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
            logger.warn('Failed to signal managed job process', { session, label, target, error: message(err) });
          }
        }
      }
    }
    const stopped = this.store.stop(session, label, why, now);
    const key = jobKey(session, label);
    this.unwatch(key);
    this.counter.forget(key);
    return stopped;
  }

  /** Close all live fs.watch handles cleanly (on server shutdown). */
  closeWatchers(): void {
    for (const key of [...this.fsWatchers.keys()]) {
      this.unwatch(key);
    }
  }

  /** Read one running job immediately (triggered by fs.watch). */
  async readOne(session: string, label: string): Promise<void> {
    const job = this.store.get(session, label);
    if (!job || !job.source || endedAt(job) !== undefined) {
      this.unwatch(jobKey(session, label));
      return;
    }
    if (job.source.kind === 'events') return;
    const key = jobKey(job.session, job.label);
    const alive = job.pid === undefined ? undefined : this.alive(job.pid);
    let read: { count: number } | { error: string };
    try {
      read = { count: await this.counter.count(key, job.source) };
    } catch (error) {
      read = { error: message(error) };
    }
    // Managed jobs report exact exitCode via `finish()`; only mark stopped if the process vanished abruptly.
    const aliveFlag = job.managed && alive === false ? false : alive;
    const after = this.store.observe(job.session, job.label, read, aliveFlag, Date.now());
    if (after?.finishedAt !== undefined || after?.stopped) {
      this.counter.forget(key);
      this.unwatch(key);
    }
  }

  /** Read every running job whose turn has come. Never throws; one read at a time. */
  async readAll(now = Date.now()): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      for (const job of this.store.running(now)) {
        const source = job.source!;
        this.ensureWatcher(job);
        const key = jobKey(job.session, job.label);
        if (source.kind === 'events') {
          // Events-driven jobs push counts directly; only check whether a managed process died without reporting finish.
          if (job.pid !== undefined && !this.alive(job.pid)) {
            this.store.observe(job.session, job.label, { count: job.done }, false, Date.now());
            this.unwatch(key);
          }
          continue;
        }
        if (source.kind === 'command' && now - job.reportedAt < source.every - 1_000) continue;
        // Whether the process lives is asked before the read, so a read after it ended counts everything it wrote.
        const alive = job.pid === undefined ? undefined : this.alive(job.pid);
        let read: { count: number } | { error: string };
        try {
          read = { count: await this.counter.count(key, source) };
        } catch (error) {
          read = { error: message(error) };
        }
        const after = this.store.observe(job.session, job.label, read, alive, Date.now());
        if (after?.finishedAt !== undefined || after?.stopped) {
          this.counter.forget(key);
          this.unwatch(key);
        }
      }
    } catch (error) {
      logger.error('Reading job counts failed', error);
    } finally {
      this.reading = false;
    }
  }

  private ensureWatcher(job: JobProgress): void {
    if (!this.liveWatchEnabled || !job.source) return;
    if (job.source.kind !== 'lines' && job.source.kind !== 'files') return;
    const key = jobKey(job.session, job.label);
    if (this.fsWatchers.has(key)) return;
    const watchDir = job.source.kind === 'lines' ? path.dirname(job.source.file) : path.dirname(job.source.glob);
    const targetBase = job.source.kind === 'lines' ? path.basename(job.source.file) : null;
    try {
      const watcher = fs.watch(watchDir, { persistent: false }, (_eventType, filename) => {
        if (targetBase && filename && String(filename) !== targetBase) return;
        const entry = this.fsWatchers.get(key);
        if (!entry || entry.timer) return;
        entry.timer = setTimeout(() => {
          const current = this.fsWatchers.get(key);
          if (current) current.timer = null;
          void this.readOne(job.session, job.label);
        }, LIVE_WATCH_DEBOUNCE_MS);
        entry.timer.unref?.();
      });
      watcher.on('error', () => { this.unwatch(key); });
      this.fsWatchers.set(key, { watcher, timer: null });
    } catch {
      // Directory may not be watchable; the 30s safety-net poll still covers it.
    }
  }

  private unwatch(key: string): void {
    const entry = this.fsWatchers.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.watcher.close(); } catch { /* ignore */ }
    this.fsWatchers.delete(key);
  }
}

function sourceOf(request: JobStartRequest): JobSource {
  if (request.managed && request.files === undefined && request.lines === undefined && request.command === undefined) {
    return { kind: 'events', ...(request.eventsFile ? { file: request.eventsFile } : {}) };
  }
  const given = [request.files, request.lines, request.command].filter((value) => value !== undefined);
  if (given.length !== 1) {
    throw new ProgressError('Give exactly one place to count from: --files \'<glob>\', --lines <file> [--match <regex>], or --command \'<prints a number>\'.');
  }
  if (request.match !== undefined && request.lines === undefined) throw new ProgressError('--match goes with --lines.');
  if (request.every !== undefined && request.command === undefined) throw new ProgressError('--every goes with --command.');
  if (request.files !== undefined) {
    if (!path.isAbsolute(request.files)) throw new ProgressError('--files needs a path.');
    return { kind: 'files', glob: request.files };
  }
  if (request.lines !== undefined) {
    if (!path.isAbsolute(request.lines)) throw new ProgressError('--lines needs a path.');
    if (request.match !== undefined) {
      try {
        new RegExp(request.match);
      } catch (error) {
        throw new ProgressError(`--match is not a pattern Lattice can use: ${message(error)}.`);
      }
    }
    return { kind: 'lines', file: request.lines, ...(request.match !== undefined ? { match: request.match } : {}) };
  }
  if (!request.cwd || !path.isAbsolute(request.cwd)) throw new ProgressError('--command needs the folder to run in.');
  const every = request.every ?? COMMAND_EVERY_MS;
  if (!Number.isFinite(every) || every < 30_000) throw new ProgressError('--every must be at least 30s.');
  return { kind: 'command', command: request.command!, cwd: request.cwd, every };
}

function jobKey(session: string, label: string): string {
  return `${session}\u0000${label}`;
}

function message(error: unknown): string {
  if (error instanceof CountError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

let shared: JobWatch | null = null;

/** The server's one JobWatch, shared by the start route and the 30-second reads. */
export function jobWatch(): JobWatch {
  shared ??= new JobWatch();
  return shared;
}
