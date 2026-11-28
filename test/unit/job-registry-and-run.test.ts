import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LatticeJobProvider } from '@liggi/lattice-plugin-kit';
import { JobProgressStore } from '../../src/services/sessions/job-progress';
import { JobWatch } from '../../src/services/sessions/job-watch';
import { collectJobsFeed, decodeLocalJobId, encodeLocalJobId } from '../../src/services/sessions/job-registry';
import { readAppendedEvents } from '../../src/cli/run-command';
import { filterJobs, formatJobDetail, formatJobsList, resolveJobMatch } from '../../src/cli/jobs-command';
import type { JobRecord, JobsFeedResponse } from '../../src/types/jobs';

const MIN = 60_000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unified-jobs-'));
}

describe('managed lattice run lifecycle', () => {
  it('completes cleanly on exit 0 even when skipped items leave done < total', () => {
    const store = new JobProgressStore(path.join(tmpDir(), 'jobs.json'));
    store.start({
      session: 'conv-a',
      label: 'Candidate pool filtered',
      source: { kind: 'events' },
      total: 45_000,
      managed: true,
      pid: process.pid,
    }, 0, 1_000);

    store.update('conv-a', 'Candidate pool filtered', {
      done: 44_771,
      skipped: 229,
      stage: 'Filtering',
    }, 61_000);

    const finished = store.finish('conv-a', 'Candidate pool filtered', {
      exitCode: 0,
      done: 44_771,
      skipped: 229,
    }, 121_000);

    expect(finished).not.toBeNull();
    expect(finished?.finishedAt).toBe(121_000);
    expect(finished?.stopped).toBeUndefined();
    expect(finished?.exitCode).toBe(0);
    expect(finished?.skipped).toBe(229);
  });

  it('marks non-zero exit as failed with exitCode and logTail', () => {
    const store = new JobProgressStore(path.join(tmpDir(), 'jobs.json'));
    store.start({
      session: 'conv-a',
      label: 'Nightly eval sweep',
      source: { kind: 'events' },
      total: 300,
      managed: true,
      pid: process.pid,
    }, 0, 1_000);

    const ended = store.finish('conv-a', 'Nightly eval sweep', {
      exitCode: 1,
      done: 89,
      logTail: ['Traceback:', 'KeyError: expected_valence'],
    }, 61_000);

    expect(ended?.finishedAt).toBeUndefined();
    expect(ended?.stopped).toBe('Exited with code 1');
    expect(ended?.exitCode).toBe(1);
    expect(ended?.logTail).toEqual(['Traceback:', 'KeyError: expected_valence']);
  });

  it('parses appended NDJSON progress events incrementally and ignores malformed lines', () => {
    const file = path.join(tmpDir(), 'events.jsonl');
    fs.writeFileSync(file, '{"done":10,"total":100,"stage":"Load"}\nnot json\n{"done":25,"skipped":2,"failed":1,"message":"ok"}\n');
    const first = readAppendedEvents(file, 0);
    expect(first.patch).toEqual({
      done: 25,
      total: 100,
      skipped: 2,
      failedCount: 1,
      stage: 'Load',
      message: 'ok',
    });

    // Partial line without trailing newline is held until complete.
    fs.appendFileSync(file, '{"done":40');
    const partial = readAppendedEvents(file, first.offset);
    expect(partial.patch).toBeNull();
    expect(partial.offset).toBe(first.offset);

    fs.appendFileSync(file, '}\n');
    const second = readAppendedEvents(file, partial.offset);
    expect(second.patch).toEqual({ done: 40 });
  });
});

