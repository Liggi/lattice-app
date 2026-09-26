/**
 * Workers section of a coordinator's right panel: one card per worker the
 * coordinator has dispatched and not yet archived, in dispatch order. The
 * card is the worker's persistent object — the thread only logs its events
 * (see `src/types/worker-events.ts`). Archived workers stay in the data and
 * the thread; the panel is about the workers still in play.
 *
 * State line meanings, which must stay distinct (2026-09-19 flow agreement):
 * - Working                  a turn is in progress in the worker's session.
 *                            Not the same as the coordinator having handed
 *                            work over, which is what `phase` records and
 *                            what this line used to show.
 * - Waiting for coordinator  the worker asked and the coordinator has not
 *                            answered: either the question has not been
 *                            delivered into its session yet, or it has and
 *                            the coordinator is mid-turn. A running turn is
 *                            not evidence that it is answering this worker,
 *                            so the line says only what is known.
 * - Question pending         the question was delivered and the coordinator
 *                            is idle without having answered. Whether it
 *                            brought the question to the user is only visible
 *                            in the thread — the coordinator asks in its own
 *                            words — so the card never claims "Needs you".
 *                            `needsYou` is reserved for an explicit
 *                            escalation signal; nothing sets it today.
 * - Stopping                 a stop has been requested and the turn is
 *                            still winding down.
 * - Queued                   no turn in progress, but something is waiting
 *                            in its inbox: it is about to work again.
 * - Stopped                  the coordinator handed it work and no turn is
 *                            running: it was stopped, or its process exited
 *                            part-way, and no report came back. Unfinished
 *                            work, deliberately never shown as Reported.
 * - Reported                 the worker's turn ended with a report and it is
 *                            not running now. A reported worker that is
 *                            working again takes the runtime word instead:
 *                            resuming one leaves no event in the
 *                            coordinator's log, so the phase stays
 *                            `reported` while a turn is in progress.
 * - Archived                 the coordinator decided the worker is done and
 *                            archived its session (not rendered).
 *
 * The card shows the state word alone: the delivery narration that used to
 * follow it ("coordinator has it", "waiting for the coordinator's turn") and
 * the provider / model / start-time / context-size line were removed in the
 * 2026-09-20 review as information about the plumbing, not the work.
 *
 * A working worker also carries one short phrase for what it is doing now
 * ("Testing the composer"), written from its own work evidence by the server
 * (`services/sessions/worker-activity.ts`). It sits next to the state word
 * because it qualifies it. When there is none the state word stands alone:
 * the card never says the activity is unavailable, which would be the kind
 * of plumbing note the same review removed. A question or a report replaces
 * it — those are what the worker is doing.
 *
 * The card keeps its border and surface. Flattening the cards into hairline
 * rows was tried and made the panel worse, especially the workers: a worker is a distinct object you open, and the
 * card is what says so. Only the section heading changed, to the shared
 * `SectionHeading` the project half also uses.
 *
 * A pending question shows its first four lines, with "Show full question"
 * when there is more (2026-09-22: one worker's question made its card over
 * 3,000px tall). The clamp is visual only; the whole text stays in the DOM.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { ChevronUp, Loader2, Users } from 'lucide-react';
import { SectionHeading } from './SectionHeading';
import { stripWorkerQuestionMarker, workerResumedAfterReport, workerRuntimeWord, workerWaitingOn, type WorkerCardState } from '@/types/worker-events';

interface WorkersSectionProps {
  workers: WorkerCardState[];
  coordinatorRunning: boolean;
  onOpenWorker?: (conversationId: string) => void;
}

export function WorkersSection({ workers, coordinatorRunning, onOpenWorker }: WorkersSectionProps): JSX.Element | null {
  const current = workers.filter((worker) => !worker.archived);
  if (current.length === 0) return null;
  return (
    <div data-testid="workers-section">
      <SectionHeading icon={Users}>Workers</SectionHeading>
      <div className="mt-3 space-y-2">
        {current.map((worker) => (
          <WorkerCard key={worker.worker} worker={worker} coordinatorRunning={coordinatorRunning} onOpen={onOpenWorker} />
        ))}
      </div>
    </div>
  );
}

/** The state line: one word for where the worker stands, or what a reported worker is waiting on. */
export function workerStateLine(worker: WorkerCardState, coordinatorRunning: boolean): { state: string; needsYou: boolean; waiting: boolean } {
  if (worker.archived) return { state: 'Archived', needsYou: false, waiting: false };
  const waitingOn = workerWaitingOn(worker);
  if (waitingOn) return { state: `Waiting on ${waitingOn}`, needsYou: false, waiting: true };
  return { ...lifecycleLine(worker, coordinatorRunning), waiting: false };
}

