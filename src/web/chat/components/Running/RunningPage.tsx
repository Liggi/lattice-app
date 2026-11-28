/**
 * Jobs: one calm, full-width grouped list of every long-running job across
 * Lattice (local `lattice run` / `lattice job` work and plugin job providers),
 * with a full-height slide-over inspector drawer on desktop and
 * inline expand on phone.
 */

import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Cloud, PanelLeft, Terminal } from 'lucide-react';
import { isActiveJobState, type JobRecord, type JobsFeedResponse } from '@/types/jobs';
import { parseJson } from '../../../../utils/json.js';
import { useJobsFeed } from '../../hooks/useJobsFeed';
import { JobProgressBar } from '../shared/JobProgressBar';
import { LatticeLogo } from '../shared/LatticeLogo';
import { useNow } from '../ConversationView/RunningJobsStrip';
import {
  formatClock,
  formatCount,
  formatDuration,
  formatRate,
  formatZeroRate,
  JobStateMark,
  RunningDetail,
} from './RunningDetail';

export type JobsTab = 'all' | 'active' | 'finished';

const DISMISSED_FAILURES_KEY = 'lattice-dismissed-job-failures';
/** Match the server's 24h job retention window so sidebar `⊗` and `Needs attention` stay 1:1. */
const RECENT_FAILURE_MS = 24 * 60 * 60_000;

function loadDismissedFailures(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_FAILURES_KEY);
    if (!raw) return new Set();
    const parsed: unknown = parseJson(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissedFailures(set: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_FAILURES_KEY, JSON.stringify([...set].slice(-100)));
  } catch {
    // Ignore storage failures.
  }
}

function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function formatTimeOnly(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatRowStage(job: JobRecord): string | null {
  const active = job.stages?.find((s) => s.status === 'active');
  if (active) return active.name;
  if (!job.stage) return null;
  return /^\d+\s+of\s+\d+/.test(job.stage) ? `Stage ${job.stage}` : job.stage;
}

function shortErrorPreview(raw: string): string {
  // Strip verbose Python / Google client module prefixes so the actual error stays readable.
  return raw.replace(/^(?:[a-z_][a-z0-9_]*\.){2,}([A-Z]\w*:\s*)/, '$1');
}

/** Primary + secondary status/timing lines for the right column of each row. */
function rowTiming(job: JobRecord, now: number, inDayGroup = false): {
  primary: string;
  primaryTone: string;
  secondary?: string;
  showMark: boolean;
} {
  const clock = (at: number) => (inDayGroup ? formatTimeOnly(at) : formatClock(at, now));
  if (job.state === 'stalled') {
    const idleMs = job.done > 0 ? now - job.movedAt : now - job.startedAt;
    const stageName = formatRowStage(job);
    return {
      primary: `Stalled ${formatDuration(idleMs)}`,
      primaryTone: 'font-medium text-amber-400',
      secondary: stageName ?? formatZeroRate(job.unit),
      showMark: true,
    };
  }
  if (job.state === 'waiting') {
    return {
      primary: 'Waiting on you',
      primaryTone: 'font-medium text-amber-400',
      secondary: formatDuration(now - job.startedAt),
      showMark: true,
    };
  }
  if (job.state === 'failed') {
    const dur = job.endedAt ? formatDuration(job.endedAt - job.startedAt) : undefined;
    return {
      primary: job.endedAt ? `Failed ${clock(job.endedAt)}` : 'Failed',
      primaryTone: 'font-medium text-rose-400',
      secondary: dur ? (inDayGroup ? dur : `ran ${dur}`) : undefined,
      showMark: true,
    };
  }
  if (job.state === 'cancelled') {
    return {
      primary: job.endedAt ? `Stopped ${clock(job.endedAt)}` : 'Stopped',
      primaryTone: 'text-fg-2',
      secondary: job.endedAt ? formatDuration(job.endedAt - job.startedAt) : undefined,
      showMark: true,
    };
  }
  if (job.state === 'completed') {
    return {
      primary: job.endedAt ? clock(job.endedAt) : 'Done',
      primaryTone: 'text-fg-2',
      secondary: job.endedAt ? formatDuration(job.endedAt - job.startedAt) : undefined,
      showMark: false,
    };
  }
  if (job.state === 'starting') {
    return {
      primary: `Starting ${formatDuration(now - job.startedAt)}`,
      primaryTone: 'text-fg-2',
      secondary: formatRowStage(job) ?? undefined,
      showMark: false,
    };
  }
  // working
  let primary = 'Running';
  if (job.etaAt) {
    const left = job.etaAt - now;
    const hasPendingStages = Boolean(job.stages?.some((s) => s.status === 'pending'));
    primary = left < 60_000
      ? (hasPendingStages ? 'Stage <1m' : 'Under 1m left')
      : `${hasPendingStages ? 'Stage est. ' : 'Est. '}${formatClock(job.etaAt, now)}`;
  }
  const secondary = formatRowStage(job)
    ?? (job.ratePerMin && job.ratePerMin > 0 ? formatRate(job.ratePerMin, job.unit) : undefined);
  return { primary, primaryTone: 'text-fg', secondary, showMark: false };
}

function SourceSegmented({
  providers,
  providerFilter,
  onSelectProvider,
  compactLabels = false,
}: {
  providers: Array<{ id: string; label: string }>;
  providerFilter: string;
  onSelectProvider: (id: string) => void;
  compactLabels?: boolean;
}): JSX.Element {
  return (
    <div
      className="inline-flex items-center rounded-md border border-line/70 bg-bg-2/60 p-0.5"
      role="tablist"
      aria-label="Filter by source"
    >
      <button
        type="button"
        role="tab"
        aria-selected={providerFilter === 'all'}
        onClick={() => onSelectProvider('all')}
        className={`rounded-[5px] px-2.5 py-1 text-[12px] transition-colors cursor-pointer ${
          providerFilter === 'all' ? 'bg-surface-2 font-medium text-fg' : 'text-fg-3 hover:text-fg-2'
        }`}
      >
        {compactLabels ? 'All' : 'All sources'}
      </button>
      {providers.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={providerFilter === p.id}
          onClick={() => onSelectProvider(p.id)}
          className={`inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[12px] transition-colors cursor-pointer ${
            providerFilter === p.id ? 'bg-surface-2 font-medium text-fg' : 'text-fg-3 hover:text-fg-2'
          }`}
        >
          {p.id === 'local'
            ? <Terminal size={11} aria-hidden="true" />
            : <Cloud size={11} className={providerFilter === p.id ? 'text-sky-400/85' : 'text-sky-400/60'} aria-hidden="true" />}
          <span>{p.label}</span>
        </button>
      ))}
    </div>
  );
}

