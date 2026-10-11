/**
 * The project panel as three answers (2026-10-09, thread 35160). Four weeks
 * of Jason's own status questions were nearly all quick checks on one thing:
 * how far a running job has got and when it ends, whether a pull request or
 * release is reviewed, green, merged or live, whether anything is actually
 * running, and what needs him. The panel shows exactly those:
 *
 * - Needs you: one line per thing he owns, the only amber in the panel.
 * - Running: one row per running worker, its task over what it is doing
 *   now, with any job it started (`lattice job start`) inside the row as
 *   done of total, its rate and when it will finish (2026-10-10, thread
 *   36692: Jason could not tell which job was whose, or which had stopped).
 *   Every number is counted by Lattice from the job's work (2026-10-11,
 *   thread 38265); a job shows only "Starting" until its first item lands.
 *   Workers with a stuck job come first, then those with a moving job, then
 *   the rest; finished jobs sit last as one faded line each until the
 *   coordinator has dealt with the report that followed them. The list is
 *   refetched when the server pushes a jobs-changed frame, with a slow poll
 *   behind it.
 * - Pull requests and releases: each at the stage it has reached, its icon
 *   filling as it advances (ShipStateIcon). What is still moving leads;
 *   what has shipped folds under one Shipped row.
 *
 * No history of finished work, no counts, nothing about how the coordinator
 * works. A section with nothing in it says so in one quiet line, so each
 * answer is always in the same place.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, PackageCheck } from 'lucide-react';
import { ShipStateIcon } from './ShipStateIcon';
import { cannotRead, hasStarted, isStalled, jobRate, needsLook, PROCESS_ENDED_REASON } from '@/types/job-stall';
import { useActivityStream, useActivityStreamSubscription } from '@/web/chat/contexts/ActivityStreamContext';
import { SessionStateIcon } from '@/web/chat/components/shared/session-state-icon/SessionStateIcon';
import { Tooltip, TooltipContentPlain, TooltipTrigger } from '@/web/chat/components/ui/tooltip';
import type { WorkerCardState } from '@/types/worker-events';
import type { JobProgress } from '@/services/sessions/job-progress';
import type { ProjectShipping, ShipItem, ShipStage } from '@/services/sessions/project-shipping';
import { workerStateLine } from './WorkersSection';

interface NarrowPanelProps {
  coordinatorId?: string;
  /** Needs you rows, already drawn. */
  attention: React.ReactNode[];
  workers: WorkerCardState[];
  coordinatorRunning: boolean;
  /** A worker's row, with the jobs it reports drawn inside it when it has any. */
  renderWorker: (worker: WorkerCardState, jobs?: WorkerJobs) => React.ReactNode;
  onOpenWorker?: (conversationId: string) => void;
}

/** The jobs a worker reports, drawn for its row, and whether any has stopped moving. */
export interface WorkerJobs {
  content: React.ReactNode;
  stalled: boolean;
}

export function NarrowPanel({ coordinatorId, attention, workers, coordinatorRunning, renderWorker, onOpenWorker }: NarrowPanelProps): JSX.Element {
  const jobs = useJobs(coordinatorId, workers);
  const shipping = usePolled<ProjectShipping>(coordinatorId && `/api/conv/${encodeURIComponent(coordinatorId)}/shipping`, 30_000);
  const now = useNow(30_000);

  const { live, ended } = splitJobs(jobs);
  const running = runningRows(workers, live, coordinatorRunning, now);
  const items = shipping?.items ? orderShipping(shipping.items) : null;

  return (
    <div data-testid="narrow-panel" className="flex flex-col gap-8">
      {attention.length > 0 && (
        <Section title="Your calls" testId="play-needs-you">{attention}</Section>
      )}
      <Section title="Running" testId="panel-running">
        {running.length === 0 && ended.length === 0 && <Empty>Nothing running</Empty>}
        {running.map((row) => (row.kind === 'worker'
          ? renderWorker(row.worker, row.jobs.length > 0
            ? { content: row.jobs.map((job) => <WorkerJob key={job.label} job={job} now={now} />), stalled: row.rank === 0 }
            : undefined)
          : <JobRow key={`${row.job.session}:${row.job.label}`} job={row.job} now={now} onOpen={onOpenWorker} />))}
        {ended.map((job) => <EndedJobRow key={`${job.session}:${job.label}`} job={job} onOpen={onOpenWorker} />)}
      </Section>
      <Section title="Pull requests and releases" testId="panel-shipping">
        {items === null && <Empty>Checking</Empty>}
        {items?.length === 0 && <Empty>No open pull requests, nothing shipped today</Empty>}
        {items?.filter((item) => !SHIPPED.includes(item.stage)).map((item) => <ShipRow key={item.key} item={item} now={now} />)}
        {items?.some((item) => SHIPPED.includes(item.stage)) && (
          <ShippedGroup>
            {items.filter((item) => SHIPPED.includes(item.stage)).map((item) => <ShipRow key={item.key} item={item} now={now} />)}
          </ShippedGroup>
        )}
      </Section>
    </div>
  );
}

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section data-testid={testId} className="flex flex-col gap-1">
      <h3 className="px-2 pb-1.5 pl-[46px] text-[13px] font-medium text-fg-2">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pl-[46px] text-[13px] text-fg-3/70">{children}</div>;
}

