/**
 * `lattice jobs` — inspect, tail logs for, and stop unified Lattice jobs
 * (both local `lattice run` / `lattice job` runs and plugin job providers).
 */

import { isActiveJobState, type JobLifecycleState, type JobRecord, type JobsFeedResponse } from '../types/jobs.js';
import { serverAuthHeaders } from './server-auth.js';
import { readServerAddress } from './session-commands.js';

const RECENT_FAILURE_MS = 6 * 60 * 60_000;

export const JOBS_USAGE = `  lattice jobs [list] [--all | --finished | --active] [--source <local|provider-id|…>] [--session <conv-id>] [--json]
  lattice jobs show <id-or-label> [--json]
  lattice jobs logs <id-or-label> [--lines <n>]
  lattice jobs stop <id-or-label> ["<why>"]
      List, inspect, view recent output for, or stop jobs across local Lattice
      runs and connected plugin job providers.
      Default \`lattice jobs\` shows active jobs plus recent failures (last 6h).
      Pass --all for the full 24h feed, --finished for ended jobs only, or --json
      for machine-readable output.
`;

function fail(message: string): never {
  process.stderr.write(`lattice jobs: ${message}\n`);
  process.exit(1);
}

function stateTag(state: JobLifecycleState): string {
  switch (state) {
    case 'stalled': return 'STALLED';
    case 'working': return 'RUNNING';
    case 'starting': return 'STARTING';
    case 'waiting': return 'WAITING';
    case 'completed': return 'DONE';
    case 'failed': return 'FAILED';
    case 'cancelled': return 'STOPPED';
  }
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-GB');
}

function fmtRelativeDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min}m`;
  const hrs = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function fmtEta(etaAt: number, now: number, guess?: boolean): string {
  const diff = etaAt - now;
  if (diff <= 0) return 'finishing soon';
  const rel = fmtRelativeDuration(diff);
  return guess ? `~${rel} left (typical)` : `~${rel} left`;
}

function fmtRate(ratePerMin: number, unit?: string): string {
  const rounded = ratePerMin >= 10 ? Math.round(ratePerMin).toLocaleString('en-GB') : ratePerMin.toFixed(1);
  return `${rounded} ${unit ?? 'items'}/min`;
}

function fmtProgress(job: JobRecord): string {
  const unit = job.unit ?? 'items';
  if (job.total != null && job.total > 0) {
    const pct = Math.min(100, Math.round((job.done / job.total) * 100));
    const extras: string[] = [];
    if (job.skipped && job.skipped > 0) extras.push(`${fmtCount(job.skipped)} skipped`);
    if (job.failedCount && job.failedCount > 0) extras.push(`${fmtCount(job.failedCount)} failed`);
    const extraSuffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
    return `${fmtCount(job.done)}/${fmtCount(job.total)} ${unit} (${pct}%)${extraSuffix}`;
  }
  if (job.done > 0) return `${fmtCount(job.done)} ${unit}`;
  return job.state === 'starting' ? 'Starting' : 'No count yet';
}

export function filterJobs(
  jobs: JobRecord[],
  opts: {
    mode: 'default' | 'active' | 'finished' | 'all';
    source?: string;
    session?: string;
    now?: number;
  },
): JobRecord[] {
  const now = opts.now ?? Date.now();
  return jobs.filter((job) => {
    if (opts.source) {
      const want = opts.source.trim().toLowerCase();
      if (job.provider.toLowerCase() !== want && job.providerLabel.toLowerCase() !== want) {
        return false;
      }
    }
    if (opts.session) {
      const want = opts.session.trim();
      if (job.session !== want && job.project?.id !== want) {
        return false;
      }
    }
    const active = isActiveJobState(job.state);
    const recentFailure = job.state === 'failed' && job.endedAt != null && now - job.endedAt <= RECENT_FAILURE_MS;
    if (opts.mode === 'active') return active;
    if (opts.mode === 'finished') return !active;
    if (opts.mode === 'default') return active || recentFailure;
    return true;
  });
}

export function resolveJobMatch(
  jobs: JobRecord[],
  query: string,
): { job?: JobRecord; error?: string } {
  const q = query.trim();
  if (!q) return { error: 'provide a job id or label.' };

  const exactId = jobs.find((j) => j.id === q);
  if (exactId) return { job: exactId };

  const lower = q.toLowerCase();
  const exactLabels = jobs.filter((j) => j.label.toLowerCase() === lower);
  if (exactLabels.length === 1) return { job: exactLabels[0] };
  if (exactLabels.length > 1) {
    const activeExact = exactLabels.filter((j) => isActiveJobState(j.state));
    if (activeExact.length === 1) return { job: activeExact[0] };
    return {
      error: `multiple jobs match "${q}". Pass the exact id:\n${exactLabels.map((j) => `  ${j.id}  (${stateTag(j.state)} · ${j.label})`).join('\n')}`,
    };
  }

  const partial = jobs.filter((j) => j.id.toLowerCase().includes(lower) || j.label.toLowerCase().includes(lower));
  if (partial.length === 1) return { job: partial[0] };
  if (partial.length > 1) {
    const activePartial = partial.filter((j) => isActiveJobState(j.state));
    if (activePartial.length === 1) return { job: activePartial[0] };
    return {
      error: `ambiguous match "${q}". Pass the exact id:\n${partial.map((j) => `  ${j.id}  (${stateTag(j.state)} · ${j.label})`).join('\n')}`,
    };
  }

  return { error: `no job found matching "${q}". Run \`lattice jobs --all\` to see available jobs.` };
}