function lifecycleLine(worker: WorkerCardState, coordinatorRunning: boolean): { state: string; needsYou: boolean } {
  switch (worker.phase) {
    case 'working':
      // `working` is the coordinator's record that it handed work over, not
      // evidence anything is running. What the process is actually doing is
      // the separate question `runtime` answers, and it decides the word.
      // Whatever it says, the assignment is unfinished, so none of these may
      // be Reported — that would claim a result nobody produced. The mapping
      // is shared with the CLI roster so the two windows cannot drift apart.
      return { state: workerRuntimeWord(worker), needsYou: false };
    case 'asked':
      return worker.reportReached && !coordinatorRunning
        ? { state: 'Question pending', needsYou: false }
        : { state: 'Waiting for coordinator', needsYou: false };
    case 'reported':
      // Reported is the last thing the coordinator heard, not a claim that
      // the worker has stopped. Resuming one writes nothing to that log, so
      // the runtime is the only witness that a turn is running again and it
      // decides the word — the same way it does for an unfinished worker.
      return workerResumedAfterReport(worker)
        ? { state: workerRuntimeWord(worker), needsYou: false }
        : { state: 'Reported', needsYou: false };
  }
}

function WorkerCard({
  worker,
  coordinatorRunning,
  onOpen,
}: {
  worker: WorkerCardState;
  coordinatorRunning: boolean;
  onOpen?: (conversationId: string) => void;
}) {
  const { state, needsYou, waiting } = workerStateLine(worker, coordinatorRunning);
  // The spinner and the activity phrase both claim work is happening now, so
  // they follow the runtime rather than the assignment phase. A card for a
  // stopped worker spinning away was half of what made the stale state look
  // alive.
  const working = (worker.phase === 'working' || workerResumedAfterReport(worker))
    && worker.runtime !== 'idle' && worker.runtime !== 'exited' && worker.runtime !== 'stopping';

  const question = worker.phase === 'asked' && worker.question ? stripWorkerQuestionMarker(worker.question) : null;
  const [questionOpen, setQuestionOpen] = useState(false);
  const [questionClipped, setQuestionClipped] = useState(false);
  const questionRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = questionRef.current;
    if (!node || questionOpen) return;
    const measure = () => setQuestionClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [question, questionOpen]);

  // The toggle is a sibling of the open button, not inside it, so the card is
  // a container rather than a button: nested buttons are invalid and the
  // inner click would also open the worker.
  return (
    <div
      ref={cardRef}
      data-testid="worker-card"
      data-worker-phase={worker.phase}
      className={`rounded-lg border transition-colors hover:bg-surface-2 ${
        needsYou ? 'border-accent/50 bg-surface' : 'border-line bg-surface'
      }`}
    >
      <button
        type="button"
        onClick={onOpen ? () => onOpen(worker.worker) : undefined}
        className={`block w-full px-3 pt-2.5 text-left ${question && (questionClipped || questionOpen) ? 'pb-1.5' : 'pb-2.5'}`}
      >
        <div className="text-[13px] leading-[1.4] text-fg break-words">{worker.task}</div>
        <div className={`mt-1.5 flex items-center gap-1.5 text-xs font-medium ${needsYou ? 'text-accent' : waiting ? 'text-amber-400/90' : 'text-fg-2'}`}>
          {working && <Loader2 size={12} className="shrink-0 animate-spin text-fg-3" />}
          <span data-testid="worker-state" className={working ? 'shrink-0 whitespace-nowrap' : 'min-w-0 break-words'}>{state}</span>
          {working && worker.activity && (
            <span data-testid="worker-activity" className="min-w-0 truncate font-normal text-fg-3">
              · {worker.activity}
            </span>
          )}
        </div>
        {question && (
          <div
            ref={questionRef}
            data-testid="worker-question"
            className={`mt-1.5 whitespace-pre-wrap break-words text-[12.5px] leading-[1.45] text-fg-2 ${questionOpen ? '' : 'line-clamp-4'}`}
          >
            {question}
          </div>
        )}
      </button>
      {question && (questionClipped || questionOpen) && (
        <button
          type="button"
          data-testid="worker-question-toggle"
          aria-expanded={questionOpen}
          onClick={() => {
            // Collapsing from deep in a long question would leave the card
            // scrolled away above the panel's view.
            if (questionOpen) requestAnimationFrame(() => cardRef.current?.scrollIntoView({ block: 'nearest' }));
            setQuestionOpen((open) => !open);
          }}
          className="sticky bottom-0 flex w-full items-center gap-1 rounded-b-lg bg-inherit px-3 pb-2.5 pt-1 text-left text-[12px] font-medium text-fg-2 transition-colors hover:text-fg"
        >
          {questionOpen ? <ChevronUp size={13} className="shrink-0" aria-hidden /> : null}
          <span>{questionOpen ? 'Show less' : 'Show full question'}</span>
        </button>
      )}
    </div>
  );
}