describe('unified JobRegistry feed', () => {
  it('combines local jobs with plugin providers and isolates provider failures as warnings', async () => {
    const store = new JobProgressStore(path.join(tmpDir(), 'jobs.json'));
    const now = 1_700_000_000_000;
    store.start({
      session: 'conv-eval',
      label: 'Arm 2 scored',
      source: { kind: 'events' },
      total: 575,
      managed: true,
      pid: process.pid,
      command: 'python3 score.py',
    }, 0, now - 10 * MIN);
    store.update('conv-eval', 'Arm 2 scored', { done: 120 }, now - 5 * MIN);
    store.update('conv-eval', 'Arm 2 scored', { done: 180, skipped: 4 }, now - 5_000);

    const ashProvider: LatticeJobProvider = {
      id: 'ci-runner',
      label: 'CI runner',
      list: async () => ({
        jobs: [{
          id: 'ci-runner:ds-1',
          provider: 'ci-runner',
          providerLabel: 'CI runner',
          label: 'Frustration detector v4',
          state: 'working',
          done: 1800,
          total: 2400,
          unit: 'examples',
          stage: 'Stage 3 of 4 — Labelling',
          startedAt: now - 20 * MIN,
          movedAt: now - 15_000,
          updatedAt: now - 5_000,
          canStop: false,
          externalUrl: 'https://ci.example.com/ds-1',
        }],
      }),
    };

    const brokenProvider: LatticeJobProvider = {
      id: 'broken',
      label: 'BrokenCloud',
      list: async () => {
        throw new Error('Not signed in');
      },
    };

    const feed = await collectJobsFeed({
      localJobs: store.all(now),
      providers: [ashProvider, brokenProvider],
      resolveProject: (id) => ({ id, name: 'Onboarding v3' }),
      now,
    });

    expect(feed.activeCount).toBe(2);
    expect(feed.stalledCount).toBe(0);
    expect(feed.jobs).toHaveLength(2);
    expect(feed.jobs.map((j) => j.provider).sort()).toEqual(['ci-runner', 'local']);
    expect(feed.warnings).toEqual([{ provider: 'broken', providerLabel: 'BrokenCloud', message: 'Not signed in' }]);

    const local = feed.jobs.find((j) => j.provider === 'local')!;
    expect(local.state).toBe('working');
    expect(local.done).toBe(180);
    expect(local.skipped).toBe(4);
    expect(local.canStop).toBe(true);
    expect(local.project).toEqual({ id: 'conv-eval', name: 'Onboarding v3' });
    expect(local.ratePerMin).toBeGreaterThan(10);
    expect(decodeLocalJobId(encodeLocalJobId('conv-eval', 'Arm 2 scored'))).toEqual({
      session: 'conv-eval',
      label: 'Arm 2 scored',
    });
  });

  it('stops a running local job cleanly via JobWatch.stopJob', async () => {
    const store = new JobProgressStore(path.join(tmpDir(), 'jobs.json'));
    const watch = new JobWatch({ store, alive: () => true, liveWatch: false });
    await watch.start({
      session: 'conv-a',
      label: 'Batch export',
      managed: true,
      total: 100,
      pid: 999999,
    }, 1_000);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const stopped = watch.stopJob('conv-a', 'Batch export', 'Stopped from Running now', 5_000);
    expect(stopped.stopped).toBe('Stopped from Running now');
    expect(killSpy).toHaveBeenCalledWith(999999, 'SIGTERM');
    killSpy.mockRestore();
  });
});

