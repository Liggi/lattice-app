/**
 * `lattice run` jobs judged by their command's output (Colab sweep, 28 Nov
 * 2026): a job with no count, or a `$LATTICE_JOB_EVENTS` job before its first
 * item, stays healthy while its command prints and is stuck only once it goes
 * silent. Jobs counted from files or lines still stall on their count alone.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobProgressStore, type JobProgress } from '../../src/services/sessions/job-progress';
import { jobStallLine } from '../../src/services/sessions/job-stall-watch';
import { mapLocalJob } from '../../src/services/sessions/job-registry';
import { unwiredTotalNote } from '../../src/cli/run-command';
import { FIRST_ITEM_MS, isIndeterminateJob, isStalled, needsLook } from '../../src/types/job-stall';

const MIN = 60_000;
const coordinator = { kind: 'coordinator' } as const;

function job(over: Partial<JobProgress> = {}): JobProgress {
  return {
    session: 'conv-worker000', label: 'Sweep finished', source: { kind: 'events' }, managed: true,
    done: 0, total: 0, startedAt: 0, startDone: 0, reportedAt: 0, movedAt: 0, samples: [{ at: 0, done: 0 }], ...over,
  };
}

describe('a lattice run job with no count', () => {
  const sweep = job();

  it('is healthy while its command prints, long past 20 minutes', () => {
    expect(isIndeterminateJob(sweep)).toBe(true);
    const printing = { ...sweep, lastOutputAt: 33 * MIN };
    expect(isStalled(printing, 34 * MIN)).toBe(false);
    expect(mapLocalJob(printing, 34 * MIN, () => null)).toMatchObject({ state: 'working', stateReason: null });
  });

  it('is stuck once silent for 20 minutes, or twice --each, saying it printed nothing', () => {
    const silent = { ...sweep, lastOutputAt: 10 * MIN };
    expect(isStalled(silent, 10 * MIN + FIRST_ITEM_MS)).toBe(false);
    expect(isStalled(silent, 10 * MIN + FIRST_ITEM_MS + 1)).toBe(true);
    expect(isStalled({ ...silent, each: 30 * MIN }, 10 * MIN + 59 * MIN)).toBe(false);
    expect(isStalled({ ...silent, each: 30 * MIN }, 10 * MIN + 61 * MIN)).toBe(true);
    const line = jobStallLine(silent, coordinator, 34 * MIN);
    expect(line).toBe('A job you started is stuck: "Sweep finished" has produced no output for 24 min.');
    expect(line).not.toContain('first item');
    expect(mapLocalJob(silent, 34 * MIN, () => null)).toMatchObject({ state: 'stalled', stateReason: 'No output for 24 min' });
  });

  it('counts its start as output when the command never printed', () => {
    expect(isStalled(sweep, FIRST_ITEM_MS)).toBe(false);
    expect(isStalled(sweep, FIRST_ITEM_MS + 1)).toBe(true);
  });
});

describe('a lattice run job counted from $LATTICE_JOB_EVENTS', () => {
  const sweep = job({ total: 3 });

  it('is healthy before its first item while its command prints, and stuck once it goes silent', () => {
    expect(needsLook({ ...sweep, lastOutputAt: 33 * MIN }, 34 * MIN)).toBe(false);
    expect(mapLocalJob({ ...sweep, lastOutputAt: 33 * MIN }, 34 * MIN, () => null).state).toBe('starting');
    expect(needsLook(sweep, 21 * MIN)).toBe(true);
    expect(jobStallLine({ ...sweep, lastOutputAt: 5 * MIN }, coordinator, 26 * MIN)).toBe(
      'A job you started is stuck: "Sweep finished" has not finished its first item 26 min after it started, and its command has printed nothing for 21 min.',
    );
  });

  it('is judged by its count once the first item lands, however much it prints', () => {
    const moved = { ...sweep, done: 1, movedAt: 25 * MIN, samples: [{ at: 0, done: 0 }, { at: 25 * MIN, done: 1 }] };
    expect(isStalled({ ...moved, lastOutputAt: 60 * MIN }, 25 * MIN + 2 * 25 * MIN + 1)).toBe(true);
  });
});

describe('jobs counted from files or lines', () => {
  it('stall on a frozen count even while their command prints', () => {
    for (const source of [{ kind: 'lines', file: '/x/out.jsonl' }, { kind: 'files', glob: '/x/*' }] as const) {
      expect(isStalled(job({ source, total: 10, lastOutputAt: 29 * MIN }), 30 * MIN)).toBe(true);
      const moved = job({ source, total: 10, done: 2, movedAt: 5 * MIN, lastOutputAt: 29 * MIN, samples: [{ at: 0, done: 0 }, { at: 5 * MIN, done: 2 }] });
      expect(isStalled(moved, 30 * MIN)).toBe(true);
    }
  });
});

describe('the store', () => {
  it('advances lastOutputAt on output and on a stage or message, never past now, and leaves movedAt to the count', () => {
    const store = new JobProgressStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'job-output-')), 'jobs.json'));
    store.start({ session: 'conv-a', label: 'Sweep finished', source: { kind: 'events' }, total: 0, managed: true }, 0, 0);
    expect(store.update('conv-a', 'Sweep finished', { outputAt: 5 * MIN }, 6 * MIN)).toMatchObject({ lastOutputAt: 5 * MIN, movedAt: 0 });
    expect(store.update('conv-a', 'Sweep finished', { outputAt: 99 * MIN }, 7 * MIN)?.lastOutputAt).toBe(7 * MIN);
    expect(store.update('conv-a', 'Sweep finished', { outputAt: MIN }, 8 * MIN)?.lastOutputAt).toBe(7 * MIN);
    expect(store.update('conv-a', 'Sweep finished', { stage: 'Run 2 of 3' }, 9 * MIN)).toMatchObject({ lastOutputAt: 9 * MIN, movedAt: 0 });
    expect(store.update('conv-a', 'Sweep finished', { logTail: ['same'] }, 10 * MIN)?.lastOutputAt).toBe(9 * MIN);
  });
});

describe('lattice run at launch', () => {
  it('notes a --total with nothing named to count it, and only then', () => {
    expect(unwiredTotalNote({ '--total': '3' })).toContain('$LATTICE_JOB_EVENTS');
    expect(unwiredTotalNote({ '--total-lines': 'in.jsonl' })).not.toBeNull();
    expect(unwiredTotalNote({ '--total': '3', '--from-lines': 'out.jsonl' })).toBeNull();
    expect(unwiredTotalNote({ '--total': '3', '--from-files': '/x/*' })).toBeNull();
    expect(unwiredTotalNote({})).toBeNull();
  });

  it('prints the note and sends outputAt when the command prints, with no events written', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url?.endsWith('/jobs/update')) updates.push(JSON.parse(body) as Record<string, unknown>);
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const cli = path.resolve('src/cli.ts');
      const child = spawn(path.resolve('node_modules/.bin/tsx'), [cli, 'run', '--session', 'conv-test', 'Sweep finished', '--total', '3', '--', 'sh', '-c', 'echo polling; sleep 11'], {
        env: { ...process.env, LATTICE_SERVER_HOST: '127.0.0.1', LATTICE_SERVER_PORT: String(port), LATTICE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'run-cfg-')) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      expect(code).toBe(0);
      expect(stderr).toContain('--total without --from-lines or --from-files');
      const withOutput = updates.filter((update) => typeof update.outputAt === 'number');
      expect(withOutput).toHaveLength(1);
      expect(withOutput[0].logTail).toEqual(['polling']);
      // Nothing new after the one line, so no repeated empty update.
      expect(updates).toHaveLength(1);
    } finally {
      server.close();
    }
  }, 30_000);
});
