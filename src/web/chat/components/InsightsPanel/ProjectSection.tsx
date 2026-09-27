/**
 * Project section of a coordinator's right panel: what the coordinator has
 * noted about the project, as opposed to what its workers have done. The
 * outcome it is working towards, the piece of work it is on, what this turn
 * is doing, and the threads still open (see `src/types/project-state.ts`).
 * The section renders nothing until the coordinator writes its first note.
 *
 * Every band in this panel is labelled. The two opening statements were
 * unlabelled for a pass — a quiet line for the outcome above a loud line for
 * the priority — and it was unclear what the two were expressing.
 * Typography alone could not say it,
 * so both now carry a heading in the same treatment as Still to do and
 * Workers: Purpose is the outcome the project is for and does not change from
 * turn to turn; Working on is the piece of work it is on now. Neither
 * heading is ever shown over the other's text — when a value is absent its
 * band is simply not there.
 *
 * This section returns a fragment rather than a wrapper, so `CoordinatorPanel`
 * pads and divides all of its bands the same way and no band has to draw its
 * own rule.
 *
 * Now is subordinate to Working on rather than a band of its own: the
 * priority is the work the project is on and outlives the turn, while `now`
 * is what this turn is doing and is cleared when it ends. It takes a spinner
 * only while the coordinator is actually running — a `now` left behind by a
 * turn that ended is real text, but nothing about it is happening, and the
 * spinner would be the same stale-but-alive claim the worker cards refuse to
 * make.
 *
 * Decisions are still recorded on the project state and read by coordinators
 * and workers for continuity, but the panel does not show them: they were not
 * worth the space to the user while watching the project move.
 *
 * Still to do is a task list and is drawn as one, because it was hard
 * to read as a run of paragraphs: an open-task ring in a fixed left gutter,
 * every task's text starting beside its ring and wrapping back to the same
 * column, and the waiting line indented under the text rather than under the
 * ring. The ring is a marker, not a control — nothing in this panel completes
 * a thread, so it is round rather than checkbox-shaped, inert, and hidden
 * from assistive technology.
 *
 * The most recently closed thread stays under the open ones with its ring
 * ticked, because the list only ever shrank and the user could not see anything
 * being checked off. It is the last entry of `project.closed`,
 * which the fold keeps in close order — so it is whatever the coordinator
 * actually closed last, it is the same row after a reload, and it is replaced
 * only by the next real closure rather than expiring on a timer. It is not
 * one of the three open tasks and is not counted in "+ N more"; it shows even
 * when nothing is open, so finishing the last task leaves the tick on screen
 * instead of an empty band. With nothing left open the band is headed
 * "Recently completed" instead, because "Still to do" over a single ticked
 * row says the opposite of what the row means.
 *
 * Three threads are shown and the rest are behind "+ N more" because
 * projects run longer than the panel does, and
 * the list was pushing Workers off the screen. The three are the first three
 * in the coordinator's own order; nothing here ranks or scores a thread, and
 * expanding shows every one of them.
 *
 * A thread that is waiting says so under its own line, because "still to do"
 * and "cannot move" are different things to read at a glance. A thread that
 * is ready says nothing extra: the absence of a blocker is the normal case
 * and does not need a label on every row. Owner and next action stay in the
 * data for the coordinator and its workers; the panel is the user's view of
 * what remains, not the coordination record.
 */

import React, { useState } from 'react';
import { ChevronUp, CircleCheck, Circle, Focus, ListTodo, Loader2, Target } from 'lucide-react';
import type { ProjectState } from '@/types/project-state';
import { SectionHeading } from './SectionHeading';

interface ProjectSectionProps {
  project: ProjectState;
  coordinatorRunning: boolean;
}

const COLLAPSED_THREAD_COUNT = 3;

export function ProjectSection({ project, coordinatorRunning }: ProjectSectionProps): JSX.Element | null {
  const [threadsExpanded, setThreadsExpanded] = useState(false);
  // A parked thread is kept but not remaining work, so it is not listed here.
  const open = project.open.filter((thread) => !thread.parked);
  const noted = project.outcome || project.priority || project.now || open.length > 0 || project.closed.length > 0;
  if (!noted) return null;

  const hidden = open.length - COLLAPSED_THREAD_COUNT;
  const shown = threadsExpanded ? open : open.slice(0, COLLAPSED_THREAD_COUNT);
  // `closed` is in the order the coordinator closed them, so the last entry is
  // the most recent completion. It is read from the recorded state, so it is
  // the same row after a reload and no timer is involved.
  const justDone = project.closed.length > 0 ? project.closed[project.closed.length - 1] : null;

  return (
    <>
      {project.outcome && (
        <div data-testid="project-purpose">
          <SectionHeading icon={Target}>Purpose</SectionHeading>
          <div
            data-testid="project-outcome"
            className="mt-2.5 text-[13.5px] leading-[1.5] text-fg break-words"
          >
            {project.outcome}
          </div>
        </div>
      )}

      {(project.priority || project.now) && (
        <div data-testid="project-working-on">
          <SectionHeading icon={Focus}>Working on</SectionHeading>
          {project.priority && (
            <div
              data-testid="project-priority"
              className="mt-2.5 text-[13.5px] leading-[1.5] text-fg break-words"
            >
              {project.priority.text}
            </div>
          )}
          {project.now && (
            <div
              data-testid="project-now"
              className={`flex items-start gap-1.5 text-[12px] leading-[1.45] text-fg-3 ${project.priority ? 'mt-2' : 'mt-2.5'}`}
            >
              {coordinatorRunning && <Loader2 size={11} className="mt-[3px] shrink-0 animate-spin" />}
              <span className="min-w-0 break-words">{project.now}</span>
            </div>
          )}
        </div>
      )}

      {(open.length > 0 || justDone) && (
        <div data-testid="project-threads">
          <SectionHeading icon={ListTodo}>{shown.length > 0 ? 'Still to do' : 'Recently completed'}</SectionHeading>
          {shown.length > 0 && (
            <ul className="mt-3 space-y-3.5">
              {shown.map((thread) => (
                <li key={thread.seq} className="flex items-start gap-2.5">
                  <Circle size={11} strokeWidth={1.75} className="mt-[4.5px] shrink-0 text-fg-3" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-[1.45] text-fg break-words">{thread.text}</div>
                    {thread.waitingOn && (
                      <div className="mt-1 text-[12px] leading-[1.4] text-fg-3 break-words">
                        Waiting on {thread.waitingOn.text}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {hidden > 0 && (
            <button
              type="button"
              data-testid="project-threads-toggle"
              onClick={() => setThreadsExpanded((open) => !open)}
              className="mt-3 ml-[21px] flex items-center gap-1 text-[12px] font-medium text-fg-2 transition-colors hover:text-fg"
            >
              {threadsExpanded ? <ChevronUp size={13} className="shrink-0" aria-hidden /> : null}
              <span>{threadsExpanded ? 'Show less' : `+ ${hidden} more`}</span>
            </button>
          )}
          {justDone && (
            <div
              data-testid="project-thread-done"
              className={`flex items-start gap-2.5 ${shown.length > 0 || hidden > 0 ? 'mt-3.5' : 'mt-3'}`}
            >
              <CircleCheck size={11} strokeWidth={1.75} className="mt-[4.5px] shrink-0 text-fg-3" aria-hidden />
              <div className="min-w-0 flex-1 text-[13px] leading-[1.45] text-fg-3 break-words">
                {justDone.text}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
