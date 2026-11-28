import { type JSX, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Cloud,
  Copy,
  ExternalLink,
  Play,
  Square,
  X,
  XCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { isActiveJobState, type JobLifecycleState, type JobRecord, type JobStageStep } from '@/types/jobs';
import { ErrorBoundary } from '../ErrorBoundary';
import { JobProgressBar } from '../shared/JobProgressBar';
import { SessionStateIcon } from '../shared/session-state-icon/SessionStateIcon';
import { usePlugins } from '../../plugins/PluginsContext';

export function JobStateMark({
  state,
  size = 14,
  showRunningMark = false,
}: {
  state: JobLifecycleState;
  size?: number;
  showRunningMark?: boolean;
}): JSX.Element | null {
  switch (state) {
    case 'working':
    case 'starting':
      return showRunningMark
        ? <Play size={Math.max(10, size - 2)} strokeWidth={2.2} className="shrink-0 text-sky-400/85" aria-hidden="true" />
        : null;
    case 'stalled':
      return <AlertTriangle size={size} strokeWidth={2.1} className="shrink-0 text-amber-400" aria-hidden="true" />;
    case 'waiting':
      return <Clock3 size={size} strokeWidth={2} className="shrink-0 text-amber-400" aria-hidden="true" />;
    case 'completed':
      return <Check size={size} strokeWidth={2.2} className="shrink-0 text-emerald-400/85" aria-hidden="true" />;
    case 'failed':
      return <XCircle size={size} strokeWidth={2} className="shrink-0 text-rose-400" aria-hidden="true" />;
    case 'cancelled':
      return <Square size={Math.max(11, size - 2)} strokeWidth={2} className="shrink-0 text-fg-3" aria-hidden="true" />;
  }
}

export function stateLabel(job: JobRecord): string {
  switch (job.state) {
    case 'starting': return 'Starting';
    case 'working': return 'Running';
    case 'waiting': return 'Waiting on you';
    case 'stalled': return 'Stalled';
    case 'completed': return 'Done';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Stopped';
  }
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-GB');
}

export function formatClock(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time;
  return `${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

export function formatDuration(ms: number): string {
  const mins = Math.round(Math.max(0, ms) / 60_000);
  if (mins < 1) return 'under 1 min';
  if (mins < 90) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

export function formatRate(ratePerMin: number, unit?: string): string {
  const u = unit && unit !== 'items' ? ` ${unit}` : '';
  return ratePerMin >= 1
    ? `${formatCount(Math.round(ratePerMin))}${u}/min`
    : `1 every ${formatDuration(60_000 / ratePerMin)}`;
}

export function formatZeroRate(unit?: string): string {
  const u = unit && unit !== 'items' ? ` ${unit}` : '';
  return `0${u}/min`;
}

export function jobCountLine(job: JobRecord): string | null {
  if (job.total !== null && job.total > 0) {
    const unit = job.unit && job.unit !== 'items' ? ` ${job.unit}` : '';
    return `${formatCount(job.done)} of ${formatCount(job.total)}${unit}`;
  }
  if (job.done > 0) {
    const unit = job.unit ? ` ${job.unit}` : '';
    return `${formatCount(job.done)}${unit}`;
  }
  return null;
}

function stripStagePrefix(stage: string): string {
  return stage.replace(/^Stage\s+/i, '');
}

function logLineTone(line: string): string {
  if (/\b(?:ERROR|FATAL|CRITICAL|Traceback|Exception|KeyError|ValueError|Forbidden|Access Denied)\b/.test(line)) {
    return 'text-rose-300/90';
  }
  if (/\b(?:WARN|WARNING)\b/.test(line)) {
    return 'text-amber-300/90';
  }
  return 'text-fg-2';
}

/**
 * Equal-column stage track aligned to the segmented JobProgressBar directly
 * below it (same segment count, subtle spacing so adjacent labels never touch).
 */
function StageTrack({ stages }: { stages: JobStageStep[] }): JSX.Element {
  return (
    <ol
      className="grid w-full gap-1.5 text-[11.5px] leading-4"
      style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
    >
      {stages.map((step) => (
        <li
          key={step.name}
          title={step.name}
          className="flex min-w-0 items-center gap-1 pr-1"
        >
          {step.status === 'done' && (
            <Check size={11} strokeWidth={2.2} className="shrink-0 text-fg-3" aria-hidden="true" />
          )}
          <span
            className={`min-w-0 truncate ${
              step.status === 'active'
                ? 'font-medium text-fg'
                : step.status === 'done'
                  ? 'text-fg-3'
                  : 'text-fg-3/55'
            }`}
          >
            {step.name}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface RunningDetailProps {
  job: JobRecord;
  now: number;
  compact?: boolean;
  onClose?: () => void;
  onStop?: (jobId: string) => Promise<void>;
  onDismissFailure?: (jobId: string) => void;
}

export function RunningDetail({
  job,
  now,
  compact = false,
  onClose,
  onStop,
  onDismissFailure,
}: RunningDetailProps): JSX.Element {
  const navigate = useNavigate();
  const { jobDetailViews } = usePlugins();
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const defaultLogsOpen = job.state === 'stalled' || job.state === 'failed';
  const [logsOpen, setLogsOpen] = useState(defaultLogsOpen);

  const active = isActiveJobState(job.state);
  const completedWithSkips = job.state === 'completed' && Boolean(job.skipped && job.skipped > 0 && job.total && job.done + job.skipped >= job.total);
  const countText = completedWithSkips && job.total
    ? `${formatCount(job.done)} kept, ${formatCount(job.skipped!)} skipped of ${formatCount(job.total)}${job.unit && job.unit !== 'items' ? ` ${job.unit}` : ''}`
    : jobCountLine(job);
  const pct = job.total && job.total > 0 && !completedWithSkips
    ? (job.done >= job.total ? 100 : Math.min(99, Math.round((job.done / job.total) * 100)))
    : null;

  const PluginDetail = job.detailView
    ? jobDetailViews.get(`${job.detailView.pluginId}:${job.detailView.view}`)
    : undefined;

  const handleConfirmStop = async () => {
    if (!onStop || stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await onStop(job.id);
      setConfirmingStop(false);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  const handleCopyCommand = () => {
    if (!job.command || typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(job.command).then(() => {
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1_500);
    }).catch(() => undefined);
  };

  const headerReason = job.state === 'completed' && job.skipped && job.skipped > 0
    ? null
    : job.stateReason;

  const canOpenConversation = Boolean(job.project && job.project.id.startsWith('conv-'));
  const openConvLabel = job.project?.kind === 'session' ? 'Open session' : 'Open project';
  const isRemote = job.provider !== 'local';
  const showExternalInActionSlot = active && !job.canStop && Boolean(job.externalUrl);
  const showExternalInHeader = Boolean(job.externalUrl) && !showExternalInActionSlot;

  interface FactRow {
    label: string;
    value: JSX.Element;
  }

  const facts: FactRow[] = [];

  if (job.endedAt) {
    const startClock = formatClock(job.startedAt, now);
    const endClock = formatClock(job.endedAt, now);
    const range = startClock === endClock ? startClock : `${startClock} – ${endClock}`;
    facts.push({
      label: 'Time',
      value: (
        <span className="inline-flex flex-wrap items-baseline gap-x-2 tabular-nums">
          <span className="text-fg-2">{range}</span>
          <span className="text-fg-3">{formatDuration(job.endedAt - job.startedAt)}</span>
        </span>
      ),
    });
  } else {
    facts.push({
      label: 'Started',
      value: (
        <span className="inline-flex flex-wrap items-baseline gap-x-2 tabular-nums">
          <span className="text-fg-2">{formatClock(job.startedAt, now)}</span>
          <span className="text-fg-3">{formatDuration(now - job.startedAt)} elapsed</span>
        </span>
      ),
    });
  }

  if (!job.stages && job.stage) {
    facts.push({ label: 'Stage', value: <span className="text-fg-2">{stripStagePrefix(job.stage)}</span> });
  }

  if (job.state === 'stalled') {
    facts.push({
      label: 'Pace',
      value: (
        <span className="inline-flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
          {job.ratePerMin && job.ratePerMin > 0 ? (
            <>
              <span className="text-fg-3">{formatCount(Math.round(job.ratePerMin))}</span>
              <span className="text-fg-3/60" aria-hidden="true">→</span>
              <span className="text-amber-400">{formatZeroRate(job.unit)}</span>
            </>
          ) : (
            <span className="text-amber-400">{formatZeroRate(job.unit)}</span>
          )}
        </span>
      ),
    });
  } else if (active && job.ratePerMin && job.ratePerMin > 0) {
    facts.push({
      label: 'Pace',
      value: <span className="tabular-nums text-fg-2">{formatRate(job.ratePerMin, job.unit)}</span>,
    });
  }

  const hasPendingStages = Boolean(job.stages?.some((s) => s.status === 'pending'));
  if (active && job.etaAt) {
    const left = job.etaAt - now;
    facts.push({
      label: hasPendingStages
        ? 'Est. stage finish'
        : job.etaGuess
          ? 'Typical finish'
          : 'Est. finish',
      value: (
        <span className="inline-flex flex-wrap items-baseline gap-x-2 tabular-nums">
          <span className="text-fg-2">{formatClock(job.etaAt, now)}</span>
          <span className="text-fg-3">{left < 60_000 ? 'under 1 min left' : `${formatDuration(left)} left`}</span>
        </span>
      ),
    });
  }

  const hasPrimaryActions = (active && job.canStop && onStop)
    || showExternalInActionSlot
    || (job.state === 'failed' && onDismissFailure);

  return (
    <div
      className={compact ? 'flex flex-col gap-3.5' : 'flex flex-col px-6 pt-3.5 pb-10'}
      data-testid="running-detail"
    >
      {!compact && (
        <div className="flex h-[38px] min-w-0 items-center justify-between gap-3 border-b border-line/60 pb-3 text-[12.5px]">
          <div className="flex min-w-0 items-center gap-2.5">
            {job.project ? (
              <SessionStateIcon state={{ kind: 'idle' }} variant={job.project.kind === 'session' ? 'session' : 'project'} size={14} />
            ) : (
              <Cloud size={13} strokeWidth={1.9} className="shrink-0 text-sky-400/75" aria-hidden="true" />
            )}
            <span className="min-w-0 truncate text-fg-2">{job.project?.name ?? job.providerLabel}</span>
            {isRemote && job.project && (
              <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-fg-3">
                <Cloud size={11} strokeWidth={1.9} className="text-sky-400/75" aria-hidden="true" />
                <span>{job.providerLabel}</span>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canOpenConversation && (
              <button
                type="button"
                onClick={() => void navigate(`/c/${job.project!.id}`)}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-fg-3 hover:text-fg cursor-pointer"
              >
                {openConvLabel}
                <ArrowUpRight size={13} aria-hidden="true" />
              </button>
            )}
            {showExternalInHeader && (
              <a
                href={job.externalUrl!}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-fg-3 hover:text-fg"
              >
                {job.providerLabel}
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close details"
                className="flex h-7 w-7 items-center justify-center rounded-md text-fg-3 hover:bg-surface-2 hover:text-fg cursor-pointer"
              >
                <X size={15} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* On phone, place navigation links cleanly at the top, isolated from destructive Stop */}
      {compact && (canOpenConversation || job.externalUrl) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
          {canOpenConversation && (
            <button
              type="button"
              onClick={() => void navigate(`/c/${job.project!.id}`)}
              className="inline-flex items-center gap-1 text-fg-3 hover:text-fg cursor-pointer"
            >
              {openConvLabel}
              <ArrowUpRight size={13} aria-hidden="true" />
            </button>
          )}
          {job.externalUrl && (
            <a
              href={job.externalUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--color-fg-3)', textDecoration: 'none' }}
              className="inline-flex items-center gap-1 hover:text-fg"
            >
              Open in {job.providerLabel}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      )}

      {!compact && (
        <div className="pt-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1.5 text-[12.5px]">
            <span className="inline-flex items-center gap-1.5 font-medium text-fg-2">
              <JobStateMark state={job.state} size={13} showRunningMark />
              <span>{stateLabel(job)}</span>
            </span>
            {headerReason && (
              <>
                <span className="text-fg-3/45" aria-hidden="true">—</span>
                <span className={job.state === 'stalled' ? 'text-amber-400' : job.state === 'failed' ? 'text-rose-400' : 'text-fg-3'}>
                  {headerReason}
                </span>
              </>
            )}
          </div>
          <h2 className="text-[18px] font-medium leading-snug text-fg break-words">{job.label}</h2>
        </div>
      )}

      {compact && headerReason && job.state === 'failed' && (
        <div className="text-[12.5px] text-rose-400">
          {headerReason}
        </div>
      )}

      {/* Stage track (column-aligned to bar segments) + progress bar + counts */}
      <div className={compact ? 'flex flex-col gap-2' : 'pt-4 flex flex-col gap-2'}>
        {job.stages && job.stages.length > 1 && (
          <StageTrack stages={job.stages} />
        )}
        <JobProgressBar
          done={job.done}
          total={job.total}
          state={job.state}
          skipped={job.skipped}
          failedCount={job.failedCount}
          stages={job.stages}
        />
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[13px]">
          <span className="inline-flex items-baseline gap-1.5 tabular-nums text-fg">
            <span>
              {countText ?? (job.state === 'starting' ? 'Counting items…' : 'Counting items…')}
            </span>
            {pct !== null && <span className="text-[12.5px] text-fg-3">({pct}%)</span>}
          </span>
          {((!completedWithSkips && job.skipped !== undefined && job.skipped > 0) || (job.failedCount !== undefined && job.failedCount > 0)) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums text-[12.5px] text-fg-3">
              {!completedWithSkips && job.skipped !== undefined && job.skipped > 0 && (
                <span>{formatCount(job.skipped)} skipped</span>
              )}
              {job.failedCount !== undefined && job.failedCount > 0 && (
                <span className="text-rose-400">{formatCount(job.failedCount)} failed</span>
              )}
            </div>
          )}
        </div>
        {job.message && (
          <p className="text-[13px] leading-relaxed text-fg-2 break-words">{job.message}</p>
        )}
      </div>

      {/* Isolated primary actions (Stop / Dismiss / Open in provider) */}
      {hasPrimaryActions && (
        <div className={compact ? 'flex flex-wrap items-center gap-2.5' : 'pt-4 flex flex-wrap items-center gap-2.5'}>
          {active && job.canStop && onStop && !confirmingStop && (
            <button
              type="button"
              onClick={() => { setConfirmingStop(true); setStopError(null); }}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-3 text-[13px] text-fg-2 hover:border-line-2 hover:bg-surface/60 hover:text-fg cursor-pointer"
            >
              <Square size={11} strokeWidth={2} aria-hidden="true" />
              Stop job
            </button>
          )}
          {active && job.canStop && onStop && confirmingStop && (
            <div className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="stop-confirm-inline">
              <span className="text-fg-2">Stop this job?</span>
              <button
                type="button"
                disabled={stopping}
                onClick={() => void handleConfirmStop()}
                className="flex h-8 items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/15 px-3 text-[13px] font-medium text-rose-300 hover:bg-rose-500/25 disabled:opacity-50 cursor-pointer"
              >
                {stopping ? 'Stopping…' : 'Stop job'}
              </button>
              <button
                type="button"
                disabled={stopping}
                onClick={() => setConfirmingStop(false)}
                className="flex h-8 items-center rounded-md px-2.5 text-[13px] text-fg-3 hover:text-fg-2 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          )}
          {showExternalInActionSlot && !compact && (
            <a
              href={job.externalUrl!}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--color-fg-2)', textDecoration: 'none' }}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-3 text-[13px] hover:border-line-2 hover:bg-surface/60 hover:text-fg"
            >
              Open in {job.providerLabel}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
          {job.state === 'failed' && onDismissFailure && (
            <button
              type="button"
              onClick={() => onDismissFailure(job.id)}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-3 text-[13px] text-fg-2 hover:border-line-2 hover:bg-surface/60 hover:text-fg cursor-pointer"
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
              Dismiss
            </button>
          )}
          {stopError && <span className="w-full text-[12.5px] text-rose-400">{stopError}</span>}
        </div>
      )}

      {/* Compact timing & pace summary */}
      <dl className={compact ? 'border-t border-line/60 pt-3 flex flex-col gap-2 text-[12.5px]' : 'mt-5 border-t border-line/60 pt-4 flex flex-col gap-2 text-[13px]'}>
        {facts.map((fact) => (
          <div
            key={fact.label}
            className="grid grid-cols-[104px_minmax(0,1fr)] items-baseline gap-3"
          >
            <dt className="text-fg-3">{fact.label}</dt>
            <dd className="min-w-0 break-words">{fact.value}</dd>
          </div>
        ))}
      </dl>

      {/* Command block — copy button sits outside on the label row (zero overlap, zero header bar inside code box), horizontal scroll preserves flags */}
      {job.command && (
        <div className={compact ? 'border-t border-line/60 pt-3' : 'mt-5 border-t border-line/60 pt-4'}>
          <div className="flex items-center justify-between gap-2 pb-1.5">
            <span className="text-[12px] text-fg-3">Command</span>
            <button
              type="button"
              onClick={handleCopyCommand}
              aria-label={copiedCmd ? 'Copied' : 'Copy command'}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-fg-3 hover:bg-surface hover:text-fg-2 cursor-pointer"
            >
              {copiedCmd ? <Check size={11} className="text-emerald-400" aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
              <span>{copiedCmd ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <pre className="w-full overflow-x-auto rounded-lg border border-line/70 bg-bg-2/70 px-3.5 py-2.5 font-mono text-[12px] leading-[1.6] text-fg-2">
            <code>{job.command}</code>
          </pre>
        </div>
      )}

      {/* Collapsible log tail (auto-expanded when stalled or failed; subtle WARN/ERROR tinting) */}
      {job.logTail && job.logTail.length > 0 && (
        <div className={compact ? 'border-t border-line/60 pt-3' : 'mt-5 border-t border-line/60 pt-4'}>
          <button
            type="button"
            onClick={() => setLogsOpen((open) => !open)}
            aria-expanded={logsOpen}
            className="flex items-center gap-1.5 text-[13px] font-medium text-fg-2 hover:text-fg cursor-pointer"
          >
            {logsOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            <span>Recent output</span>
            <span className="tabular-nums text-[12px] font-normal text-fg-3">{job.logTail.length} lines</span>
          </button>
          {logsOpen && (
            <pre
              data-testid="job-log-tail"
              className="mt-2.5 max-h-[280px] overflow-y-auto rounded-lg border border-line/70 bg-bg-2/70 px-3.5 py-2.5 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap break-words"
            >
              {job.logTail.map((line, idx) => (
                <span key={idx} className={`block ${logLineTone(line)}`}>
                  {line}
                </span>
              ))}
            </pre>
          )}
        </div>
      )}

      {/* Optional plugin-provided detail panel (e.g. a provider's early results) */}
      {PluginDetail && job.detailView && (
        <div className={compact ? 'border-t border-line/60 pt-4' : 'mt-5 border-t border-line/60 pt-5'}>
          <ErrorBoundary name={`job detail ${job.detailView.pluginId}`} inline>
            <PluginDetail job={job} payload={job.detailView.payload} />
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}