/** The jobs still running, and the ones that ended, most recent first. */
function splitJobs(jobs: JobProgress[]): { live: JobProgress[]; ended: JobProgress[] } {
  const endedAt = (job: JobProgress) => job.finishedAt ?? job.reportedAt;
  return {
    live: jobs.filter((job) => !job.finishedAt && !job.stopped),
    ended: jobs.filter((job) => job.finishedAt || job.stopped).sort((a, b) => endedAt(b) - endedAt(a)),
  };
}

type RunningRow =
  | { kind: 'worker'; worker: WorkerCardState; jobs: JobProgress[]; rank: number }
  | { kind: 'job'; job: JobProgress; rank: number };

/**
 * Running's rows in the order the eye should take them: stuck first, then
 * moving jobs, then workers with no job, in dispatch order within each. A
 * worker that has reported still has a row while a job of its is unfinished,
 * since that job is stuck without it. A job reported by a session that is no
 * worker here (the coordinator's own) is a row of its own.
 */
function runningRows(workers: WorkerCardState[], live: JobProgress[], coordinatorRunning: boolean, now: number): RunningRow[] {
  const rank = (own: JobProgress[]) => (own.some((job) => needsLook(job, now)) ? 0 : own.length > 0 ? 1 : 2);
  const rows: RunningRow[] = [];
  for (const worker of workers) {
    const own = live.filter((job) => job.session === worker.worker);
    const { state } = workerStateLine(worker, coordinatorRunning);
    if (state === 'Archived' || (state === 'Reported' && own.length === 0)) continue;
    rows.push({ kind: 'worker', worker, jobs: own, rank: rank(own) });
  }
  for (const job of live) {
    if (!workers.some((worker) => worker.worker === job.session)) rows.push({ kind: 'job', job, rank: rank([job]) });
  }
  return rows.sort((a, b) => a.rank - b.rank);
}

/**
 * A job inside its worker's row: the label and count, the tick strip, and
 * its rate and when it will finish, or that it is stuck. Before its first
 * item it is one line, "Starting".
 */
function WorkerJob({ job, now }: { job: JobProgress; now: number }) {
  const stuck = needsLook(job, now);
  return (
    <span data-testid="panel-job" data-job-state={jobState(job, now)} className="mt-2.5 flex flex-col">
      {hasStarted(job) ? (
        <>
          <span className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="min-w-0 break-words text-pretty text-fg-2">{job.label}</span>
            <JobCount job={job} stalled={stuck} />
          </span>
          <Ticks done={job.done} total={job.total} stalled={stuck} />
        </>
      ) : <StartingLine job={job} now={now} />}
      <JobStatus job={job} now={now} />
    </span>
  );
}

/** What the panel's tests and the row's tone go by. */
function jobState(job: JobProgress, now: number): string {
  if (cannotRead(job) !== null) return 'unreadable';
  if (!hasStarted(job)) return isStalled(job, now) ? 'starting-stalled' : 'starting';
  return isStalled(job, now) ? 'stalled' : 'moving';
}

/**
 * Before the first item there is no count worth drawing: "Starting: Turns
 * checked, 4 min", grey, amber once it has taken twice as long as its agent
 * said one item takes, or 20 minutes (`job-stall.ts`).
 */
function StartingLine({ job, now }: { job: JobProgress; now: number }) {
  const late = isStalled(job, now);
  const text = `Starting: ${job.label}, ${duration(now - job.startedAt)}`;
  return late
    ? <Caution testId="panel-job-starting">{text}</Caution>
    : <span data-testid="panel-job-starting" className="break-words text-pretty text-[12.5px] text-fg-3">{text}</span>;
}