describe('lattice jobs CLI helpers', () => {
  const now = 1_700_000_000_000;
  const sampleJobs: JobRecord[] = [
    {
      id: 'local:conv-a:Backfill%20embeddings',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Backfill embeddings',
      state: 'working',
      session: 'conv-a',
      project: { id: 'conv-proj', name: 'Memory pipeline', kind: 'project' },
      done: 420,
      total: 1000,
      unit: 'users',
      skipped: 12,
      stage: '2 of 3 — Writing vectors',
      stages: [
        { name: 'Load', status: 'done' },
        { name: 'Writing vectors', status: 'active' },
        { name: 'Verify', status: 'pending' },
      ],
      startedAt: now - 10 * MIN,
      movedAt: now - 10_000,
      updatedAt: now - 5_000,
      ratePerMin: 42,
      etaAt: now + 14 * MIN,
      command: 'python3 backfill.py',
      pid: 12345,
      logTail: ['line 1', 'line 2'],
      canStop: true,
    },
    {
      id: 'ci-runner:run-8412',
      provider: 'ci-runner',
      providerLabel: 'CI runner',
      label: 'Honesty past run',
      state: 'failed',
      stateReason: 'Worker OOM',
      done: 89,
      total: 300,
      unit: 'people',
      startedAt: now - 90 * MIN,
      movedAt: now - 35 * MIN,
      updatedAt: now - 30 * MIN,
      endedAt: now - 30 * MIN,
      externalUrl: 'https://ci.example.com/run-8412',
      canStop: false,
    },
    {
      id: 'local:conv-b:Nightly%20export',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Nightly export',
      state: 'completed',
      done: 500,
      total: 500,
      unit: 'files',
      startedAt: now - 5 * 60 * MIN,
      movedAt: now - 4 * 60 * MIN,
      updatedAt: now - 4 * 60 * MIN,
      endedAt: now - 4 * 60 * MIN,
      canStop: false,
    },
  ];

  it('filters default (active + recent failures), finished, source, and session cleanly', () => {
    expect(filterJobs(sampleJobs, { mode: 'default', now }).map((j) => j.id)).toEqual([
      'local:conv-a:Backfill%20embeddings',
      'ci-runner:run-8412',
    ]);
    expect(filterJobs(sampleJobs, { mode: 'active', now }).map((j) => j.id)).toEqual([
      'local:conv-a:Backfill%20embeddings',
    ]);
    expect(filterJobs(sampleJobs, { mode: 'finished', now }).map((j) => j.id)).toEqual([
      'ci-runner:run-8412',
      'local:conv-b:Nightly%20export',
    ]);
    expect(filterJobs(sampleJobs, { mode: 'all', source: 'ci-runner', now }).map((j) => j.id)).toEqual([
      'ci-runner:run-8412',
    ]);
    expect(filterJobs(sampleJobs, { mode: 'all', session: 'conv-proj', now }).map((j) => j.id)).toEqual([
      'local:conv-a:Backfill%20embeddings',
    ]);
  });

  it('resolves jobs by exact id, case-insensitive label, or unambiguous substring', () => {
    expect(resolveJobMatch(sampleJobs, 'ci-runner:run-8412').job?.label).toBe('Honesty past run');
    expect(resolveJobMatch(sampleJobs, 'backfill embeddings').job?.id).toBe('local:conv-a:Backfill%20embeddings');
    expect(resolveJobMatch(sampleJobs, 'run-8412').job?.id).toBe('ci-runner:run-8412');
    expect(resolveJobMatch(sampleJobs, 'missing').error).toContain('no job found');
  });

  it('formats scannable list and detail output with progress, stages, id, and log preview', () => {
    const feed: JobsFeedResponse = {
      jobs: sampleJobs,
      activeCount: 1,
      stalledCount: 0,
      failedCount: 1,
      warnings: [],
      readAt: now,
    };
    const listText = formatJobsList(feed, sampleJobs.slice(0, 2), 'default');
    expect(listText).toContain('RUNNING');
    expect(listText).toContain('Backfill embeddings');
    expect(listText).toContain('420/1,000 users (42%) (12 skipped)');
    expect(listText).toContain('id: local:conv-a:Backfill%20embeddings');
    expect(listText).toContain('1 more finished in the last 24h');

    const detailText = formatJobDetail(sampleJobs[0], now);
    expect(detailText).toContain('✓ Load  → Writing vectors  ○ Verify');
    expect(detailText).toContain('Command:    python3 backfill.py');
    expect(detailText).toContain('Recent output (last 2 of 2 captured lines):');
    expect(detailText).toContain('  line 2');
  });
});
