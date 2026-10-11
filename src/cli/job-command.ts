/**
 * `lattice job` — start a long job that Lattice counts from its work, or
 * stop one (thread 38265; see services/sessions/job-progress.ts).
 */

import path from 'node:path';
import { serverAuthHeaders } from './server-auth.js';
import { readServerAddress } from './session-commands.js';

export const JOB_USAGE = `  lattice job start --session <conv-id> "<label>" (--files '<glob>' | --lines <file> [--match <regex>] | --command '<prints a number>' [--every 2m])
                    (--total <n> | --total-lines <input file>) [--pid <pid>] [--each <time>]
  lattice job stop --session <conv-id> "<label>" "<why>"
      Start a long job (a backfill, a scan, a batch of runs: anything that
      takes more than a few minutes and finishes items one at a time) that
      the user sees in the project panel's Running list. Lattice counts it
      itself from where the work lands, every 30 seconds, and works out the
      rate and when it will finish from what it measured. Name one place:
        --files '<glob>'    files appearing in one folder, such as
                            'out/briefs/*.json' (quote it; only the last part
                            of the path may hold a pattern)
        --lines <file>      lines in a file, such as the run's log; with
                            --match, only lines matching the pattern
        --command '<cmd>'   a command that prints the count as its last line,
                            for counts on another machine or inside a file
                            that must be parsed; it runs every --every (2m by
                            default), for at most 10 seconds
      and the total: --total <n>, or --total-lines <file> to count the lines
      of the input. Give --pid with the process doing the work ($! after
      starting it in the background): the job then ends as stopped if the
      process exits before the count reaches the total. Without --pid, a
      job that stops moving reads as stuck. The job finishes when the count
      reaches the total; you cannot mark it finished.
      The label is what is being counted, in a few plain words the user
      would use ("Turns checked"), not how the job works. Paths resolve from
      where you run this. It reads the count once straight away and prints
      it, and refuses if the source can't be read: check the number it
      prints is what you expect. Running shows the job as Starting until its
      first item lands; if one item takes long, say how long with --each
      (25m) so Starting is not called stuck before the first can finish.
      Choose a source that moves one item at a time: a count that only moves
      when a large batch lands sits still meanwhile. If the work writes
      nothing per item, make it (print one line per finished item to a log)
      rather than counting by hand. Work with nothing Lattice can read, such
      as items you do yourself in your own turn, stays off Running: do not
      start a job for it.
      Stop a job you give up on or replace with lattice job stop, saying why.
      A job still running when your turn ends with nothing running or armed
      and no "Waiting on:" in your report is marked stopped, unless its
      --pid process is still running.
`;

function fail(message: string): never {
  process.stderr.write(`lattice job: ${message}\n`);
  process.exit(1);
}

/** "90s", "25m", "1h30m" in ms. */
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

async function post(session: string, route: string, body: unknown): Promise<Record<string, unknown>> {
  const { host, port } = readServerAddress();
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/api/conv/${encodeURIComponent(session)}/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify(body),
    });
  } catch (error) {
    fail(`could not reach the Lattice server at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) fail(typeof answer.error === 'string' ? answer.error : `the server answered ${response.status}.`);
  return answer;
}

export async function runJobCommand(args: string[]): Promise<void> {
  const verb = args[0];
  if (!verb || verb === '-h' || verb === '--help' || args.includes('-h') || args.includes('--help')) {
    process.stdout.write(`Usage:\n${JOB_USAGE}`);
    return;
  }
  if (verb !== 'start' && verb !== 'stop') fail(`unknown verb ${verb}.\n\nUsage:\n${JOB_USAGE}`);
  const flags: Record<string, string> = {};
  const words: string[] = [];
  const withValue = new Set(['--session', '--files', '--lines', '--match', '--command', '--every', '--total', '--total-lines', '--pid', '--each']);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (withValue.has(arg)) {
      const value = args[++i];
      if (value === undefined) fail(`${arg} needs a value.`);
      flags[arg] = value;
      continue;
    }
    if (arg.startsWith('--')) fail(`unknown flag ${arg}.\n\nUsage:\n${JOB_USAGE}`);
    words.push(arg);
  }
  const session = flags['--session'];
  if (!session) fail(`--session <your conv id> is required.\n\nUsage:\n${JOB_USAGE}`);

  if (verb === 'stop') {
    if (words.length !== 2) fail(`give the label and why it stopped, each in quotes.\n\nUsage:\n${JOB_USAGE}`);
    await post(session, 'jobs/stop', { label: words[0], why: words[1] });
    process.stdout.write(`${words[0]}: stopped.\n`);
    return;
  }

  const label = words.join(' ');
  if (!label.trim()) fail(`no label.\n\nUsage:\n${JOB_USAGE}`);
  const cwd = process.cwd();
  const at = (file: string) => path.resolve(cwd, file);
  const answer = await post(session, 'jobs', {
    label,
    ...(flags['--files'] !== undefined ? { files: at(flags['--files']) } : {}),
    ...(flags['--lines'] !== undefined ? { lines: at(flags['--lines']) } : {}),
    ...(flags['--match'] !== undefined ? { match: flags['--match'] } : {}),
    ...(flags['--command'] !== undefined ? { command: flags['--command'], cwd } : {}),
    ...(flags['--every'] !== undefined ? { every: duration('--every', flags['--every']) } : {}),
    ...(flags['--total'] !== undefined ? { total: whole('--total', flags['--total']) } : {}),
    ...(flags['--total-lines'] !== undefined ? { totalLines: at(flags['--total-lines']) } : {}),
    ...(flags['--pid'] !== undefined ? { pid: whole('--pid', flags['--pid']) } : {}),
    ...(flags['--each'] !== undefined ? { each: duration('--each', flags['--each']) } : {}),
  });
  const job = answer.job as { done: number; total: number; totalFrom?: string; pid?: number };
  const count = (n: number) => n.toLocaleString('en-GB');
  process.stdout.write(
    `${label}: ${count(job.done)} of ${count(job.total)} so far, counting ${String(answer.source)}`
    + `${job.totalFrom ? `; the total is the ${job.totalFrom}` : ''}${job.pid ? `; ends when process ${job.pid} does` : ''}.\n`
    + 'Lattice reads it every 30 seconds. Running shows it as Starting until the count moves.\n',
  );
}
