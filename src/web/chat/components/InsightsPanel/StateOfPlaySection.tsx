/**
 * The coordinator panel's to-do list as a state of play (2026-09-27, Jason:
 * "looks good, do it"): Needs you, Workers, In progress, Next, then the last
 * thing completed and a quiet Parked row. What goes where, and in what order,
 * is `deriveStateOfPlay` (`src/types/state-of-play.ts`); this draws it.
 *
 * - Needs you: amber cube and the brightest text in the panel, because this
 *   is the only section that is the user's move. The row is the ask alone;
 *   the detail (`needsYouLines`) is on hover or a tap. Amber appears nowhere
 *   else in the panel.
 * - Workers: every live worker as its own row, named by its task (2026-09-28;
 *   folding them into the threads hid one whose thread waited on the user).
 * - In progress: threads nobody is on that are held on something outside the
 *   project: a ring and "Waiting", with what on hover or a tap.
 * - Next: a ring and quieter text.
 *
 * Any thread can be dismissed: a × on hover on a desktop, a swipe left on a
 * phone. Dismissing parks it as the user's call and stops its workers
 * (`thread-dismissal.ts`); the row says so in place, with Undo, for a few
 * seconds, and the thread is then under Parked with Bring back.
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Circle, CircleCheck, CirclePause, Undo2, X } from 'lucide-react';
import { SectionHeading } from './SectionHeading';
import { WorkerRow } from './WorkersSection';
import type { WaitTextContext } from './WaitText';
import { SessionStateIcon } from '@/web/chat/components/shared/session-state-icon/SessionStateIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/web/chat/components/ui/tooltip';
import { deriveStateOfPlay, type PlayItem } from '@/types/state-of-play';
import type { ProjectState } from '@/types/project-state';
import { withoutThreadRefs } from '@/types/project-state';
import type { WorkerCardState } from '@/types/worker-events';

/** How long a dismissed row offers Undo in place before it is only under Parked. */
const UNDO_MS = 15_000;
/** How far a row slides to show its Dismiss action on a touch screen. */
const SWIPE_REVEAL_PX = 88;

interface StateOfPlaySectionProps {
  project: ProjectState | null;
  workers: WorkerCardState[];
  coordinatorId?: string;
  coordinatorRunning: boolean;
  onOpenWorker?: (conversationId: string) => void;
  waitContext?: WaitTextContext;
  pointedWorker?: string | null;
}

type Pending = { seq: number; label: string; error?: string };

async function postThreadAction(coordinatorId: string, seq: number, action: 'dismiss' | 'restore'): Promise<void> {
  const response = await fetch(`/api/conv/${encodeURIComponent(coordinatorId)}/project/threads/${seq}/${action}`, { method: 'POST' });
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: string } | null;
  throw new Error(body?.error ?? `HTTP ${response.status}`);
}

