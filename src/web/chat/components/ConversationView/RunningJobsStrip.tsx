import { type JSX, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cannotRead, hasStarted, isIndeterminateJob, isStalled, jobRate, quietSince } from '@/types/job-stall';
import { useActivityStream, useActivityStreamSubscription } from '@/web/chat/contexts/ActivityStreamContext';
import { SessionStateIcon } from '@/web/chat/components/shared/session-state-icon/SessionStateIcon';
import { JobProgressBar } from '@/web/chat/components/shared/JobProgressBar';
import type { JobProgress } from '@/services/sessions/job-progress';

/**
 * The long jobs running for this conversation, one line each above the
 * composer: "Conversations scored · 6,003 of 15,799 · done about 20:40".
 * Every chat shows it, a project's coordinator (its own and its workers'
 * jobs) and a plain chat alike, on desktop and phone (2026-11-20, conv-vICpxQ8AAmaJ:
 * of Jason's status chases from 28 Oct to 20 Nov, most came while the
 * conversation sat idle with a job running, which the chat never showed; a
 * plain chat has no Running list at all, and on the phone it is behind a
 * button). Only running jobs: one that ended is reported by its agent.
 */
export function RunningJobsStrip({ conversationId, hideOnDesktop = false }: { conversationId: string; hideOnDesktop?: boolean }): JSX.Element | null {
  const jobs = useLiveJobs(conversationId);
  const now = useNow(30_000);
  if (jobs.length === 0) return null;
  return (
    <div data-testid="running-jobs-strip" className={`w-full max-w-3xl px-4 mb-2 ${hideOnDesktop ? 'md:hidden' : ''}`}>
      <div className="flex w-full flex-col gap-2 rounded-lg border border-line bg-surface/80 px-3 py-2">
        {jobs.map((job) => <JobLine key={`${job.session}:${job.label}`} job={job} now={now} />)}
      </div>
    </div>
  );
}

function JobLine({ job, now }: { job: JobProgress; now: number }) {
  const status = jobStatus(job, now);
  const stuck = status.kind === 'caution';
  const hasCount = shows(job);
  const statusLabel = status.text ? status.text.charAt(0).toUpperCase() + status.text.slice(1) : null;
  return (
    <div data-testid="running-job" className="flex flex-col gap-1.5 text-[12.5px] leading-[1.35]">
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-fg-3">
          <SessionStateIcon state={stuck ? { kind: 'idle' } : { kind: 'working', level: 1 }} variant="session" size={18} />
        </span>
        <span title={job.label} className="min-w-0 flex-1 truncate text-fg">{job.label}</span>
        {hasCount && (
          <span className="shrink-0 whitespace-nowrap tabular-nums text-[12px] text-fg-2">
            {count(job.done)} of {count(job.total)}
          </span>
        )}
      </div>
      {(hasCount || statusLabel) && (
        <div className="flex items-center gap-3 pl-7">
          {hasCount && <JobBar job={job} stuck={stuck} className="flex-1" />}
          {status.kind === 'plain' && statusLabel && (
            <span className="shrink-0 whitespace-nowrap text-[12px] text-fg-3">{statusLabel}</span>
          )}
          {stuck && statusLabel && (
            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] font-medium text-amber-400">
              <AlertTriangle size={11} strokeWidth={2.25} className="shrink-0" aria-hidden />
              <span>{statusLabel}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export type Status = { kind: 'plain' | 'caution'; text: string | null };

/** What follows the count: when it will be done, that it has not started, or that it is stuck. */
export function jobStatus(job: JobProgress, now: number): Status {
  const error = cannotRead(job);
  if (error !== null) return { kind: 'caution', text: `can't read the count: ${error}` };
  if (isIndeterminateJob(job)) {
    return isStalled(job, now)
      ? { kind: 'caution', text: `no output for ${duration(now - quietSince(job))}` }
      : { kind: 'plain', text: `running, ${duration(now - job.startedAt)}${job.stage ? ` · ${job.stage}` : ''}` };
  }
  if (!hasStarted(job)) {
    return isStalled(job, now)
      ? { kind: 'caution', text: `no first item after ${duration(now - job.startedAt)}` }
      : { kind: 'plain', text: `starting, ${duration(now - job.startedAt)} so far` };
  }
  if (isStalled(job, now)) return { kind: 'caution', text: `no progress for ${duration(now - job.movedAt)}` };
  const rate = jobRate(job);
  if (rate <= 0) return { kind: 'plain', text: null };
  const left = (job.total - job.done) / rate - (now - job.movedAt);
  return { kind: 'plain', text: left < 60_000 ? 'done in under a minute' : `done about ${when(now + left, now)}` };
}

/**
 * Running jobs of this conversation and, for a coordinator, its workers (the
 * server's jobs route lists both). Refetched on any jobs-changed frame, since
 * this view does not know the coordinator's workers; the poll is a safety net.
 */
export function useLiveJobs(conversationId: string | undefined): JobProgress[] {
  const [changed, setChanged] = useState(0);
  useActivityStreamSubscription({ type: 'activity' }, (event) => {
    if ((event as { type?: string }).type === 'jobs-changed') setChanged((value) => value + 1);
  });
  const { isConnected, connectionState } = useActivityStream();
  const reconnected = connectionState.lastConnectedAt?.getTime() ?? 0;
  const [jobs, setJobs] = useState<JobProgress[]>([]);
  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    const url = `/api/conv/${encodeURIComponent(conversationId)}/jobs`;
    const load = () => void fetch(url)
      .then((r) => (r.ok ? r.json() as Promise<{ jobs: JobProgress[] }> : null))
      .then((body) => { if (alive && body) setJobs(body.jobs.filter((job) => !job.finishedAt && !job.stopped)); }, () => {});
    load();
    const timer = setInterval(load, isConnected ? 120_000 : 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [conversationId, isConnected, changed, reconnected]);
  useEffect(() => setJobs([]), [conversationId]);
  return jobs;
}

/** How far through the job is, using the unified thin flat bar across Lattice. */
export function JobBar({ job, stuck, className = '' }: { job: JobProgress; stuck: boolean; className?: string }): JSX.Element {
  return (
    <JobProgressBar
      done={job.done}
      total={job.total > 0 ? job.total : null}
      state={stuck ? 'stalled' : 'working'}
      className={className}
    />
  );
}

/** Whether there is a count to show: the job has moved, or work was already done when it was started. */
export function shows(job: JobProgress): boolean {
  return job.total > 0 && (hasStarted(job) || job.done > 0);
}

/** Whole percent done, never 100 before the last item: "15%". */
export function percent(job: JobProgress): string {
  if (job.total <= 0) return '0%';
  return `${Math.min(99, Math.floor((job.done / job.total) * 100))}%`;
}

export function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

function count(n: number): string {
  return n.toLocaleString('en-GB');
}

/** "20:40" today, "21 Nov 09:15" on a later day. */
function when(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time;
  return `${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

/** "4 min", with a non-breaking space so a wrapped line never splits it. */
function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `${minutes}\u00a0min`;
  return `${Math.round(minutes / 30) / 2} hours`;
}