/** The line under a job: the count can't be read, it is stuck, or its rate and time left. */
function JobStatus({ job, now }: { job: JobProgress; now: number }) {
  const error = cannotRead(job);
  if (error !== null) return <span className="mt-1.5 text-[12px]"><Caution testId="panel-job-unreadable">Can't read the count: {error}</Caution></span>;
  if (!hasStarted(job)) return null;
  if (isStalled(job, now)) return <span className="mt-1.5 text-[12px]"><Caution testId="panel-job-stuck">No progress for {duration(now - job.movedAt)}</Caution></span>;
  const pace = jobPace(job, now);
  return pace ? <span data-testid="panel-job-pace" className="mt-1.5 text-[12px] text-fg-3">{pace}</span> : null;
}

function JobCount({ job, stalled }: { job: JobProgress; stalled: boolean }) {
  return (
    <span className="shrink-0 tabular-nums text-fg-3">
      <span className={stalled ? 'text-fg-2' : 'text-fg'}>{count(job.done)}</span> of {count(job.total)}
    </span>
  );
}

/** Stuck, said so it cannot be missed: the caution icon and amber words. */
function Caution({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <span data-testid={testId} className="flex items-start gap-1.5 font-medium text-amber-400">
      <AlertTriangle size={12} strokeWidth={2.25} className="mt-[3px] shrink-0" aria-hidden />
      <span className="min-w-0 break-words text-pretty">{children}</span>
    </span>
  );
}

/**
 * "12 a minute, about 8 min left": the rate measured from the job's moves
 * (`job-stall.ts`), so nothing until it has moved twice.
 */
function jobPace(job: JobProgress, now: number): string | null {
  const rate = jobRate(job);
  if (rate <= 0) return null;
  const perMinute = rate * 60_000;
  const speed = perMinute >= 1 ? `${count(Math.round(perMinute))} a minute` : `one every ${duration(1 / rate)}`;
  return `${speed}, ${timeLeft((job.total - job.done) / rate - (now - job.movedAt)).toLowerCase()}`;
}

/**
 * A running job with no worker row to sit in: one the coordinator reports
 * for itself (2026-10-10, thread 36135; Jason picked the tick strip over a
 * plain bar and a filling cube). A cube, the label, and 48 fine ticks lit in
 * proportion, the next one cyan and breathing while the job moves: the
 * motion says it is alive, so the row does not say when it last moved. A job
 * that has stalled (`job-stall.ts`) goes still, grey ticks and an idle
 * cube, and says it is stuck.
 */
function JobRow({ job, now, onOpen }: { job: JobProgress; now: number; onOpen?: (conversationId: string) => void }) {
  const stuck = needsLook(job, now);
  const body = (
    <>
      <span className={`flex h-5 w-7 shrink-0 items-center justify-center ${stuck || !hasStarted(job) ? 'text-fg-3' : 'text-fg-2'}`}>
        <SessionStateIcon state={stuck ? { kind: 'idle' } : { kind: 'working', level: 1 }} variant="session" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {hasStarted(job) ? (
          <>
            <span className="flex items-baseline justify-between gap-3">
              <span className={`min-w-0 text-[13.5px] leading-[1.45] break-words text-pretty ${stuck ? 'text-fg-2' : 'text-fg'}`}>{job.label}</span>
              <span className="text-[12.5px]"><JobCount job={job} stalled={stuck} /></span>
            </span>
            <Ticks done={job.done} total={job.total} stalled={stuck} />
          </>
        ) : <span className="leading-[1.45]"><StartingLine job={job} now={now} /></span>}
        <JobStatus job={job} now={now} />
      </span>
    </>
  );
  const state = jobState(job, now);
  return onOpen ? (
    <button type="button" data-testid="panel-job" data-job-state={state} onClick={() => onOpen(job.session)} className={`${ROW} text-left hover:bg-surface-2`}>{body}</button>
  ) : (
    <div data-testid="panel-job" data-job-state={state} className={ROW}>{body}</div>
  );
}

const TICKS = 48;

/**
 * The strip: 48 fine ticks lit in proportion, so big jobs share one grain. A
 * job of fewer items gets one segment each, so the one being worked on is as
 * wide as its share of the job and lights whole when it finishes.
 */
