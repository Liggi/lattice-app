/**
 * Right panel of a coordinator conversation, in the left sidebar's language:
 * small muted section labels, no rules between sections, rows lined up on
 * one icon column. The to-do list leads — Your calls, In progress with the
 * workers folded in, Next, then the last thing completed and Parked — and
 * Purpose, which rarely changes, comes last (2026-09-27). The list is derived
 * from what the coordinator has noted and its worker events together
 * (`StateOfPlaySection`). Each section renders nothing when it has nothing to
 * show, and the gap between sections goes with it.
 *
 * The server also folds a History of coordinator moves (`foldWorkerHistory`)
 * and `useWorkers` still returns it, but the panel does not render it: every
 * row restated a task or report already visible on a worker row or in the
 * thread.
 *
 * On a phone the panel is a sheet whose top bar carries the project's name
 * and Close; dragging that bar down closes it too.
 */

import React, { type JSX, useRef, useState } from 'react';
import type { ProfileRoster, SessionReference, WorkerCardState } from '@/types/worker-events';
import type { ProjectState } from '@/types/project-state';
import { StateOfPlaySection } from './StateOfPlaySection';
import type { ShownDecision } from '@/types/decisions';
import type { HeldReply } from '@/types/held-replies';
import { useWatchWorkers } from '../../hooks/useWorkers';
import type { ProjectOutputs } from './project-outputs';

interface CoordinatorPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  workers: WorkerCardState[];
  project: ProjectState | null;
  /** The coordinator's profile and its roles, when it is not on the built-in one. */
  profile?: ProfileRoster;
  coordinatorRunning: boolean;
  onOpenWorker?: (conversationId: string) => void;
  /** The coordinator's own id, so a wait naming it reads "the coordinator". */
  coordinatorId?: string;
  /** Names for the other sessions the wait lines mention by id. */
  sessionReferences?: Record<string, SessionReference>;
  /** The coordinator's latest question card once shown: a Your calls row. */
  latestDecision?: ShownDecision | null;
  /** Replies held in the panel before they go. */
  heldReplies?: ReadonlyMap<string, HeldReply>;
  /** When the user last replied about each thread and card. */
  repliedAt?: ReadonlyMap<string, number>;
  /** Screenshots and links the conversation has produced. */
  outputs?: ProjectOutputs | null;
  /** The project's name, at the top of the phone sheet. */
  title?: string | null;
}

const mobileSafeAreaInsetsStyle: React.CSSProperties = {
  paddingTop: 'var(--app-safe-area-top)',
  paddingRight: 'env(safe-area-inset-right, 0px)',
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  paddingLeft: 'env(safe-area-inset-left, 0px)',
};

/** How far down, in px, the sheet's top bar must be dragged before letting go closes it. */
const SHEET_DISMISS_DISTANCE = 80;
/** A flick faster than this (px/ms) closes the sheet from a shorter drag. */
const SHEET_DISMISS_VELOCITY = 0.5;

/**
 * Drag-down-to-close for the phone sheet. Only its top bar listens, so
 * scrolling the sheet's body never moves the sheet.
 */
function useSheetDrag(onClose: (() => void) | undefined) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef<number | null>(null);
  // Recent touch positions, enough to measure the speed of the final flick.
  const samples = useRef<Array<{ y: number; t: number }>>([]);

  const onTouchStart = (event: React.TouchEvent) => {
    if (!onClose || event.touches.length !== 1) return;
    startY.current = event.touches[0].clientY;
    samples.current = [{ y: startY.current, t: performance.now() }];
  };
  const onTouchMove = (event: React.TouchEvent) => {
    if (startY.current === null) return;
    const y = event.touches[0].clientY;
    const t = performance.now();
    samples.current = [...samples.current.filter((sample) => t - sample.t <= 100), { y, t }];
    const dy = Math.max(0, y - startY.current);
    if (dy > 0) setDragging(true);
    setOffset(dy);
  };
  const onTouchEnd = () => {
    const from = startY.current;
    const recent = samples.current;
    startY.current = null;
    samples.current = [];
    setDragging(false);
    setOffset(0);
    if (from === null || !onClose || recent.length === 0) return;
    const last = recent[recent.length - 1];
    const first = recent[0];
    const dy = last.y - from;
    const velocity = (last.y - first.y) / Math.max(1, last.t - first.t);
    if (dy > SHEET_DISMISS_DISTANCE || (dy > 16 && velocity > SHEET_DISMISS_VELOCITY)) onClose();
  };

  const style: React.CSSProperties = {
    transform: offset ? `translateY(${offset}px)` : undefined,
    transition: dragging ? 'none' : 'transform 180ms ease-out',
  };
  return { style, handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd } };
}

export function CoordinatorPanel({ isOpen, onClose, workers, project, profile, coordinatorRunning, onOpenWorker, coordinatorId, sessionReferences, latestDecision, heldReplies, repliedAt, outputs, title }: CoordinatorPanelProps): JSX.Element | null {
  // The worker whose name is under the pointer in a wait line, lit in the list.
  const [pointedWorker, setPointedWorker] = useState<string | null>(null);
  useWatchWorkers(coordinatorId ?? null, isOpen && workers.some((worker) => worker.phase === 'working'));
  const sheetDrag = useSheetDrag(onClose);
  if (!isOpen) return null;
  const waitContext = { workers, coordinatorId, references: sessionReferences, onPointWorker: setPointedWorker, onOpenSession: onOpenWorker };

  const content = (
    <div className={`flex flex-col gap-7 px-3 py-5 ${pointedWorker ? 'ref-spotlight' : ''}`}>
      <StateOfPlaySection
        project={project}
        profile={profile}
        workers={workers}
        coordinatorId={coordinatorId}
        coordinatorRunning={coordinatorRunning}
        onOpenWorker={onOpenWorker}
        waitContext={waitContext}
        pointedWorker={pointedWorker}
        latestDecision={latestDecision}
        heldReplies={heldReplies}
        repliedAt={repliedAt}
        outputs={outputs}
      />
    </div>
  );

  return (
    <>
      {/* Phone: a sheet over the dimmed chat; tapping the chat above closes it. */}
      <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end bg-black/55" style={mobileSafeAreaInsetsStyle} onClick={onClose}>
        <div
          data-testid="coordinator-sheet"
          className="flex max-h-[88%] min-h-0 flex-col rounded-t-2xl border-t border-line bg-surface [--panel-bg:var(--color-surface)]"
          style={sheetDrag.style}
          onClick={(event) => event.stopPropagation()}
        >
          {/* The handle and title bar drag the sheet down to close it. */}
          <div data-testid="coordinator-sheet-grip" className="shrink-0 touch-none select-none" {...sheetDrag.handlers}>
            <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-line-2" aria-hidden />
            <div className="flex items-center gap-4 pl-5 pr-3 pt-1.5">
              <span className="min-w-0 flex-1 break-words text-[16px] font-medium leading-snug text-fg">{title}</span>
              {onClose && (
                <button
                  onClick={onClose}
                  className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-end px-2 text-[14px] text-fg-2 hover:text-fg transition-colors touch-manipulation"
                  aria-label="Close panel"
                >
                  Close
                </button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{content}</div>
        </div>
      </div>

      {/* Desktop: side panel */}
      <aside data-testid="coordinator-panel" className="hidden md:flex md:flex-col w-[360px] border-l border-line bg-bg flex-shrink-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto scrollbar-auto-hide">{content}</div>
      </aside>
    </>
  );
}
