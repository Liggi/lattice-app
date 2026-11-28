/**
 * Synthetic lab route (`/lab/running`) rendering the real Jobs screen inside
 * the real Lattice sidebar and chrome with realistically messy local and
 * remote plugin-provider jobs (internally consistent log timestamps, multi-day history,
 * failed history item, irregular intervals, long titles, stalled, crashed,
 * skipped-on-clean-exit, indeterminate-total, and multi-stage remote provider).
 */

import { type JSX, useCallback, useMemo, useState } from 'react';
import { isActiveJobState, type JobRecord, type JobsFeedResponse } from '@/types/jobs';
import { CrossSessionSidebar } from '../CrossSessionSidebar';
import { useSessionsSidebarState } from '../../hooks/useSessionsSidebarState';
import { RunningShell, type JobsTab } from './RunningPage';

const MIN = 60_000;
const HOUR = 60 * MIN;

function hhmmss(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildSyntheticFeed(now: number): JobsFeedResponse {
  const stallLogAt = now - 16 * MIN;

  const finishedHistory: JobRecord[] = [
    {
      id: 'local:conv-jpv-2:Candidate+filter',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Candidate pool deduplication and filter pass',
      state: 'completed',
      stateReason: '229 skipped',
      session: 'conv-jpv-2',
      project: { id: 'conv-jpv-2', name: 'Onboarding v3 evaluation', kind: 'project' },
      done: 44771,
      total: 45000,
      unit: 'conversations',
      skipped: 229,
      startedAt: now - 160 * MIN,
      movedAt: now - 115 * MIN,
      updatedAt: now - 115 * MIN,
      endedAt: now - 115 * MIN,
      ratePerMin: 995,
      etaAt: null,
      etaGuess: false,
      provenance: 'Self-reported by filter_pool.py',
      command: 'python3 scripts/filter_pool.py --in data/pool_nov.parquet --out /tmp/eval/filtered.jsonl --drop-empty --dedupe-window 24h',
      pid: 41008,
      exitCode: 0,
      logTail: [
        `[${hhmmss(now - 116 * MIN)}] kept 44,771 conversations; dropped 184 duplicates, 45 empty transcripts`,
        `[${hhmmss(now - 115 * MIN)}] wrote /tmp/eval/filtered.jsonl (142.8 MB)`,
        `[${hhmmss(now - 115 * MIN)}] done in 45m 02s`,
      ],
      canStop: false,
      externalUrl: null,
      detailView: null,
    },
    {
      id: 'local:conv-hist-stop:citations',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Checking citation offsets across November draft cohort (re-run after tokenizer fix)',
      state: 'cancelled',
      stateReason: 'Replaced by rubric v12',
      session: 'conv-jpv-2',
      project: { id: 'conv-jpv-2', name: 'Onboarding v3 evaluation', kind: 'project' },
      done: 412,
      total: 1200,
      unit: 'drafts',
      startedAt: now - 247 * MIN,
      movedAt: now - 213 * MIN,
      updatedAt: now - 213 * MIN,
      endedAt: now - 213 * MIN,
      ratePerMin: 12,
      etaAt: null,
      etaGuess: false,
      provenance: 'Lines in /tmp/eval/citations.jsonl',
      command: 'python3 scripts/check_citations.py --cohort nov-drafts --tokenizer v4 --out /tmp/eval/citations.jsonl',
      logTail: [
        `[${hhmmss(now - 214 * MIN)}] checked 410/1200 drafts (12 offset mismatches)`,
        `[${hhmmss(now - 213 * MIN)}] SIGTERM received — exiting cleanly`,
      ],
      canStop: false,
      externalUrl: null,
      detailView: null,
    },
    {
      id: 'ci-runner:hist-empathy',
      provider: 'ci-runner',
      providerLabel: 'CI runner',
      label: 'Calibration sweep — empathy rubric v11',
      state: 'completed',
      stateReason: null,
      session: 'conv-det-3',
      project: { id: 'conv-det-3', name: 'Classifier v4', kind: 'project' },
      done: 640,
      total: 640,
      unit: 'people',
      startedAt: now - 318 * MIN,
      movedAt: now - 271 * MIN,
      updatedAt: now - 271 * MIN,
      endedAt: now - 271 * MIN,
      ratePerMin: 14,
      etaAt: null,
      etaGuess: false,
      provenance: 'CI runner history',
      canStop: false,
      externalUrl: 'https://ci.example.com/history/hist-empathy',
      detailView: null,
    },
    {
      id: 'local:conv-hist-failed:bq-export',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Exporting held-out safety conversations from BigQuery',
      state: 'failed',
      stateReason: 'Exited with code 1',
      session: 'conv-eval-1',
      project: { id: 'conv-eval-1', name: 'Retention cohort analysis', kind: 'project' },
      done: 1240,
      total: 4000,
      unit: 'rows',
      startedAt: now - 9 * HOUR - 22 * MIN,
      movedAt: now - 9 * HOUR - 10 * MIN,
      updatedAt: now - 9 * HOUR - 10 * MIN,
      endedAt: now - 9 * HOUR - 10 * MIN,
      ratePerMin: 103,
      etaAt: null,
      etaGuess: false,
      provenance: 'Lines in /tmp/bq-export/safety.jsonl',
      command: 'python3 scripts/bq_export.py --table safety_heldout --out /tmp/bq-export/safety.jsonl',
      exitCode: 1,
      logTail: [
        'google.api_core.exceptions.Forbidden: 403 Access Denied: BigQuery table expired credential',
      ],
      canStop: false,
      externalUrl: null,
      detailView: null,
    },
    {
      id: 'ci-runner:hist-sample',
      provider: 'ci-runner',
      providerLabel: 'CI runner',
      label: 'Dataset sampling — high-churn cohort',
      state: 'completed',
      stateReason: null,
      session: 'conv-det-3',
      project: { id: 'conv-det-3', name: 'Classifier v4', kind: 'project' },
      done: 2400,
      total: 2400,
      unit: 'examples',
      startedAt: now - 14 * HOUR - 38 * MIN,
      movedAt: now - 14 * HOUR - 14 * MIN,
      updatedAt: now - 14 * HOUR - 14 * MIN,
      endedAt: now - 14 * HOUR - 14 * MIN,
      ratePerMin: 100,
      etaAt: null,
      etaGuess: false,
      provenance: 'CI runner dataset timing',
      canStop: false,
      externalUrl: 'https://ci.example.com/models/classifier-v4/datasets/sample',
      detailView: null,
    },
    {
      id: 'local:conv-hist-cache:warm',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Embedding cache warm-up (held-out benchmark)',
      state: 'completed',
      stateReason: null,
      session: 'conv-idx-4',
      project: { id: 'conv-idx-4', name: 'Search relevance tuning', kind: 'session' },
      done: 3120,
      total: 3120,
      unit: 'chunks',
      startedAt: now - 23 * HOUR - 19 * MIN,
      movedAt: now - 23 * HOUR - 3 * MIN,
      updatedAt: now - 23 * HOUR - 3 * MIN,
      endedAt: now - 23 * HOUR - 3 * MIN,
      ratePerMin: 195,
      etaAt: null,
      etaGuess: false,
      provenance: 'Self-reported by warm_cache.py',
      canStop: false,
      externalUrl: null,
      detailView: null,
    },
    {
      id: 'local:conv-hist-rescore:borderline',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Re-scoring borderline boundary cases with temperature 0',
      state: 'completed',
      stateReason: '14 skipped',
      session: 'conv-jpv-2',
      project: { id: 'conv-jpv-2', name: 'Onboarding v3 evaluation', kind: 'project' },
      done: 274,
      total: 288,
      unit: 'cases',
      skipped: 14,
      startedAt: now - 23 * HOUR - 48 * MIN,
      movedAt: now - 23 * HOUR - 37 * MIN,
      updatedAt: now - 23 * HOUR - 37 * MIN,
      endedAt: now - 23 * HOUR - 37 * MIN,
      ratePerMin: 25,
      etaAt: null,
      etaGuess: false,
      provenance: 'Self-reported by rescore.py',
      canStop: false,
      externalUrl: null,
      detailView: null,
    },
  ];

  const jobs: JobRecord[] = [
    {
      id: 'local:conv-eval-1:Backfill+embeddings',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Historical conversation embeddings backfill (staging slice)',
      state: 'stalled',
      stateReason: 'No progress for 16 min',
      session: 'conv-eval-1',
      project: { id: 'conv-eval-1', name: 'Retention cohort analysis', kind: 'project' },
      done: 4210,
      total: 12000,
      unit: 'conversations',
      failedCount: 3,
      stage: '2 of 3 — Writing vectors',
      stages: [
        { name: 'Chunking', status: 'done' },
        { name: 'Writing vectors', status: 'active' },
        { name: 'Updating index', status: 'pending' },
      ],
      startedAt: now - 48 * MIN,
      movedAt: stallLogAt,
      updatedAt: now - 15 * MIN,
      endedAt: null,
      ratePerMin: 132,
      etaAt: null,
      etaGuess: false,
      provenance: 'Lines in /tmp/retention-backfill/written.jsonl; total from lines in /tmp/retention-backfill/input.jsonl',
      command: 'python3 scripts/backfill_embeddings.py --slice staging --concurrency 8 --retry-budget 5 --out /tmp/retention-backfill/written.jsonl',
      pid: 48219,
      exitCode: null,
      logTail: [
        `[${hhmmss(stallLogAt - 18_000)}] batch 210 written (4190/12000) p95=412ms`,
        `[${hhmmss(stallLogAt)}] batch 211 written (4210/12000) p95=438ms`,
        `[${hhmmss(stallLogAt + 22_000)}] WARN embedding API returned 429 Too Many Requests; backing off 30s (attempt 1/5)`,
        `[${hhmmss(stallLogAt + 53_000)}] WARN embedding API returned 429 Too Many Requests; backing off 60s (attempt 2/5)`,
        `[${hhmmss(stallLogAt + 114_000)}] ERROR quota bucket exhausted for project staging-embeddings; waiting on reset`,
      ],
      canStop: true,
      externalUrl: null,
      detailView: null,
    },
    {
      id: 'local:conv-eval-1:Nightly+sweep',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Nightly eval sweep — prompt delta check',
      state: 'failed',
      stateReason: 'Exited with code 1',
      session: 'conv-eval-1',
      project: { id: 'conv-eval-1', name: 'Retention cohort analysis', kind: 'project' },
      done: 89,
      total: 300,
      unit: 'cases',
      startedAt: now - 95 * MIN,
      movedAt: now - 82 * MIN,
      updatedAt: now - 82 * MIN,
      endedAt: now - 82 * MIN,
      ratePerMin: 7.1,
      etaAt: null,
      etaGuess: false,
      provenance: 'Lines in /tmp/nightly-sweep/results.jsonl',
      command: 'python3 eval/nightly_sweep.py --cases 300 --rubric-dir rubrics/v14 --out /tmp/nightly-sweep/results.jsonl',
      pid: 44102,
      exitCode: 1,
      logTail: [
        'Traceback (most recent call last):',
        '  File "eval/nightly_sweep.py", line 142, in <module>',
        '    score = rubric.evaluate(case)',
        'KeyError: "expected_valence" in fixture case_0090.json',
      ],
      canStop: false,
      externalUrl: null,
      detailView: null,
    },
    {
      id: 'local:conv-jpv-2:Arm+2+scoring',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Scoring candidate conversations against rubric v128',
      state: 'working',
      stateReason: null,
      session: 'conv-jpv-2',
      project: { id: 'conv-jpv-2', name: 'Onboarding v3 evaluation', kind: 'project' },
      done: 178,
      total: 575,
      unit: 'conversations',
      skipped: 4,
      stage: null,
      message: null,
      startedAt: now - 18 * MIN,
      movedAt: now - 4_000,
      updatedAt: now - 4_000,
      endedAt: null,
      ratePerMin: 11,
      etaAt: now + 36 * MIN,
      etaGuess: false,
      provenance: 'Self-reported by score_arm.py',
      command: 'python3 eval/score_arm.py --arm candidate-v128 --rubric v128 --out /tmp/w2s2/arm2.jsonl',
      pid: 51904,
      exitCode: null,
      logTail: [
        `[${hhmmss(now - 20_000)}] scored conv_0175 verdict=pass latency=2.1s`,
        `[${hhmmss(now - 15_000)}] skipped conv_0176 reason=empty_transcript`,
        `[${hhmmss(now - 9_000)}] scored conv_0177 verdict=pass latency=1.9s`,
        `[${hhmmss(now - 4_000)}] scored conv_0178 verdict=borderline latency=2.4s`,
      ],
      canStop: true,
      externalUrl: null,
      detailView: null,
    },
    {
      id: 'ci-runner:ds-88412',
      provider: 'ci-runner',
      providerLabel: 'CI runner',
      label: 'Adapter build — November training set',
      state: 'working',
      stateReason: null,
      session: 'conv-det-3',
      project: { id: 'conv-det-3', name: 'Classifier v4', kind: 'project' },
      done: 1840,
      total: 2400,
      unit: 'examples',
      stage: '3 of 4 — Labelling examples',
      stages: [
        { name: 'Sampling', status: 'done' },
        { name: 'Filtering', status: 'done' },
        { name: 'Labelling examples', status: 'active' },
        { name: 'Training adapter', status: 'pending' },
      ],
      startedAt: now - 27 * MIN,
      movedAt: now - 20_000,
      updatedAt: now - 10_000,
      endedAt: null,
      ratePerMin: 74,
      etaAt: now + 8 * MIN,
      etaGuess: false,
      provenance: 'CI runner dataset progress API',
      command: null,
      pid: null,
      exitCode: null,
      canStop: false,
      externalUrl: 'https://ci.example.com/models/classifier-v4/builds/ds-88412',
      detailView: null,
    },
    {
      id: 'ci-runner:pr-9012',
      provider: 'ci-runner',
      providerLabel: 'CI runner',
      label: 'Safety & crisis replay — October monitor set',
      state: 'working',
      stateReason: null,
      session: null,
      project: { id: 'ci-runner-history', name: 'Run history' },
      done: 312,
      total: 500,
      unit: 'people',
      failedCount: 2,
      stage: 'Scoring people',
      startedAt: now - 225 * MIN,
      movedAt: now - 18_000,
      updatedAt: now - 10_000,
      endedAt: null,
      ratePerMin: 1.4,
      etaAt: now + 134 * MIN,
      etaGuess: false,
      provenance: 'CI runner history (batched every 20 entries)',
      command: null,
      pid: null,
      exitCode: null,
      canStop: false,
      externalUrl: 'https://ci.example.com/history/pr-9012',
      detailView: null,
    },
    {
      id: 'local:conv-idx-4:Reindex',
      provider: 'local',
      providerLabel: 'Local',
      label: 'Rebuilding local semantic index for benchmark corpus',
      state: 'starting',
      stateReason: null,
      session: 'conv-idx-4',
      project: { id: 'conv-idx-4', name: 'Search relevance tuning', kind: 'session' },
      done: 0,
      total: null,
      unit: 'shards',
      stage: 'Scanning corpus folders',
      startedAt: now - 2 * MIN,
      movedAt: now - 2 * MIN,
      updatedAt: now - 10_000,
      endedAt: null,
      ratePerMin: null,
      etaAt: null,
      etaGuess: false,
      provenance: 'Self-reported by rebuild-index.mjs',
      command: 'node scripts/rebuild-index.mjs --corpus data/bench --threads 6 --out /tmp/bench-index',
      pid: 52110,
      exitCode: null,
      canStop: true,
      externalUrl: null,
      detailView: null,
    },
    ...finishedHistory,
  ];

  const active = jobs.filter((j) => isActiveJobState(j.state));
  return {
    jobs,
    activeCount: active.length,
    stalledCount: active.filter((j) => j.state === 'stalled').length,
    failedCount: jobs.filter((j) => j.state === 'failed' && j.endedAt != null && now - j.endedAt <= 24 * HOUR).length,
    warnings: [],
    readAt: now,
  };
}

export function RunningLab(): JSX.Element {
  const { sidebarOpen, openSidebar, closeSidebar, toggleSidebar } = useSessionsSidebarState();
  const [tab, setTab] = useState<JobsTab>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [feed, setFeed] = useState<JobsFeedResponse>(() => buildSyntheticFeed(Date.now()));

  const providers = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of feed.jobs) {
      if (!map.has(job.provider)) map.set(job.provider, job.providerLabel);
    }
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [feed]);

  const handleStop = useCallback(async (jobId: string) => {
    const now = Date.now();
    setFeed((prev) => {
      const jobs = prev.jobs.map((job) =>
        job.id === jobId
          ? { ...job, state: 'cancelled' as const, stateReason: 'Stopped from Jobs', endedAt: now, canStop: false }
          : job,
      );
      const active = jobs.filter((j) => isActiveJobState(j.state));
      return {
        ...prev,
        jobs,
        activeCount: active.length,
        stalledCount: active.filter((j) => j.state === 'stalled').length,
      };
    });
  }, []);

  return (
    <div className="h-full flex overflow-hidden">
      <CrossSessionSidebar
        currentSessionId={undefined}
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        onOpen={openSidebar}
      />
      <RunningShell
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        feed={feed}
        tab={tab}
        onSelectTab={setTab}
        providers={providers}
        providerFilter={providerFilter}
        onSelectProvider={setProviderFilter}
        onStop={handleStop}
        testId="running-lab"
      />
    </div>
  );
}
