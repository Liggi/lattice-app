/**
 * Right panel of a coordinator conversation, in the left sidebar's language:
 * small muted section labels, no rules between sections, rows lined up on
 * one icon column. The to-do list leads — Needs you, In progress with the
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
 * The narrow overlay's title bar carries only its close button. It used to
 * say "Project" above a panel whose own first line is the project — a
 * redundant heading — so the word is gone and the
 * close control keeps its accessible name.
 */

import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { WorkerCardState } from '@/types/worker-events';
import type { ProjectState } from '@/types/project-state';
import { StateOfPlaySection } from './StateOfPlaySection';
import { ProjectPurpose } from './ProjectSection';

interface CoordinatorPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  workers: WorkerCardState[];
  project: ProjectState | null;
  coordinatorRunning: boolean;
  onOpenWorker?: (conversationId: string) => void;
  /** The coordinator's own id, so a wait naming it reads "the coordinator". */
  coordinatorId?: string;
}

const mobileSafeAreaInsetsStyle: React.CSSProperties = {
  paddingTop: 'env(safe-area-inset-top, 0px)',
  paddingRight: 'env(safe-area-inset-right, 0px)',
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  paddingLeft: 'env(safe-area-inset-left, 0px)',
};

export function CoordinatorPanel({ isOpen, onClose, workers, project, coordinatorRunning, onOpenWorker, coordinatorId }: CoordinatorPanelProps): JSX.Element | null {
  // The worker whose name is under the pointer in a wait line, lit in the list.
  const [pointedWorker, setPointedWorker] = useState<string | null>(null);
  if (!isOpen) return null;
  const waitContext = { workers, coordinatorId, onPointWorker: setPointedWorker };

  const content = (
    <div className="flex flex-col gap-7 px-3 py-5">
      <StateOfPlaySection
        project={project}
        workers={workers}
        coordinatorId={coordinatorId}
        coordinatorRunning={coordinatorRunning}
        onOpenWorker={onOpenWorker}
        waitContext={waitContext}
        pointedWorker={pointedWorker}
      />
      {project && <ProjectPurpose project={project} />}
    </div>
  );

  return (
    <>
      {/* Mobile: full-screen overlay */}
      <div className="md:hidden fixed inset-0 z-50 bg-bg flex flex-col" style={mobileSafeAreaInsetsStyle}>
        <div className="flex items-center justify-end px-4 py-3 border-b border-line flex-shrink-0">
          {onClose && (
            <button onClick={onClose} className="p-2 -m-2 text-fg-2 hover:text-fg transition-colors" aria-label="Close panel">
              <X size={20} />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">{content}</div>
      </div>

      {/* Desktop: side panel */}
      <aside data-testid="coordinator-panel" className="hidden md:flex md:flex-col w-[360px] border-l border-line bg-bg flex-shrink-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto scrollbar-auto-hide">{content}</div>
      </aside>
    </>
  );
}