function JobTableRow({
  job,
  now,
  selected,
  expanded,
  inDayGroup,
  onSelect,
}: {
  job: JobRecord;
  now: number;
  selected: boolean;
  expanded: boolean;
  inDayGroup: boolean;
  onSelect: () => void;
}): JSX.Element {
  const timing = rowTiming(job, now, inDayGroup);
  const active = isActiveJobState(job.state);
  const hasSkips = Boolean(job.skipped && job.skipped > 0);
  const hasFailedItems = Boolean(job.failedCount && job.failedCount > 0);
  const unitSuffix = job.unit && job.unit !== 'items' ? ` ${job.unit}` : '';

  const countWithUnit = job.total && job.total > 0
    ? `${formatCount(job.done)} of ${formatCount(job.total)}${unitSuffix}`
    : job.done > 0
      ? `${formatCount(job.done)}${unitSuffix}`
      : job.total === null && active
        ? 'Counting items…'
        : null;

  const cleanDoneCount = job.done > 0
    ? `${formatCount(job.done)}${unitSuffix}`
    : 'Done';

  // Reserve the right-hand slot strictly for exceptions (never normal %).
  const exceptionNote = hasFailedItems
    ? { text: `${formatCount(job.failedCount!)} failed`, tone: 'text-rose-400' }
    : hasSkips
      ? { text: `${formatCount(job.skipped!)} skipped`, tone: 'text-fg-3' }
      : null;

  const stallHasDistinctReason = job.state === 'stalled'
    && Boolean(job.stateReason)
    && !/^No progress for\b/i.test(job.stateReason!)
    && !/^No first item after\b/i.test(job.stateReason!);

  const rawSubReason = job.state === 'failed'
    ? (job.logTail?.at(-1)?.trim() ?? job.stateReason ?? null)
    : job.state === 'cancelled'
      ? (job.stateReason ?? null)
      : stallHasDistinctReason
        ? job.stateReason!
        : null;
  const subReason = rawSubReason
    ? (job.state === 'failed' ? shortErrorPreview(rawSubReason) : rawSubReason)
    : null;

  const isRemote = job.provider !== 'local';
  const showBar = job.state !== 'completed';
  const phoneStage = formatRowStage(job);

  return (
    <button
      type="button"
      data-job-row={job.id}
      aria-current={selected ? 'true' : undefined}
      aria-expanded={expanded || undefined}
      onClick={onSelect}
      className={`group flex w-full min-w-0 flex-col gap-1.5 px-4 py-3 text-left transition-colors cursor-pointer md:grid md:grid-cols-[minmax(0,1fr)_240px_156px_18px] md:items-center md:gap-6 ${
        selected ? 'md:bg-surface-2 md:ring-1 md:ring-inset md:ring-line-2/80' : 'hover:bg-surface/65'
      }`}
    >
      {/* Phone-only top meta row: origin on left, status + chevron on right so title spans full width */}
      <span className="flex w-full min-w-0 items-center justify-between gap-2 text-[12px] leading-4 md:hidden">
        <span className="flex min-w-0 items-center gap-2.5">
          {job.project?.name && <span className="min-w-0 truncate text-fg-3">{job.project.name}</span>}
          {isRemote && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-fg-3">
              <Cloud size={11} strokeWidth={1.9} className="text-sky-400/75" aria-hidden="true" />
              <span>{job.providerLabel}</span>
            </span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
          {timing.showMark && <JobStateMark state={job.state} size={12} />}
          <span className={timing.primaryTone}>{timing.primary}</span>
          {expanded
            ? <ChevronDown size={14} className="text-fg-3" aria-hidden="true" />
            : <ChevronRight size={14} className="text-fg-3/60" aria-hidden="true" />}
        </span>
      </span>

      {/* Column 1: Job title, desktop origin, and exception reason */}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={`min-w-0 break-words text-[14.5px] md:text-[14px] leading-snug ${selected || active || job.state === 'failed' ? 'font-medium text-fg' : 'text-fg/92'}`}>
          {job.label}
        </span>

        {/* Desktop origin line */}
        <span className="hidden min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] leading-4 md:flex">
          {job.project?.name && (
            <span className="min-w-0 truncate text-fg-3">{job.project.name}</span>
          )}
          {isRemote && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-fg-3">
              <Cloud size={11} strokeWidth={1.9} className="text-sky-400/75" aria-hidden="true" />
              <span>{job.providerLabel}</span>
            </span>
          )}
        </span>

        {/* Phone stage subtitle kept separate from exceptions so `3 failed` never drops the active stage */}
        {!expanded && phoneStage && active && (
          <span className="truncate text-[12px] leading-4 text-fg-3 md:hidden">
            {phoneStage}
          </span>
        )}

        {subReason && (
          <span
            className={`${expanded ? 'hidden md:block' : 'block'} mt-0.5 truncate text-[12px] leading-4 ${
              job.state === 'failed'
                ? 'font-mono text-[11.5px] text-rose-300/85'
                : job.state === 'stalled'
                  ? 'text-amber-400/90'
                  : 'text-fg-3'
            }`}
          >
            {subReason}
          </span>
        )}
      </span>

      {/* Column 2: Progress shape + count with explicit unit */}
      <span className={`${expanded ? 'hidden md:flex' : 'flex'} mt-0.5 md:mt-0 min-w-0 flex-col gap-1.5`}>
        {showBar ? (
          <>
            <JobProgressBar
              done={job.done}
              total={job.total}
              state={job.state}
              skipped={job.skipped}
              failedCount={job.failedCount}
              stages={job.stages}
            />
            <span className="flex items-baseline justify-between gap-2 text-[12px] leading-4 tabular-nums">
              <span className="min-w-0 truncate text-fg-2">
                {countWithUnit ?? ''}
              </span>
              {exceptionNote ? (
                <span className={`shrink-0 text-right ${exceptionNote.tone}`}>
                  {exceptionNote.text}
                </span>
              ) : timing.secondary && !phoneStage ? (
                <span className="shrink-0 truncate text-right text-fg-3 md:hidden">
                  {timing.secondary}
                </span>
              ) : null}
            </span>
          </>
        ) : (
          <span className="flex flex-col gap-0.5 text-[12.5px] tabular-nums">
            <span className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-fg-2">
                {hasSkips ? (countWithUnit ?? cleanDoneCount) : cleanDoneCount}
              </span>
              {timing.secondary && <span className="shrink-0 text-fg-3 md:hidden">{timing.secondary}</span>}
            </span>
            {hasSkips && (
              <span className="text-[12px] leading-4 text-fg-3">
                {formatCount(job.skipped!)} skipped
              </span>
            )}
          </span>
        )}
      </span>

      {/* Column 3: Status / Time & Duration (desktop) */}
      <span className="hidden min-w-0 flex-col items-end gap-0.5 text-right tabular-nums md:flex">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] leading-4">
          {timing.showMark && <JobStateMark state={job.state} size={12} />}
          <span className={timing.primaryTone}>{timing.primary}</span>
        </span>
        {timing.secondary && (
          <span className="max-w-full truncate text-[12px] leading-4 text-fg-3">
            {timing.secondary}
          </span>
        )}
      </span>

      {/* Column 4: Inspect chevron (desktop) */}
      <span className="hidden justify-end md:flex" aria-hidden="true">
        <ChevronRight
          size={14}
          className={`transition-colors ${selected ? 'text-fg' : 'text-fg-3/45 group-hover:text-fg-2'}`}
        />
      </span>
    </button>
  );
}