function Ticks({ done, total, stalled }: { done: number; total: number; stalled: boolean }) {
  const ticks = Math.min(total, TICKS);
  const lit = Math.floor((done / total) * ticks);
  return (
    <span aria-hidden className="ssi mt-2 flex h-[9px] items-stretch gap-[2px]">
      {Array.from({ length: ticks }, (_, i) => {
        if (i === lit && !stalled) return <span key={i} className="flex-1" style={ticks < TICKS ? NEXT_ITEM : NEXT_TICK} />;
        const current = ticks < TICKS ? 'ring-1 ring-inset ring-fg-3/70' : 'bg-fg-2/40';
        const tone = i < lit ? (stalled ? 'bg-fg-3/55' : 'bg-fg-2/75') : i === lit ? current : 'bg-fg-3/15';
        return <span key={i} className={`flex-1 ${tone}`} />;
      })}
    </span>
  );
}

/** The tick being worked on: cyan, breathing; stops under reduced motion with the other state icons. */
const NEXT_TICK = {
  background: '#22d3ee',
  boxShadow: '0 0 5px rgba(34,211,238,.7)',
  animation: 'ssi-breathe 1.6s ease-in-out infinite',
  '--lo': .35,
  '--hi': 1,
} as React.CSSProperties;

/**
 * An item being worked on, when each item has its own segment: a wide solid
 * cyan bar would read as done, so it is a faint cyan fill under a cyan edge,
 * breathing.
 */
const NEXT_ITEM = {
  background: 'rgba(34,211,238,.14)',
  boxShadow: 'inset 0 0 0 1px rgba(34,211,238,.75)',
  animation: 'ssi-breathe 1.6s ease-in-out infinite',
  '--lo': .45,
  '--hi': 1,
} as React.CSSProperties;

/**
 * A job that finished or stopped, laid out as the worker rows are: the
 * label over one quieter line saying how it ended, "Finished 10:04" or
 * "Stopped at 116 of 180." with why in one sentence after it, in the same
 * icon column at the same size (Jason, 11 Oct: the smaller icon and the
 * lowercase reason under the label looked broken and cluttered).
 * Tapping it opens the worker that ran it. The server stops listing it once
 * the coordinator has dealt with the report its worker wrote after it
 * (`isDealtWith`), so while it is here, the result is still waiting on the
 * coordinator. A finished job's cube is solid; a stopped one keeps the idle
 * outline.
 */
function EndedJobRow({ job, onOpen }: { job: JobProgress; onOpen?: (conversationId: string) => void }) {
  const body = (
    <>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center text-fg-3">
        {job.finishedAt ? <DoneCube /> : <SessionStateIcon state={{ kind: 'idle' }} variant="session" />}
      </span>
      <span className="flex min-h-7 min-w-0 flex-1 flex-col justify-center">
        <span className="text-[13px] leading-[1.45] break-words text-pretty text-fg-2">{job.label}</span>
        <span className="mt-0.5 text-[12.5px] leading-[1.4] break-words text-pretty text-fg-3">
          {job.finishedAt
            ? <FinishedAt at={job.finishedAt} />
            : <span data-testid="panel-job-stopped">{stoppedLine(job)}</span>}
        </span>
      </span>
    </>
  );
  const className = 'flex items-start gap-2.5 rounded-sm px-2 py-1.5';
  return onOpen ? (
    <button type="button" data-testid="panel-job" data-job-state="ended" onClick={() => onOpen(job.session)} className={`${className} text-left hover:bg-surface-2`}>{body}</button>
  ) : (
    <div data-testid="panel-job" data-job-state="ended" className={className}>{body}</div>
  );
}

/** "Stopped at 116 of 180 when its process ended.", or the count and then why, as a sentence. */
function stoppedLine(job: JobProgress): string {
  const at = `Stopped at ${count(job.done)} of ${count(job.total)}`;
  if (job.stopped === PROCESS_ENDED_REASON) return `${at} when its process ended.`;
  return job.stopped ? `${at}. ${sentence(job.stopped)}` : `${at}.`;
}

/** A reason as a sentence: capital first letter, full stop at the end. */
function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * "Finished 10:04", with what that means behind it: on hover on a desktop,
 * on tap on a phone, where the tap does not open the worker as the rest of
 * the row does. It opens below the time, so it never covers the job's label.
 */