export function StateOfPlaySection({
  project, workers, coordinatorId, coordinatorRunning, onOpenWorker, waitContext, pointedWorker,
}: StateOfPlaySectionProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState<Pending[]>([]);
  const [parkedOpen, setParkedOpen] = useState(false);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);

  const play = deriveStateOfPlay(project ?? EMPTY_PROJECT, workers);
  const justDone = project && project.closed.length > 0 ? project.closed[project.closed.length - 1] : null;
  const canDismiss = Boolean(coordinatorId);

  const forget = (seq: number) => {
    clearTimeout(timers.current.get(seq));
    timers.current.delete(seq);
    setDismissed((current) => current.filter((entry) => entry.seq !== seq));
  };

  const dismiss = async (item: PlayItem) => {
    if (!coordinatorId) return;
    const seq = item.thread.seq;
    const label = withoutThreadRefs(item.label);
    setDismissed((current) => [...current.filter((entry) => entry.seq !== seq), { seq, label }]);
    try {
      await postThreadAction(coordinatorId, seq, 'dismiss');
      timers.current.set(seq, setTimeout(() => forget(seq), UNDO_MS));
    } catch (err) {
      setDismissed((current) => current.map((entry) => entry.seq === seq ? { ...entry, error: err instanceof Error ? err.message : String(err) } : entry));
    }
  };

  const restore = async (seq: number) => {
    if (!coordinatorId) return;
    forget(seq);
    try {
      await postThreadAction(coordinatorId, seq, 'restore');
    } catch (err) {
      setDismissed((current) => [...current, { seq, label: '', error: err instanceof Error ? err.message : String(err) }]);
    }
  };

  // A dismissed row keeps its place, saying so, until the Undo window closes.
  const pendingFor = (item: PlayItem): Pending | undefined => dismissed.find((entry) => entry.seq === item.thread.seq);
  const parkedNow = play.parked.filter((item) => !dismissed.some((entry) => entry.seq === item.thread.seq && !entry.error));
  // Remember which section each thread was drawn in, so a dismissed one's
  // Undo row stays where the user was looking.
  const lastSection = useLastSection(play);

  const render = (item: PlayItem, section: 'needs-you' | 'in-progress' | 'next') => {
    const pending = pendingFor(item);
    if (pending) return <DismissedRow key={item.key} pending={pending} onUndo={() => void restore(pending.seq)} />;
    return (
      <ItemRow
        key={item.key}
        item={item}
        section={section}
        onDismiss={canDismiss ? () => void dismiss(item) : undefined}
      />
    );
  };

  // Threads dismissed in this panel stay drawn in the section they were in
  // while the Undo lasts, though the state already has them parked.
  const held = (section: 'needs-you' | 'in-progress' | 'next'): PlayItem[] => play.parked.filter((item) => {
    if (lastSection.get(item.thread.seq)?.section !== section) return false;
    return dismissed.some((entry) => entry.seq === item.thread.seq && !entry.error);
  });
  const placed = (items: PlayItem[], section: 'needs-you' | 'in-progress' | 'next'): PlayItem[] => {
    const extra = held(section);
    if (extra.length === 0) return items;
    const out = [...items];
    for (const item of extra) out.splice(Math.min(lastSection.get(item.thread.seq)!.index, out.length), 0, item);
    return out;
  };

  const needsYou = placed(play.needsYou, 'needs-you');
  const inProgress = placed(play.inProgress, 'in-progress');
  const next = placed(play.next, 'next');
  const orphanErrors = dismissed.filter((entry) => entry.error && !entry.label);

  if (needsYou.length + play.workers.length + inProgress.length + next.length + parkedNow.length === 0 && !justDone) return null;

  return (
    <>
      {needsYou.length > 0 && (
        <section data-testid="play-needs-you">
          <SectionHeading>Needs you</SectionHeading>
          <div className="flex flex-col gap-px">{needsYou.map((item) => render(item, 'needs-you'))}</div>
        </section>
      )}
      {play.workers.length > 0 && (
        <section data-testid="workers-section">
          <SectionHeading>Workers</SectionHeading>
          <div className="flex flex-col gap-px">
            {play.workers.map((worker) => (
              <WorkerRow
                key={worker.worker}
                worker={worker}
                coordinatorRunning={coordinatorRunning}
                onOpen={onOpenWorker}
                waitContext={waitContext}
                pointed={pointedWorker === worker.worker}
                pointing={Boolean(pointedWorker)}
              />
            ))}
          </div>
        </section>
      )}
      {inProgress.length > 0 && (
        <section data-testid="play-in-progress">
          <SectionHeading>In progress</SectionHeading>
          <div className="flex flex-col gap-px">{inProgress.map((item) => render(item, 'in-progress'))}</div>
        </section>
      )}
      {next.length > 0 && (
        <section data-testid="play-next">
          <SectionHeading>Next</SectionHeading>
          <div className="flex flex-col gap-px">{next.map((item) => render(item, 'next'))}</div>
        </section>
      )}
      {(justDone || parkedNow.length > 0 || orphanErrors.length > 0) && (
        <section data-testid="play-after" className="-mt-3 flex flex-col gap-px">
          {justDone && (
            <div className="flex items-start gap-2.5 px-2 py-1.5">
              <Marker><CircleCheck size={12} strokeWidth={1.75} className="text-fg-3/70" aria-hidden /></Marker>
              <div data-testid="project-thread-done" className="min-w-0 flex-1 text-[13px] leading-[1.45] text-fg-3/70 break-words">
                {withoutThreadRefs(justDone.label ?? justDone.text)}
              </div>
            </div>
          )}
          {orphanErrors.map((entry) => (
            <div key={`error-${entry.seq}`} className="px-2 py-1 pl-[46px] text-[12px] text-rose-400">Could not bring it back: {entry.error}</div>
          ))}
          {parkedNow.length > 0 && (
            <>
              <button
                type="button"
                data-testid="play-parked-toggle"
                onClick={() => setParkedOpen((open) => !open)}
                aria-expanded={parkedOpen}
                className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1 text-[11.5px] text-fg-3/70 hover:bg-surface-2 hover:text-fg-2"
              >
                <span className="flex w-7 shrink-0 justify-center"><CirclePause size={13} strokeWidth={1.75} /></span>
                <span>Parked</span>
                {parkedOpen ? <ChevronDown size={11} className="-ml-1.5 opacity-60" /> : <ChevronRight size={11} className="-ml-1.5 opacity-60" />}
              </button>
              {parkedOpen && parkedNow.map((item) => (
                <div key={item.key} data-testid="play-parked-row" className="group flex items-start gap-2.5 rounded-sm px-2 py-1.5 hover:bg-surface-2">
                  <span className="w-7 shrink-0" />
                  <span className="min-w-0 flex-1 text-[12.5px] leading-[1.45] text-fg-3/70 break-words">{withoutThreadRefs(item.label)}</span>
                  {canDismiss && (
                    <button
                      type="button"
                      onClick={() => void restore(item.thread.seq)}
                      className="shrink-0 text-[12px] font-medium text-fg-3 hover:text-fg [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                    >
                      Bring back
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </section>
      )}
    </>
  );
}

const EMPTY_PROJECT: ProjectState = {
  outcome: null, decisions: [], retired: [], priority: null, rank: [], open: [], closed: [],
  attention: [], historical: [], accountingFrom: null, now: null, nudges: 0, revision: 0,
};

/**
 * Where each thread was last drawn: its section and position. Read when a
 * thread has just been dismissed, so its Undo row stays in that place though
 * the state already lists it as parked.
 */
function useLastSection(play: ReturnType<typeof deriveStateOfPlay>): Map<number, { section: 'needs-you' | 'in-progress' | 'next'; index: number }> {
  const ref = useRef(new Map<number, { section: 'needs-you' | 'in-progress' | 'next'; index: number }>());
  const note = (items: PlayItem[], section: 'needs-you' | 'in-progress' | 'next') => {
    items.forEach((item, index) => ref.current.set(item.thread.seq, { section, index }));
  };
  note(play.needsYou, 'needs-you');
  note(play.inProgress, 'in-progress');
  note(play.next, 'next');
  return ref.current;
}

/** A marker centred in the 28px icon column the worker cubes use. */
function Marker({ children, tall }: { children: React.ReactNode; tall?: boolean }) {
  return <span className={`flex ${tall ? 'h-7' : 'h-5'} w-7 shrink-0 items-center justify-center`}>{children}</span>;
}

function DismissedRow({ pending, onUndo }: { pending: Pending; onUndo: () => void }) {
  return (
    <div data-testid="play-dismissed" className="flex items-center gap-2.5 px-2 py-1.5 text-[12.5px]">
      <span className="w-7 shrink-0" />
      {pending.error ? (
        <span className="flex-1 text-rose-400">Could not dismiss: {pending.error}</span>
      ) : (
        <>
          <span className="flex-1 text-fg-3">Dismissed, moved to Parked</span>
          <button type="button" data-testid="play-undo" onClick={onUndo} className="flex items-center gap-1 font-medium text-accent hover:underline">
            <Undo2 size={12} aria-hidden /> Undo
          </button>
        </>
      )}
    </div>
  );
}

function DismissButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid="play-dismiss"
          onClick={(event) => { event.stopPropagation(); onClick(); }}
          className="absolute right-1 top-1 hidden h-6 w-6 items-center justify-center rounded-sm text-fg-3 opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:flex"
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * On a touch screen a row is dismissed by sliding it left, which shows its
 * Dismiss action; a tap on that dismisses, and sliding back or tapping the
 * row hides it. Pointer devices use the × instead, so this does nothing there.
 */
function Swipeable({ onDismiss, children }: { onDismiss?: () => void; children: React.ReactNode }) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number; base: number } | null>(null);
  if (!onDismiss) return <>{children}</>;
  const open = offset <= -SWIPE_REVEAL_PX / 2;
  return (
    <div className="relative overflow-hidden rounded-sm">
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        onClick={() => { setOffset(0); onDismiss(); }}
        className="absolute inset-y-0 right-0 flex items-center justify-center rounded-r-sm bg-surface-2 text-[12.5px] font-medium text-fg"
        style={{ width: SWIPE_REVEAL_PX }}
      >
        Dismiss
      </button>
      <div
        className="relative bg-bg"
        style={{ transform: `translateX(${offset}px)`, transition: start.current ? 'none' : 'transform 160ms ease-out' }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          start.current = { x: touch.clientX, y: touch.clientY, base: offset };
        }}
        onTouchMove={(event) => {
          if (!start.current) return;
          const touch = event.touches[0];
          const dx = touch.clientX - start.current.x;
          if (Math.abs(touch.clientY - start.current.y) > Math.abs(dx)) return;
          setOffset(Math.max(-SWIPE_REVEAL_PX, Math.min(0, start.current.base + dx)));
        }}
        onTouchEnd={() => {
          start.current = null;
          setOffset((value) => (value <= -SWIPE_REVEAL_PX / 2 ? -SWIPE_REVEAL_PX : 0));
        }}
        onClickCapture={(event) => {
          if (!open) return;
          event.stopPropagation();
          event.preventDefault();
          setOffset(0);
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ItemRow({ item, section, onDismiss }: {
  item: PlayItem;
  section: 'needs-you' | 'in-progress' | 'next';
  onDismiss?: () => void;
}) {
  const label = withoutThreadRefs(item.label);
  const dismissLabel = item.workers.length === 0 ? 'Dismiss' : item.workers.length === 1 ? 'Dismiss and stop its worker' : 'Dismiss and stop its workers';
  const dismissControl = onDismiss ? <DismissButton label={dismissLabel} onClick={onDismiss} /> : null;
  // The × sits over the row's right edge rather than taking a column, so the
  // Waiting hairline runs as far as a worker row's; only the label keeps clear of it.
  const clearDismiss = onDismiss ? '[@media(hover:hover)]:pr-6' : '';

  let body: React.ReactNode;
  if (section === 'needs-you') {
    body = <NeedsYouRow label={label} {...needsYouLines(item)} clearDismiss={clearDismiss} dismissControl={dismissControl} />;
  } else {
    const held = item.heldOn;
    body = (
      <div data-testid="play-item" className="group relative flex items-start rounded-sm bg-bg transition-colors hover:bg-surface-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5 px-2 py-1.5">
          <Marker><Circle size={12} strokeWidth={1.75} className="text-fg-3" aria-hidden /></Marker>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className={`text-[13px] leading-[1.45] break-words ${section === 'next' ? 'text-fg-3' : 'text-fg-2'} ${clearDismiss}`}>{label}</span>
            {held && <HeldLine on={held} />}
          </div>
        </div>
        {dismissControl}
      </div>
    );
  }
  return <Swipeable onDismiss={onDismiss}>{body}</Swipeable>;
}

/**
 * A Needs you item shows its ask alone, so the section reads at a glance
 * (2026-09-28, Jason: "this is way too much"). The detail is on hover or,
 * on a touch screen, a tap on the row, which opens it in place: the worker
 * rows' treatment for what they wait on.
 */
function NeedsYouRow({ label, ask, detail, clearDismiss, dismissControl }: {
  label: string;
  ask: string | null;
  detail: string | null;
  clearDismiss: string;
  dismissControl: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // The detail opens beside the panel, never over it: the offset carries the
  // tooltip from the label out past the panel's left border.
  const headingRef = useRef<HTMLSpanElement | null>(null);
  const [offset, setOffset] = useState(8);
  const measure = (showing: boolean) => {
    const node = headingRef.current;
    const panel = node?.closest('[data-testid="coordinator-panel"]');
    if (showing && node && panel) setOffset(node.getBoundingClientRect().left - panel.getBoundingClientRect().left + 8);
  };
  const heading = <span ref={headingRef} className={`text-[13px] font-medium leading-[1.45] text-fg break-words ${clearDismiss}`}>{label}</span>;
  return (
    <div
      data-testid="play-item"
      data-open={open || undefined}
      className={`group relative flex items-start rounded-sm transition-colors ${open ? 'bg-surface-2' : 'bg-bg hover:bg-surface-2'}`}
    >
      <div
        className="flex min-w-0 flex-1 items-start gap-2.5 px-2 py-1.5"
        onClick={detail ? () => setOpen((value) => !value) : undefined}
        aria-expanded={detail ? open : undefined}
      >
        <Marker tall><SessionStateIcon state={{ kind: 'needs-you' }} variant="session" /></Marker>
        <div className="flex min-h-7 min-w-0 flex-1 flex-col justify-center">
          {detail && !open ? (
            <Tooltip delayDuration={200} onOpenChange={measure}>
              <TooltipTrigger asChild>{heading}</TooltipTrigger>
              <TooltipContent side="left" sideOffset={offset} className="max-w-[320px]" data-testid="play-needs-you-detail">{detail}</TooltipContent>
            </Tooltip>
          ) : heading}
          {ask && <span className="mt-0.5 text-[12.5px] leading-[1.4] text-fg-3 break-words">{ask}</span>}
          {detail && open && (
            <span data-testid="play-needs-you-detail" className="mt-1 border-t border-line/35 pt-1 text-[12.5px] leading-[1.45] text-fg-3 break-words">
              {detail}
            </span>
          )}
        </div>
      </div>
      {dismissControl}
    </div>
  );
}

/**
 * What a Needs you item says, so it is never an amber row the user cannot
 * act on. With a label, the label is the ask and the summary is the detail.
 * Without one the row shows the thread's outcome, so a line under it says
 * what is asked (what the decision waits on, else the next step) and the
 * summary is the detail.
 */
function needsYouLines(item: PlayItem): { ask: string | null; detail: string | null } {
  const thread = item.thread;
  const wait = thread.waitingOn?.kind === 'decision' ? `Waiting on ${thread.waitingOn.text}` : null;
  const ask = thread.label ? null : wait ?? thread.nextAction ?? null;
  const detail = thread.summary ?? (thread.label ? wait ?? thread.nextAction : null) ?? null;
  return { ask: ask ? withoutThreadRefs(ask) : null, detail: detail ? withoutThreadRefs(detail) : null };
}

/** "Waiting", with what on hover or, on a touch screen, a tap: the worker rows' treatment. */
function HeldLine({ on }: { on: string }) {
  const [open, setOpen] = useState(false);
  const text = `Waiting on ${withoutThreadRefs(on)}`;
  return (
    <span className="mt-1 border-t border-line/35 pt-1 text-[12.5px] leading-[1.4] break-words">
      {open ? (
        <span className="text-fg-3" onClick={() => setOpen(false)}>{text}</span>
      ) : (
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <span data-testid="play-held" className="cursor-default text-fg-3" onClick={() => setOpen(true)}>Waiting</span>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-[260px]">{text}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