interface JobGroupSection {
  key: string;
  heading: string;
  col2Header: string;
  col3Header: string;
  showColumnHeaders: boolean;
  items: JobRecord[];
}

export function RunningHeader({
  sidebarOpen,
  onToggleSidebar,
  tab,
  onSelectTab,
  providers,
  providerFilter,
  onSelectProvider,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  tab: JobsTab;
  onSelectTab: (tab: JobsTab) => void;
  providers: Array<{ id: string; label: string }>;
  providerFilter: string;
  onSelectProvider: (id: string) => void;
}): JSX.Element {
  const tabClass = (on: boolean): string =>
    `relative flex h-[52px] items-center text-[13.5px] transition-colors cursor-pointer ${
      on
        ? 'font-medium text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-[1.5px] after:bg-fg/80'
        : 'text-fg-3 hover:text-fg-2'
    }`;

  return (
    <div className="flex h-[52px] flex-shrink-0 items-center border-b border-line bg-bg">
      {/* Mobile / closed-sidebar chrome */}
      {!sidebarOpen && (
        <div className="flex shrink-0 items-center gap-2.5 pl-3 pr-2 sm:pl-4">
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label="Open sessions sidebar"
            className="flex h-10 w-10 items-center justify-center ui-icon-btn touch-manipulation sm:hidden"
          >
            <PanelLeft size={20} />
          </button>
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label="Open sessions sidebar"
            className="hidden p-1.5 ui-icon-btn sm:block"
          >
            <PanelLeft size={18} />
          </button>
          <span className="hidden items-center gap-2 sm:flex" aria-label="Lattice">
            <LatticeLogo size={24} interactive={true} colorScheme="gradient" />
            <span className="wordmark text-[15px] text-white">lattice</span>
          </span>
          <h1 className="text-[16px] font-semibold tracking-[-0.01em] text-fg">Jobs</h1>
        </div>
      )}

      {/* Desktop controls share the exact max-w-[960px] left/right edges as the grouped tables */}
      <div className="mx-auto hidden h-full w-full max-w-[960px] items-center justify-between px-4 sm:flex sm:px-8">
        <div className="flex items-center gap-5" role="tablist" aria-label="Job status">
          <button type="button" role="tab" aria-selected={tab === 'all'} onClick={() => onSelectTab('all')} className={tabClass(tab === 'all')}>
            All
          </button>
          <button type="button" role="tab" aria-selected={tab === 'active'} onClick={() => onSelectTab('active')} className={tabClass(tab === 'active')}>
            Active
          </button>
          <button type="button" role="tab" aria-selected={tab === 'finished'} onClick={() => onSelectTab('finished')} className={tabClass(tab === 'finished')}>
            Finished
          </button>
        </div>

        {providers.length > 1 && (
          <SourceSegmented
            providers={providers}
            providerFilter={providerFilter}
            onSelectProvider={onSelectProvider}
          />
        )}
      </div>

      {/* Phone-only right-aligned tabs cleanly separated from the `Jobs` title */}
      <div className="ml-auto flex items-center gap-4 pr-4 sm:hidden" role="tablist" aria-label="Job status">
        <button type="button" role="tab" aria-selected={tab === 'all'} onClick={() => onSelectTab('all')} className={tabClass(tab === 'all')}>
          All
        </button>
        <button type="button" role="tab" aria-selected={tab === 'active'} onClick={() => onSelectTab('active')} className={tabClass(tab === 'active')}>
          Active
        </button>
        <button type="button" role="tab" aria-selected={tab === 'finished'} onClick={() => onSelectTab('finished')} className={tabClass(tab === 'finished')}>
          Finished
        </button>
      </div>
    </div>
  );
}

