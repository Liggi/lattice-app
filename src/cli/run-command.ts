/**
 * `lattice run` — run a long command under Lattice supervision so progress is
 * accurate, near-real-time, and trustworthy.
 *
 * Unlike `cmd &` + `lattice job start --pid $!`, `lattice run` owns the child
 * process group directly:
 * - Captures exact exit code (clean exit 0 with skipped/filtered items finishes
 *   cleanly instead of falsely reading as stopped short).
 * - Streams child stdout/stderr untouched while retaining a rolling 40-line log
 *   tail for `Running now`.
 * - Passes `$LATTICE_JOB_EVENTS` (an append-only NDJSON file) so scripts can
 *   push structured `{ done, total, skipped, failed, stage, message }` updates
 *   with zero dependencies.
 * - Also supports `--from-lines` / `--from-files` watched in near-real-time via
 *   `fs.watch` (~1s throttle) for unmodified scripts.
 * - Forwards `SIGINT`/`SIGTERM` cleanly to the child process group so `Stop` in
 *   `Running now` terminates the whole job cleanly.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverAuthHeaders } from './server-auth.js';
import { readServerAddress } from './session-commands.js';
import { parseJson } from '../utils/json.js';

export const RUN_USAGE = `  lattice run --session <conv-id> "<label>" [--total <n> | --total-lines <file>]
              [--from-lines <file> [--match <regex>] | --from-files '<glob>']
              [--unit <word>] [--each <time>] -- <command ...>
      Run a long command so Lattice tracks its live progress, exact exit code,
      and last 40 lines of output in Running now and the project panel.
      Pass --total only when something advances the count: --from-lines /
      --from-files (an unmodified script's output, ~1s updates via fs.watch),
      or the command appending JSON lines to $LATTICE_JOB_EVENTS, such as
      {"done":42,"total":500,"skipped":2,"stage":"Scoring"}.
      For a long command or remote wait with no item count, leave --total out:
        lattice run --session <conv-id> "<label>" -- <command ...>
      It then shows as running while the command prints output, and as stuck
      only after 20 minutes with no output.
      When one counted item takes over 20 minutes, pass --each (e.g. --each 30m).
      Clean exit 0 always finishes as completed even when skipped items leave
      done < total.
`;

/** The note printed when --total is given with nothing named to count it; null when the count has a source. */
export function unwiredTotalNote(flags: Record<string, string>): string | null {
  const counted = flags['--total'] !== undefined || flags['--total-lines'] !== undefined;
  if (!counted || flags['--from-lines'] !== undefined || flags['--from-files'] !== undefined) return null;
  return 'lattice run: note — --total without --from-lines or --from-files counts only JSON progress lines the command appends to $LATTICE_JOB_EVENTS; '
    + 'leave --total out for an uncounted wait, or pass --each <time> if one item takes over 20 minutes.\n';
}

interface EventPayload {
  done?: number;
  total?: number;
  skipped?: number;
  failedCount?: number;
  stage?: string;
  message?: string;
}

const LOG_TAIL_LIMIT = 40;
const PUSH_THROTTLE_MS = 1_000;

function fail(message: string): never {
  process.stderr.write(`lattice run: ${message}\n`);
  process.exit(1);
}

