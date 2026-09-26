/**
 * Right panel of a coordinator conversation: Project, then Workers. Project
 * is what the coordinator has noted (`ProjectSection`); Workers is derived
 * from its worker events (`WorkersSection`).
 *
 * The server also folds a History of coordinator moves (`foldWorkerHistory`)
 * and `useWorkers` still returns it, but the panel does not render it: every
 * row restated a task or report already visible on a worker card or in the
 * thread. The turn-insights History the InsightsPanel shows for ordinary
 * sessions is not used here either.
 *
 * Every band is separated by a rule that runs the full width of the panel,
 * drawn here with `divide-y` rather than by a border on any one section: a
 * band renders nothing when it has nothing to show, and a band that renders
 * nothing must not leave a line behind. `ProjectSection` contributes its
 * bands as a fragment, so Purpose, Working on, Still to do and Workers are
 * all padded and divided by the same two rules and none draws its own.
 *
 * The narrow overlay's title bar carries only its close button. It used to
 * say "Project" above a panel whose own first line is the project — a
 * redundant heading — so the word is gone and the
 * close control keeps its accessible name.
 */

import React from 'react';
import { X } from 'lucide-react';
import type { WorkerCardState } from '@/types/worker-events';
import type { ProjectState } from '@/types/project-state';
import { WorkersSection } from './WorkersSection';
import { ProjectSection } from './ProjectSection';

interface CoordinatorPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  workers: WorkerCardState[];
  project: ProjectState | null;
  coordinatorRunning: boolean;
  onOpenWorker?: (conversationId: string) => void;
}

const mobileSafeAreaInsetsStyle: React.CSSProperties = {
  paddingTop: 'env(safe-area-inset-top, 0px)',
  paddingRight: 'env(safe-area-inset-right, 0px)',
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  paddingLeft: 'env(safe-area-inset-left, 0px)',
};

export function CoordinatorPanel({ isOpen, onClose, workers, project, coordinatorRunning, onOpenWorker }: CoordinatorPanelProps): JSX.Element | null {
  if (!isOpen) return null;

  const content = (
    <div className="flex flex-col divide-y divide-line [&>*]:px-5 [&>*]:py-5">
      {project && <ProjectSection project={project} coordinatorRunning={coordinatorRunning} />}
      <WorkersSection workers={workers} coordinatorRunning={coordinatorRunning} onOpenWorker={onOpenWorker} />
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