/**
 * Full Jobs shell (header + list + full-height slide-over inspector drawer)
 * so the drawer rises cleanly over the header without stacking list filters
 * above a single job's details.
 */
export function RunningShell({
  sidebarOpen,
  onToggleSidebar,
  feed,
  tab,
  onSelectTab,
  providers,
  providerFilter,
  onSelectProvider,
  onStop,
  testId = 'running-page',
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  feed: JobsFeedResponse | null;
  tab: JobsTab;
  onSelectTab: (tab: JobsTab) => void;
  providers: Array<{ id: string; label: string }>;
  providerFilter: string;
  onSelectProvider: (id: string) => void;
  onStop?: (jobId: string) => Promise<void>;
  emptyFallback?: string;
  testId?: string;
}): JSX.Element {
  const now = useNow(30_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dismissedFailures, setDismissedFailures] = useState<Set<string>>(loadDismissedFailures);
  const listRef = useRef<HTMLDivElement | null>(null);

  const handleDismissFailure = useCallback((jobId: string) => {
    setDismissedFailures((prev) => {
      const next = new Set(prev);
      next.add(jobId);
      saveDismissedFailures(next);
      return next;
    });
  }, []);

  const filtered = useMemo(
    () => (feed ? (providerFilter === 'all' ? feed.jobs : feed.jobs.filter((job) => job.provider === providerFilter)) : []),
    [feed, providerFilter],
  );

  const isUnseenRecentFailure = useCallback((job: JobRecord) => (
    job.state === 'failed'
    && !dismissedFailures.has(job.id)
    && (job.endedAt == null || now - job.endedAt <= RECENT_FAILURE_MS)
  ), [dismissedFailures, now]);

  const attentionJobs = useMemo(
    () => filtered
      .filter((job) => job.state === 'stalled' || isUnseenRecentFailure(job))
      .sort((a, b) => (a.state === 'stalled' ? 0 : 1) - (b.state === 'stalled' ? 0 : 1) || b.updatedAt - a.updatedAt),
    [filtered, isUnseenRecentFailure],
  );

  const runningJobs = useMemo(
    () => filtered
      .filter((job) => isActiveJobState(job.state) && job.state !== 'stalled')
      .sort((a, b) => b.startedAt - a.startedAt),
    [filtered],
  );

  // On `Finished`, include every non-active job from the last 24h (even recent failures).
  // On `All`, avoid repeating unseen recent failures that already sit at the top in `Needs attention`.
  const finishedJobs = useMemo(
    () => filtered
      .filter((job) => !isActiveJobState(job.state) && (tab === 'finished' || !isUnseenRecentFailure(job)))
      .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt)),
    [filtered, tab, isUnseenRecentFailure],
  );

  const finishedByDay = useMemo(() => {
    const todayStr = new Date(now).toDateString();
    const yesterdayStr = new Date(now - 24 * 60 * 60_000).toDateString();
    const groups: Array<{ label: string; items: JobRecord[] }> = [];
    for (const job of finishedJobs) {
      const ts = job.endedAt ?? job.updatedAt;
      const d = new Date(ts);
      const dayStr = d.toDateString();
      const label = dayStr === todayStr
        ? 'Today'
        : dayStr === yesterdayStr
          ? 'Yesterday'
          : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const last = groups.at(-1);
      if (last && last.label === label) last.items.push(job);
      else groups.push({ label, items: [job] });
    }
    return groups;
  }, [finishedJobs, now]);

  const sections = useMemo<JobGroupSection[]>(() => {
    const out: JobGroupSection[] = [];
    const includeActive = tab === 'all' || tab === 'active';
    const includeFinished = tab === 'all' || tab === 'finished';

    if (includeActive && attentionJobs.length > 0) {
      out.push({
        key: 'attention',
        heading: 'Needs attention',
        col2Header: 'Progress',
        col3Header: 'Status',
        showColumnHeaders: true,
        items: attentionJobs,
      });
    }
    if (includeActive && runningJobs.length > 0) {
      out.push({
        key: 'running',
        heading: 'Running',
        col2Header: 'Progress',
        col3Header: 'Status',
        showColumnHeaders: out.length === 0,
        items: runningJobs,
      });
    }
    if (includeFinished) {
      finishedByDay.forEach((group, idx) => {
        out.push({
          key: `day:${group.label}`,
          heading: group.label,
          col2Header: 'Processed',
          col3Header: 'Finished',
          showColumnHeaders: idx === 0,
          items: group.items,
        });
      });
    }
    return out;
  }, [tab, attentionJobs, runningJobs, finishedByDay]);

  const flatRows = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const current = selectedId ? (flatRows.find((job) => job.id === selectedId) ?? null) : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || !isDesktop()) return;
      if (event.key === 'Escape' && selectedId) {
        event.preventDefault();
        setSelectedId(null);
        return;
      }
      if (!flatRows.length) return;
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        const at = current ? flatRows.findIndex((item) => item.id === current.id) : -1;
        setSelectedId(flatRows[Math.min(flatRows.length - 1, at + 1)].id);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        const at = current ? flatRows.findIndex((item) => item.id === current.id) : flatRows.length;
        setSelectedId(flatRows[Math.max(0, at - 1)].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flatRows, current, selectedId]);

  useEffect(() => {
    if (current) {
      listRef.current?.querySelector(`[data-job-row="${CSS.escape(current.id)}"]`)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [current]);

  const handleRowSelect = (jobId: string) => {
    if (isDesktop()) {
      setSelectedId((prev) => (prev === jobId ? null : jobId));
    } else {
      setExpandedId((open) => (open === jobId ? null : jobId));
    }
  };

  return (
    <div
      className={`relative flex h-full min-w-0 flex-1 flex-col overflow-hidden ${sidebarOpen ? 'hidden md:flex' : ''}`}
      data-testid={testId}
    >
      <RunningHeader
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
        tab={tab}
        onSelectTab={onSelectTab}
        providers={providers}
        providerFilter={providerFilter}
        onSelectProvider={onSelectProvider}
      />

      {feed && (
        <div ref={listRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="running-list">
          <div className="mx-auto flex w-full max-w-[960px] flex-col gap-7 px-4 py-5 sm:px-8 sm:py-7">
            {/* Mobile-only segmented source filter */}
            {providers.length > 1 && (
              <div className="-mb-3 sm:hidden">
                <SourceSegmented
                  providers={providers}
                  providerFilter={providerFilter}
                  onSelectProvider={onSelectProvider}
                  compactLabels
                />
              </div>
            )}

            {feed.warnings.length > 0 && (
              <div className="flex flex-col gap-1.5 text-[12.5px] text-fg-3">
                {feed.warnings.map((w) => (
                  <div key={w.provider} className="flex items-start gap-2">
                    <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
                    <span className="min-w-0 break-words">{w.providerLabel}: {w.message}</span>
                  </div>
                ))}
              </div>
            )}

            {sections.length === 0 && (
              <div className="py-6 text-[13.5px] text-fg-3">
                {tab === 'active'
                  ? 'Nothing running right now'
                  : tab === 'finished'
                    ? 'No finished jobs in the last 24 hours'
                    : 'No active or recent jobs'}
              </div>
            )}

            {sections.map((section) => {
              const isDayGroup = section.key.startsWith('day:');
              return (
                <section key={section.key} className="flex flex-col gap-2.5">
                  <h2 className="px-0.5 text-[16px] font-semibold tracking-[-0.015em] text-fg">
                    {section.heading}
                  </h2>
                  <div className="overflow-hidden rounded-lg border border-line/80 bg-surface/25 divide-y divide-line/60">
                    {section.showColumnHeaders && (
                      <div className="hidden grid-cols-[minmax(0,1fr)_240px_156px_18px] items-center gap-6 px-4 py-2 text-[12px] font-medium text-fg-2/75 md:grid">
                        <span>Job</span>
                        <span>{section.col2Header}</span>
                        <span className="text-right">{section.col3Header}</span>
                        <span />
                      </div>
                    )}
                    {section.items.map((job) => (
                      <div key={job.id}>
                        <JobTableRow
                          job={job}
                          now={now}
                          selected={job.id === current?.id}
                          expanded={expandedId === job.id}
                          inDayGroup={isDayGroup}
                          onSelect={() => handleRowSelect(job.id)}
                        />
                        {expandedId === job.id && (
                          <div data-inline-detail className="border-t border-line/50 bg-bg/40 px-4 pb-4 pt-3 md:hidden">
                            <RunningDetail
                              key={job.id}
                              job={job}
                              now={now}
                              compact
                              onStop={onStop}
                              onDismissFailure={isUnseenRecentFailure(job) ? handleDismissFailure : undefined}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {/* Full-height slide-over inspector drawer on desktop — covers header & dims table cleanly */}
      {current && (
        <>
          <div
            aria-hidden="true"
            onClick={() => setSelectedId(null)}
            className="hidden md:block absolute inset-0 z-20 bg-black/40"
          />
          <aside
            aria-label="Job details"
            className="hidden md:block absolute inset-y-0 right-0 z-30 w-[460px] lg:w-[500px] max-w-[92%] overflow-y-auto border-l border-line bg-bg shadow-2xl shadow-black/60"
          >
            <RunningDetail
              key={current.id}
              job={current}
              now={now}
              onClose={() => setSelectedId(null)}
              onStop={onStop}
              onDismissFailure={isUnseenRecentFailure(current) ? handleDismissFailure : undefined}
            />
          </aside>
        </>
      )}
    </div>
  );
}

export function RunningPage({
  sidebarOpen,
  onToggleSidebar,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}): JSX.Element {
  const { data, isLoading, error, refresh } = useJobsFeed({ active: true });
  const [tab, setTab] = useState<JobsTab>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');

  const providers = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of data?.jobs ?? []) {
      if (!map.has(job.provider)) map.set(job.provider, job.providerLabel);
    }
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [data]);

  const handleStop = useCallback(async (jobId: string) => {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ why: 'Stopped from Jobs' }),
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    refresh();
  }, [refresh]);

  if (!data) {
    return (
      <div
        className={`flex h-full min-w-0 flex-1 flex-col overflow-hidden ${sidebarOpen ? 'hidden md:flex' : ''}`}
        data-testid="running-page"
      >
        <RunningHeader
          sidebarOpen={sidebarOpen}
          onToggleSidebar={onToggleSidebar}
          tab={tab}
          onSelectTab={setTab}
          providers={providers}
          providerFilter={providerFilter}
          onSelectProvider={setProviderFilter}
        />
        <div className="mx-auto w-full max-w-[960px] px-4 pt-6 text-[13.5px] text-fg-3 sm:px-8">
          {isLoading ? '' : error ? `Could not load jobs: ${error instanceof Error ? error.message : String(error)}` : 'No active or recent jobs'}
        </div>
      </div>
    );
  }

  return (
    <RunningShell
      sidebarOpen={sidebarOpen}
      onToggleSidebar={onToggleSidebar}
      feed={data}
      tab={tab}
      onSelectTab={setTab}
      providers={providers}
      providerFilter={providerFilter}
      onSelectProvider={setProviderFilter}
      onStop={handleStop}
      testId="running-page"
    />
  );
}