function duration(flag: string, text: string): number {
  const match = text.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  const ms = match ? (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000 : 0;
  if (ms <= 0) fail(`${flag} needs a length of time, such as 90s, 25m or 1h30m.`);
  return ms;
}

function whole(flag: string, text: string | undefined): number {
  const value = Number((text ?? '').replace(/,/g, ''));
  if (!Number.isInteger(value) || value <= 0) fail(`${flag} needs a whole number above 0.`);
  return value;
}

async function postJson(session: string, route: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const { host, port } = readServerAddress();
  const response = await fetch(`http://${host}:${port}/api/conv/${encodeURIComponent(session)}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

class RingLog {
  private lines: string[] = [];
  private partial = '';

  push(chunk: Buffer | string): void {
    const text = this.partial + chunk.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) {
      const cleaned = stripAnsi(line).trimEnd();
      if (cleaned.length === 0) continue;
      this.lines.push(cleaned.length > 400 ? `${cleaned.slice(0, 399)}…` : cleaned);
      if (this.lines.length > LOG_TAIL_LIMIT) this.lines.shift();
    }
  }

  snapshot(): string[] {
    const tail = this.partial.trim();
    if (!tail) return [...this.lines];
    const extra = stripAnsi(tail).slice(0, 400);
    return [...this.lines, extra].slice(-LOG_TAIL_LIMIT);
  }
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
}

/** Reads newly appended JSON lines from `LATTICE_JOB_EVENTS` and merges them into `latest`. */
export function readAppendedEvents(file: string, offset: number): { offset: number; patch: EventPayload | null } {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { offset, patch: null };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { offset, patch: null };
    const buf = Buffer.alloc(size - offset);
    const bytes = fs.readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString('utf-8', 0, bytes);
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) return { offset, patch: null };
    const consumed = Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf-8');
    const lines = text.slice(0, lastNewline).split('\n');
    let patch: EventPayload | null = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const parsed = parseJson(line);
        if (!parsed || typeof parsed !== 'object') continue;
        const record = parsed as Record<string, unknown>;
        patch ??= {};
        if (typeof record.done === 'number' && Number.isFinite(record.done)) patch.done = Math.max(0, Math.floor(record.done));
        if (typeof record.total === 'number' && Number.isFinite(record.total)) patch.total = Math.max(0, Math.floor(record.total));
        if (typeof record.skipped === 'number' && Number.isFinite(record.skipped)) patch.skipped = Math.max(0, Math.floor(record.skipped));
        const failed = typeof record.failed === 'number' ? record.failed : typeof record.failedCount === 'number' ? record.failedCount : undefined;
        if (failed !== undefined && Number.isFinite(failed)) patch.failedCount = Math.max(0, Math.floor(failed));
        if (typeof record.stage === 'string') patch.stage = record.stage;
        if (typeof record.message === 'string') patch.message = record.message;
      } catch {
        // Ignore malformed lines so one bad write never breaks tracking.
      }
    }
    return { offset: offset + consumed, patch };
  } finally {
    fs.closeSync(fd);
  }
}

export async function runManagedJobCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(`Usage:\n${RUN_USAGE}`);
    return;
  }
  const sep = args.indexOf('--');
  const flagArgs = sep >= 0 ? args.slice(0, sep) : args;
  const cmdArgs = sep >= 0 ? args.slice(sep + 1) : [];

  if (flagArgs.includes('-h') || flagArgs.includes('--help')) {
    process.stdout.write(`Usage:\n${RUN_USAGE}`);
    return;
  }

  const withValue = new Set(['--session', '--total', '--total-lines', '--from-lines', '--match', '--from-files', '--unit', '--each']);
  const flags: Record<string, string> = {};
  const words: string[] = [];
  for (let i = 0; i < flagArgs.length; i++) {
    const arg = flagArgs[i];
    if (withValue.has(arg)) {
      const val = flagArgs[++i];
      if (val === undefined) fail(`${arg} needs a value.`);
      flags[arg] = val;
      continue;
    }
    if (arg.startsWith('--')) fail(`unknown flag ${arg}.\n\nUsage:\n${RUN_USAGE}`);
    words.push(arg);
  }

  const session = flags['--session'] || process.env.LATTICE_JOB_SESSION || process.env.LATTICE_SESSION;
  if (!session) fail(`--session <your conv id> is required.\n\nUsage:\n${RUN_USAGE}`);
  const label = words.join(' ').trim();
  if (!label) fail(`give the job a plain-English label in quotes.\n\nUsage:\n${RUN_USAGE}`);
  if (cmdArgs.length === 0) fail(`missing command after --.\n\nUsage:\n${RUN_USAGE}`);

  const note = unwiredTotalNote(flags);
  if (note) process.stderr.write(note);

  const cwd = process.cwd();
  const abs = (p: string) => path.resolve(cwd, p);
  const eventsFile = path.join(os.tmpdir(), `lattice-job-${process.pid}-${crypto.randomBytes(4).toString('hex')}.jsonl`);
  fs.writeFileSync(eventsFile, '');

  const commandDisplay = cmdArgs.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');

  // Spawn child in its own process group so Stop / SIGTERM cleanly terminates any child subprocesses.
  const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
    cwd,
    env: { ...process.env, LATTICE_JOB_EVENTS: eventsFile, LATTICE_JOB_SESSION: session, LATTICE_JOB_LABEL: label },
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  if (!child.pid) {
    try { fs.unlinkSync(eventsFile); } catch { /* ignore */ }
    fail(`could not start ${cmdArgs[0]}.`);
  }
  const childPid = child.pid;
  const childPgid = process.platform !== 'win32' ? childPid : undefined;

  const log = new RingLog();
  // When the command last printed anything, and the last such time sent to the server.
  let lastOutputAt = 0;
  let sentOutputAt = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    log.push(chunk);
    if (chunk.length > 0) lastOutputAt = Date.now();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    log.push(chunk);
    if (chunk.length > 0) lastOutputAt = Date.now();
  });

  // Register the job with lattice-server right away (best-effort if server is restarting).
  const startBody: Record<string, unknown> = {
    label,
    managed: true,
    pid: childPid,
    ...(childPgid !== undefined ? { pgid: childPgid } : {}),
    runCommand: commandDisplay,
    eventsFile,
    ...(flags['--from-lines'] !== undefined ? { lines: abs(flags['--from-lines']) } : {}),
    ...(flags['--match'] !== undefined ? { match: flags['--match'] } : {}),
    ...(flags['--from-files'] !== undefined ? { files: abs(flags['--from-files']) } : {}),
    ...(flags['--total'] !== undefined ? { total: whole('--total', flags['--total']) } : {}),
    ...(flags['--total-lines'] !== undefined ? { totalLines: abs(flags['--total-lines']) } : {}),
    ...(flags['--unit'] !== undefined ? { unit: flags['--unit'] } : {}),
    ...(flags['--each'] !== undefined ? { each: duration('--each', flags['--each']) } : {}),
  };

  let registered = false;
  try {
    const res = await postJson(session, 'jobs', startBody);
    if (!res.ok) {
      process.stderr.write(`lattice run: warning — server rejected registration (${typeof res.data.error === 'string' ? res.data.error : res.status}); command continues.\n`);
    } else {
      registered = true;
    }
  } catch (error) {
    process.stderr.write(`lattice run: warning — could not reach Lattice server (${error instanceof Error ? error.message : String(error)}); command continues.\n`);
  }

  let eventsOffset = 0;
  let pendingPatch: EventPayload | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let latestMerged: EventPayload = {};

  const mergePatch = (patch: EventPayload) => {
    pendingPatch = { ...(pendingPatch ?? {}), ...patch };
    latestMerged = { ...latestMerged, ...patch };
  };

  /** Send new events, and new output with its time; nothing when neither has changed since the last push. */
  const push = async () => {
    const { offset, patch } = readAppendedEvents(eventsFile, eventsOffset);
    eventsOffset = offset;
    if (patch) mergePatch(patch);
    const newOutput = lastOutputAt > sentOutputAt;
    if (!registered || (!pendingPatch && !newOutput)) return;
    const toSend = pendingPatch ?? {};
    const outputAt = lastOutputAt;
    pendingPatch = null;
    sentOutputAt = outputAt;
    try {
      await postJson(session, 'jobs/update', {
        label,
        ...toSend,
        logTail: log.snapshot(),
        ...(newOutput ? { outputAt } : {}),
      });
    } catch {
      // Server might be restarting; keep latest state in `latestMerged` for next push or finish.
    }
  };

  const flushEvents = async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await push();
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { void flushEvents(); }, PUSH_THROTTLE_MS);
  };

  let eventsWatcher: fs.FSWatcher | null = null;
  try {
    eventsWatcher = fs.watch(eventsFile, { persistent: false }, () => {
      scheduleFlush();
    });
  } catch {
    // Fallback periodic check below covers platforms where file watch fails.
  }
  // Periodic log tail + events safety flush every 10s so Running now sees fresh output even between milestones.
  const periodicFlush = setInterval(() => { void push(); }, 10_000);
  periodicFlush.unref?.();

  let signalled: NodeJS.Signals | null = null;
  const forwardSignal = (sig: NodeJS.Signals) => {
    signalled = sig;
    try {
      if (childPgid) process.kill(-childPgid, sig);
      else child.kill(sig);
    } catch {
      // Process may already be gone.
    }
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', () => resolve({ code: 1, signal: null }));
  });

  clearInterval(periodicFlush);
  if (flushTimer) clearTimeout(flushTimer);
  try { eventsWatcher?.close(); } catch { /* ignore */ }

  // Final drain of events file before reporting exit outcome.
  const finalRead = readAppendedEvents(eventsFile, eventsOffset);
  if (finalRead.patch) mergePatch(finalRead.patch);
  try { fs.unlinkSync(eventsFile); } catch { /* ignore */ }

  const exitCode = exitResult.code ?? (exitResult.signal || signalled ? 143 : 1);
  const reason = exitResult.signal || signalled
    ? `Stopped by ${exitResult.signal ?? signalled}`
    : exitCode !== 0
      ? `Exited with code ${exitCode}`
      : undefined;

  if (registered) {
    try {
      await postJson(session, 'jobs/finish', {
        label,
        exitCode,
        ...latestMerged,
        logTail: log.snapshot(),
        ...(reason ? { reason } : {}),
      });
    } catch {
      // Best-effort finish report.
    }
  }

  process.exit(exitCode);
}
