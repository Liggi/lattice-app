import type { JSX } from 'react';
import type { JobLifecycleState, JobStageStep } from '@/types/jobs';

export interface JobProgressBarProps {
  done: number;
  total: number | null;
  state: JobLifecycleState;
  skipped?: number;
  failedCount?: number;
  stages?: JobStageStep[];
  className?: string;
}

/**
 * Single unified 3px progress bar used across Jobs, the chat composer strip,
 * and the project panel.
 *
 * - Multi-stage jobs render one equal segment per stage (completed stages
 *   filled, active stage filled proportionally, pending stages empty) so a
 *   stage-only count never masquerades as whole-job progress.
 * - Completed jobs with skipped items render a two-part bar (done + muted
 *   skipped) filling 100% of the track so they read cleanly as fully processed.
 * - Unknown-total / starting jobs render a calm full-width dashed track.
 */
export function JobProgressBar({
  done,
  total,
  state,
  skipped = 0,
  failedCount = 0,
  stages,
  className = '',
}: JobProgressBarProps): JSX.Element {
  let fillClass = 'bg-sky-400/70';
  if (state === 'stalled' || state === 'waiting') fillClass = 'bg-amber-400';
  else if (state === 'failed') fillClass = 'bg-rose-400';
  else if (state === 'completed') fillClass = 'bg-emerald-400/55';
  else if (state === 'cancelled') fillClass = 'bg-fg-3/45';

  // Multi-stage segmented bar: honest whole-job visual weight.
  if (stages && stages.length > 1 && state !== 'completed') {
    const activeShare = total && total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
    return (
      <span
        aria-hidden="true"
        className={`flex h-[3px] w-full shrink-0 gap-1 ${className}`}
      >
        {stages.map((step) => {
          if (step.status === 'done') {
            return (
              <span key={step.name} className="block h-full flex-1 overflow-hidden rounded-full bg-line-2">
                <span className="block h-full w-full bg-fg-2/75" />
              </span>
            );
          }
          if (step.status === 'active') {
            const pct = done > 0 ? Math.max(activeShare, 4) : 0;
            return (
              <span key={step.name} className="block h-full flex-1 overflow-hidden rounded-full bg-line-2">
                {pct > 0 && (
                  <span
                    className={`block h-full transition-[width] duration-300 ease-out ${fillClass}`}
                    style={{ width: `${pct}%` }}
                  />
                )}
              </span>
            );
          }
          return <span key={step.name} className="block h-full flex-1 rounded-full bg-line-2" />;
        })}
      </span>
    );
  }

  const indeterminate = (state === 'starting' && done === 0) || total === null || total <= 0;

  if (indeterminate) {
    return (
      <span
        aria-hidden="true"
        className={`relative block h-[3px] w-full shrink-0 overflow-hidden rounded-full bg-line-2/70 ${className}`}
      >
        <span
          className="block h-full w-full text-sky-400/35"
          style={{
            backgroundImage: 'repeating-linear-gradient(90deg, currentColor 0 6px, transparent 6px 12px)',
          }}
        />
      </span>
    );
  }

  const safeTotal = Math.max(1, total);
  const donePct = Math.min(100, Math.max(0, (done / safeTotal) * 100));
  const rawSkippedPct = skipped > 0 ? (skipped / safeTotal) * 100 : 0;
  const rawFailedPct = failedCount > 0 ? (failedCount / safeTotal) * 100 : 0;
  const completedWithSkips = state === 'completed' && skipped > 0 && done + skipped >= safeTotal;
  const skippedPct = completedWithSkips
    ? Math.max(3, Math.min(25, rawSkippedPct))
    : rawSkippedPct >= 0.5
      ? Math.min(100 - donePct, rawSkippedPct)
      : 0;
  const failedPct = rawFailedPct >= 1 ? Math.min(100 - donePct - skippedPct, rawFailedPct) : 0;

  const finalDonePct = completedWithSkips
    ? Math.max(0, 100 - skippedPct)
    : state === 'completed' && skipped === 0 && failedCount === 0
      ? 100
      : done > 0
        ? Math.max(donePct, 1.5)
        : 0;

  return (
    <span
      aria-hidden="true"
      className={`flex h-[3px] w-full shrink-0 overflow-hidden rounded-full bg-line-2 ${className}`}
    >
      {finalDonePct > 0 && (
        <span
          className={`block h-full transition-[width] duration-300 ease-out ${fillClass}`}
          style={{ width: `${finalDonePct}%` }}
        />
      )}
      {skippedPct > 0 && (
        <span
          className="block h-full bg-fg-3/65"
          style={{ width: `${skippedPct}%` }}
        />
      )}
      {failedPct > 0 && (
        <span
          className="block h-full bg-rose-400/85"
          style={{ width: `${failedPct}%` }}
        />
      )}
    </span>
  );
}