function FinishedAt({ at }: { at: number }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('scroll', close, true);
    return () => document.removeEventListener('scroll', close, true);
  }, [open]);
  return (
    <Tooltip delayDuration={0} open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          ref={ref}
          data-testid="panel-job-finished"
          className="tabular-nums"
          onPointerDown={(event) => { if (event.pointerType === 'touch') event.preventDefault(); }}
          onClick={(event) => {
            if (!window.matchMedia('(hover: none)').matches) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen((was) => !was);
          }}
        >
          Finished {clock(at)}
        </span>
      </TooltipTrigger>
      <TooltipContentPlain
        side="bottom" align="end" sideOffset={6} collisionPadding={8} className="p-0"
        onPointerDownOutside={(event) => { if (ref.current?.contains(event.target as Node)) event.preventDefault(); }}
      >
        <div className="max-w-60 px-3 py-2 text-xs text-fg-2">Finished, waiting for the coordinator to deal with the report</div>
      </TooltipContentPlain>
    </Tooltip>
  );
}

/** The worker cube, whole: three faces lit, nothing moving. */
function DoneCube() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.6 7.75 L12 12 L12 20.5 L4.6 16.25 Z" fill="currentColor" fillOpacity={.6} />
      <path d="M12 12 L19.4 7.75 L19.4 16.25 L12 20.5 Z" fill="currentColor" fillOpacity={.4} />
      <path d="M12 3.5 L19.4 7.75 L12 12 L4.6 7.75 Z" fill="currentColor" fillOpacity={.8} />
    </svg>
  );
}

/** Rows line up with the worker and Needs you rows: a 28px icon column, then the text. */
const ROW = 'flex items-start gap-2.5 rounded-sm px-2 py-2';

function Column({ children }: { children: React.ReactNode }) {
  return <span className="flex h-5 w-7 shrink-0 items-center justify-center">{children}</span>;
}

/** What each icon means, in a word or two: the icon's tooltip. */
const STAGE_NAME: Record<ShipStage, string> = {
  draft: 'Draft',
  'checks-running': 'Checks running',
  'checks-failing': 'Checks failing',
  'checks-passed': 'Checks passed, waiting for review',
  approved: 'Approved',
  merged: 'Merged, waiting for deploy',
  live: 'Live',
  'merged-unchecked': 'Merged, no deploy to check',
  closed: 'Closed without merging',
  branch: 'Branch, no pull request yet',
  unpublished: 'Not published',
  published: 'Published',
};

/** Coloured as the sidebar's state cards colour their heading: cyan for what is moving, rose for failing. */
const STAGE_TONE: Partial<Record<ShipStage, string>> = {
  'checks-running': 'text-accent',
  merged: 'text-accent',
  'checks-failing': 'text-rose-400',
};

/**
 * The stage icon with its name in the sidebar icons' card: on hover on a
 * desktop, left of the icon, over the chat; on tap on a phone, where a
 * second tap on the icon closes it and the tap does not follow the row's
 * link. A phone has no room left of the icon, so there it opens above the
 * row rather than over the row's own title.
 */
function ShipIcon({ stage }: { stage: ShipStage }) {
  const [open, setOpen] = useState(false);
  const iconRef = React.useRef<HTMLSpanElement | null>(null);
  const touch = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('scroll', close, true);
    return () => document.removeEventListener('scroll', close, true);
  }, [open]);
  return (
    <Tooltip delayDuration={0} open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          ref={iconRef}
          data-testid="panel-ship-icon"
          aria-label={STAGE_NAME[stage]}
          className="flex text-fg-2"
          onPointerDown={(event) => { if (event.pointerType === 'touch') event.preventDefault(); }}
          onClick={(event) => {
            if (!window.matchMedia('(hover: none)').matches) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen((was) => !was);
          }}
        >
          <ShipStateIcon stage={stage} />
        </span>
      </TooltipTrigger>
      <TooltipContentPlain
        side={touch ? 'top' : 'left'} align={touch ? 'start' : 'center'} alignOffset={touch ? -4 : 0} sideOffset={touch ? 8 : 6} collisionPadding={8} className="p-0"
        onPointerDownOutside={(event) => { if (iconRef.current?.contains(event.target as Node)) event.preventDefault(); }}
      >
        <div className="px-2.5 py-1.5 text-xs">
          <span className={`font-medium ${STAGE_TONE[stage] ?? 'text-fg'}`}>{STAGE_NAME[stage]}</span>
        </div>
      </TooltipContentPlain>
    </Tooltip>
  );
}