export function formatJobsList(feed: JobsFeedResponse, shown: JobRecord[], mode: 'default' | 'active' | 'finished' | 'all'): string {
  const now = feed.readAt || Date.now();
  if (shown.length === 0) {
    const finishedCount = feed.jobs.filter((j) => !isActiveJobState(j.state)).length;
    if (mode === 'default' || mode === 'active') {
      const hint = finishedCount > 0 ? ` (${finishedCount} finished in the last 24h — run \`lattice jobs --all\`)` : '';
      return `No active jobs.${hint}\n`;
    }
    return 'No matching jobs.\n';
  }

  const blocks: string[] = [];
  for (const job of shown) {
    const tag = stateTag(job.state).padEnd(8, ' ');
    const where = job.project?.name ? `${job.providerLabel} · ${job.project.name}` : job.providerLabel;
    const line1 = `${tag}  ${job.label}  [${where}]`;

    const details: string[] = [fmtProgress(job)];
    if (job.stage) details.push(job.stage);
    if (job.stateReason) {
      details.push(job.stateReason);
    } else if (job.state === 'working') {
      if (job.ratePerMin != null && job.ratePerMin > 0) details.push(fmtRate(job.ratePerMin, job.unit));
      if (job.etaAt != null) details.push(fmtEta(job.etaAt, now, job.etaGuess));
    } else if (job.endedAt != null) {
      details.push(`ended ${fmtRelativeDuration(now - job.endedAt)} ago`);
    }
    const line2 = `          ${details.join(' · ')}`;
    const line3 = `          id: ${job.id}`;
    blocks.push([line1, line2, line3].join('\n'));
  }

  const hiddenFinished = mode === 'default'
    ? feed.jobs.filter((j) => !shown.includes(j) && !isActiveJobState(j.state)).length
    : 0;
  const footer = hiddenFinished > 0
    ? `\n(${hiddenFinished} more finished in the last 24h — run \`lattice jobs --all\`)\n`
    : '\n';

  return `${blocks.join('\n\n')}${footer}`;
}

export function formatJobDetail(job: JobRecord, now = Date.now()): string {
  const lines: string[] = [];
  lines.push(`${job.label}`);
  lines.push(`State:      ${stateTag(job.state)}${job.stateReason ? ` — ${job.stateReason}` : ''}`);
  lines.push(`ID:         ${job.id}`);
  lines.push(`Source:     ${job.providerLabel}`);
  if (job.project) {
    lines.push(`Project:    ${job.project.name}${job.session ? ` (${job.session})` : ''}`);
  } else if (job.session) {
    lines.push(`Session:    ${job.session}`);
  }
  lines.push(`Progress:   ${fmtProgress(job)}`);
  if (job.stage) lines.push(`Stage:      ${job.stage}`);
  if (job.stages && job.stages.length > 0) {
    const rendered = job.stages
      .map((s) => `${s.status === 'done' ? '✓' : s.status === 'active' ? '→' : '○'} ${s.name}`)
      .join('  ');
    lines.push(`Stages:     ${rendered}`);
  }
  if (job.ratePerMin != null && job.ratePerMin > 0) {
    lines.push(`Pace:       ${fmtRate(job.ratePerMin, job.unit)}`);
  }
  if (job.etaAt != null && isActiveJobState(job.state)) {
    lines.push(`Est. finish:${' '}${fmtEta(job.etaAt, now, job.etaGuess)} (${new Date(job.etaAt).toLocaleTimeString()})`);
  }
  lines.push(`Started:    ${new Date(job.startedAt).toLocaleString()} (${fmtRelativeDuration(now - job.startedAt)} ago)`);
  if (job.endedAt != null) {
    lines.push(`Ended:      ${new Date(job.endedAt).toLocaleString()} (ran ${fmtRelativeDuration(job.endedAt - job.startedAt)})`);
  }
  if (job.message) lines.push(`Note:       ${job.message}`);
  if (job.provenance) lines.push(`Measured:   ${job.provenance}`);
  if (job.command) lines.push(`Command:    ${job.command}`);
  if (job.pid != null) lines.push(`PID:        ${job.pid}`);
  if (job.exitCode != null) lines.push(`Exit code:  ${job.exitCode}`);
  if (job.externalUrl) lines.push(`Link:       ${job.externalUrl}`);
  if (job.canStop) lines.push(`Stop:       lattice jobs stop ${JSON.stringify(job.id)}`);

  if (job.logTail && job.logTail.length > 0) {
    const preview = job.logTail.slice(-10);
    lines.push('');
    lines.push(`Recent output (last ${preview.length} of ${job.logTail.length} captured lines):`);
    for (const line of preview) lines.push(`  ${line}`);
    if (job.logTail.length > preview.length) {
      lines.push(`  … run \`lattice jobs logs ${JSON.stringify(job.id)}\` for all ${job.logTail.length} lines`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function fetchJobsFeed(): Promise<JobsFeedResponse> {
  const { host, port } = readServerAddress();
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/api/jobs`, {
      method: 'GET',
      headers: { ...serverAuthHeaders() },
    });
  } catch (error) {
    fail(`could not reach the Lattice server at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as Partial<JobsFeedResponse> & { error?: string };
  if (!response.ok || !Array.isArray(body.jobs)) {
    fail(typeof body.error === 'string' ? body.error : `the server answered ${response.status}.`);
  }
  return {
    jobs: body.jobs,
    activeCount: body.activeCount ?? 0,
    stalledCount: body.stalledCount ?? 0,
    failedCount: body.failedCount ?? 0,
    warnings: Array.isArray(body.warnings) ? body.warnings : [],
    readAt: typeof body.readAt === 'number' ? body.readAt : Date.now(),
  };
}

async function postStopJob(jobId: string, why?: string): Promise<void> {
  const { host, port } = readServerAddress();
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/api/jobs/${encodeURIComponent(jobId)}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify(why ? { why } : {}),
    });
  } catch (error) {
    fail(`could not reach the Lattice server at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    fail(typeof body.error === 'string' ? body.error : `the server answered ${response.status}.`);
  }
}

export async function runJobsCommand(args: string[]): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(`Usage:\n${JOBS_USAGE}`);
    return;
  }

  const first = args[0];
  let verb: 'list' | 'show' | 'logs' | 'stop' = 'list';
  let rest = args;
  if (first === 'list' || first === 'show' || first === 'get' || first === 'logs' || first === 'stop') {
    verb = first === 'get' ? 'show' : first;
    rest = args.slice(1);
  } else if (first && !first.startsWith('-')) {
    fail(`unknown subcommand "${first}".\n\nUsage:\n${JOBS_USAGE}`);
  }

  if (verb === 'list') {
    let mode: 'default' | 'active' | 'finished' | 'all' = 'default';
    let source: string | undefined;
    let session: string | undefined;
    let asJson = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--all') { mode = 'all'; continue; }
      if (arg === '--finished') { mode = 'finished'; continue; }
      if (arg === '--active') { mode = 'active'; continue; }
      if (arg === '--json') { asJson = true; continue; }
      if (arg === '--source') {
        const val = rest[++i];
        if (!val) fail('--source needs a provider name (e.g. local, or a plugin provider id).');
        source = val;
        continue;
      }
      if (arg === '--session') {
        const val = rest[++i];
        if (!val) fail('--session needs a conversation id.');
        session = val;
        continue;
      }
      fail(`unknown option "${arg}".\n\nUsage:\n${JOBS_USAGE}`);
    }

    const feed = await fetchJobsFeed();
    const shown = filterJobs(feed.jobs, { mode, source, session, now: feed.readAt });

    if (asJson) {
      process.stdout.write(`${JSON.stringify({ ...feed, jobs: shown }, null, 2)}\n`);
      return;
    }
    for (const warning of feed.warnings) {
      process.stderr.write(`warning: ${warning.providerLabel} — ${warning.message}\n`);
    }
    process.stdout.write(formatJobsList(feed, shown, mode));
    return;
  }

  if (verb === 'show') {
    let asJson = false;
    const words: string[] = [];
    for (const arg of rest) {
      if (arg === '--json') { asJson = true; continue; }
      if (arg.startsWith('-')) fail(`unknown option "${arg}".\n\nUsage:\n${JOBS_USAGE}`);
      words.push(arg);
    }
    const query = words.join(' ').trim();
    if (!query) fail(`give a job id or label.\n\nUsage:\n${JOBS_USAGE}`);

    const feed = await fetchJobsFeed();
    const { job, error } = resolveJobMatch(feed.jobs, query);
    if (!job) fail(error ?? 'job not found.');

    if (asJson) {
      process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
      return;
    }
    process.stdout.write(formatJobDetail(job, feed.readAt));
    return;
  }

  if (verb === 'logs') {
    let limit: number | undefined;
    const words: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--lines' || arg === '-n') {
        const raw = rest[++i];
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) fail(`${arg} needs a whole number above 0.`);
        limit = parsed;
        continue;
      }
      if (arg.startsWith('-')) fail(`unknown option "${arg}".\n\nUsage:\n${JOBS_USAGE}`);
      words.push(arg);
    }
    const query = words.join(' ').trim();
    if (!query) fail(`give a job id or label.\n\nUsage:\n${JOBS_USAGE}`);

    const feed = await fetchJobsFeed();
    const { job, error } = resolveJobMatch(feed.jobs, query);
    if (!job) fail(error ?? 'job not found.');

    const tail = job.logTail ?? [];
    if (tail.length === 0) {
      process.stderr.write(`No captured log output for "${job.label}". Only commands started with \`lattice run\` keep a rolling log tail.\n`);
      return;
    }
    const lines = limit !== undefined ? tail.slice(-limit) : tail;
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  // stop
  const words: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith('-')) fail(`unknown option "${arg}".\n\nUsage:\n${JOBS_USAGE}`);
    words.push(arg);
  }
  const query = words[0]?.trim();
  const why = words.slice(1).join(' ').trim() || 'Stopped via lattice jobs CLI';
  if (!query) fail(`give a job id or label to stop.\n\nUsage:\n${JOBS_USAGE}`);

  const feed = await fetchJobsFeed();
  const { job, error } = resolveJobMatch(feed.jobs, query);
  if (!job) fail(error ?? 'job not found.');
  if (!job.canStop) {
    const extra = job.externalUrl ? ` Manage it at ${job.externalUrl}` : '';
    fail(`"${job.label}" (${job.providerLabel}) cannot be stopped from Lattice.${extra}`);
  }
  await postStopJob(job.id, why);
  process.stdout.write(`Stopped ${job.label} (${job.id}).\n`);
}