function ShipRow({ item, now }: { item: ShipItem; now: number }) {
  const body = (
    <>
      <Column><ShipIcon stage={item.stage} /></Column>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] leading-[1.45] text-fg-2 break-words text-pretty">{shortTitle(item.title)}</span>
        <span className="mt-1 flex items-baseline justify-between gap-3 text-[12px]">
          <span className={item.stage === 'checks-failing' ? 'text-rose-400' : 'text-fg-3'}>{item.stageLabel}</span>
          {item.at && <span className="shrink-0 tabular-nums text-fg-3/60">{when(item.at, now)}</span>}
        </span>
      </span>
    </>
  );
  return item.href ? (
    <a data-testid="panel-ship" href={item.href} target="_blank" rel="noreferrer" style={PLAIN_LINK} className={`${ROW} hover:bg-surface-2`}>{body}</a>
  ) : (
    <div data-testid="panel-ship" className={ROW}>{body}</div>
  );
}

/** Stages with nothing left to do: these fold under one Shipped row so what is still moving leads. */
const SHIPPED: ShipStage[] = ['live', 'merged-unchecked', 'published'];

/**
 * What has shipped in the last day, folded under one quiet row at the end of
 * the list, as the sidebar folds its Sleeping sessions: the row's icon in the
 * icon column and its label in the title column, dimmer than the rows above,
 * with the chevron after the label (2026-10-11, thread 39326: "getting a
 * little backed up here, big list"). Clicking it again folds it back.
 */
function ShippedGroup({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div data-testid="panel-shipped" className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1 text-left text-[12px] text-fg-3/70 hover:bg-surface-2 hover:text-fg-2"
      >
        <span className="flex w-7 shrink-0 justify-center"><PackageCheck size={14} strokeWidth={1.75} /></span>
        <span>Shipped</span>
        <Chevron size={11} className="-ml-1.5 opacity-60" />
      </button>
      {open && children}
    </div>
  );
}

/** The global link style (cyan, underlined) is unlayered, so it beats utility classes. */
const PLAIN_LINK: React.CSSProperties = { textDecoration: 'none', color: 'inherit' };

/** What is still moving first, then what has landed, newest first within each. */
function orderShipping(items: ShipItem[]): ShipItem[] {
  const moving: ShipStage[] = ['checks-failing', 'checks-running', 'checks-passed', 'approved', 'draft', 'branch', 'unpublished', 'merged'];
  const rank = (item: ShipItem) => (moving.includes(item.stage) ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || (b.at ?? 0) - (a.at ?? 0));
}

/** "[releases] Show Saki's gates" reads as "Show Saki's gates": the area tag is the repo's filing, not the change. */
function shortTitle(title: string): string {
  return title.replace(/^(\[[^\]]+\]\s*)+/, '');
}

function usePolled<T>(url: string | undefined | null | false, everyMs: number, refresh = 0): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const load = () => void fetch(url).then((r) => (r.ok ? r.json() as Promise<T> : null)).then((body) => { if (alive && body) setValue(body); }, () => {});
    load();
    const timer = setInterval(load, everyMs);
    return () => { alive = false; clearInterval(timer); };
  }, [url, everyMs, refresh]);
  return value;
}

/**
 * The jobs of this coordinator and its workers. The server reads each job's
 * count every 30 seconds and pushes a jobs-changed frame when one changes, so
 * the list is refetched then; the poll is only a safety net, every two
 * minutes while the stream is connected and every 15 seconds while it is not
 * (or after a reconnect, which may have missed frames).
 */
function useJobs(coordinatorId: string | undefined, workers: WorkerCardState[]): JobProgress[] {
  const sessions = useMemo(() => new Set([coordinatorId, ...workers.map((worker) => worker.worker)]), [coordinatorId, workers]);
  const [changed, setChanged] = useState(0);
  useActivityStreamSubscription({ type: 'activity' }, (event) => {
    const payload = event as { type?: string; sessionId?: string | null };
    if (payload.type === 'jobs-changed' && payload.sessionId && sessions.has(payload.sessionId)) setChanged((value) => value + 1);
  });
  const { isConnected, connectionState } = useActivityStream();
  const reconnected = connectionState.lastConnectedAt?.getTime() ?? 0;
  const url = coordinatorId && `/api/conv/${encodeURIComponent(coordinatorId)}/jobs`;
  return usePolled<{ jobs: JobProgress[] }>(url, isConnected ? 120_000 : 15_000, changed + reconnected)?.jobs ?? [];
}

function useNow(everyMs: number): number {
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

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function when(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? clock(at) : new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "4 min", with a non-breaking space so a wrapped line never splits it. */
function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `${minutes}\u00a0min`;
  return `${Math.round(minutes / 30) / 2} hours`;
}

function timeLeft(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'Under a minute left';
  if (minutes < 90) return `About ${minutes} min left`;
  const hours = Math.round(minutes / 30) / 2;
  return `About ${hours} hours left`;
}
