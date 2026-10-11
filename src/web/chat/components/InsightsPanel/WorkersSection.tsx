/**
 * A worker's row in a coordinator's right panel, under Workers
 * (`StateOfPlaySection`), titled with its current task. On 2026-09-27 the
 * workers were folded into the to-do items they carried; that hid a worker
 * sent on to new work while its old item waited on the user, so on
 * 2026-09-28 they got their own list back. The row is the worker's persistent
 * object — the thread only logs its events (see `src/types/worker-events.ts`).
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
 * (`services/sessions/worker-activity.ts`). The cube already says it is
 * working, so the phrase stands in for the word (2026-10-10: "Working ·
 * Testing the composer" in a heavier weight outweighed the job rows beside
 * it). When there is none the state word stands alone:
 * the row never says the activity is unavailable, which would be the kind
 * of plumbing note the same review removed. A question or a report replaces
 * it — those are what the worker is doing.
 *
 * A worker is a row in the left sidebar's language rather than a boxed card
 * (2026-09-27, Jason picked the "short waits" variant): the sidebar's cube in
 * a 28px icon column, the task, and the state line under it. The cube is
 * cyan and animated while a turn runs and a still outline otherwise, so the
 * running workers stand out without a word being read. Only a worker whose
 * question is with the coordinator breathes cyan: a declared wait is the idle
 * grey cube, still, so a row of waiting workers does not read as running.
 * The exception is a wait on the worker's own job while that job is moving:
 * the worker spends no turn but its work goes on, so it takes the question's
 * fading cyan centre (2026-10-10, thread 37998, Jason picked it over the
 * working cube).
 * The state line is set apart from the task by colour alone: the hairline
 * that used to sit over it went on 2026-10-10, when Jason picked flatter
 * rows to sit with the tick-strip jobs.
 *
 * A wait says what it is for on the row: "Waiting for a turn on the PC"
 * (2026-10-10, thread 37369, Jason picked it over grouping the waiting
 * workers). The phrase is the worker's declared wait shortened by
 * `worker-wait-phrase.ts`; until it is written the row shows the worker's
 * own words, "Waiting on …". It replaced a bare "Waiting" with the reason
 * behind a hover or tap, which on a phone left five rows saying only that.
 * The row under a wait reference does not take its own hover shade while
 * the reference lights the row it names, so only one row is lit.
 *
 * A worker reporting a long job carries it inside its row, under the state
 * line (`NarrowPanel`, 2026-10-10, thread 36692), and its task is brighter
 * than a jobless worker's. When the job has stopped moving the cube goes
 * still, even if the worker is busy with something else: the stuck job is
 * what the row has to say first.
 *
 * A pending question shows its first four lines, with "Show full question"
 * when there is more (2026-09-22: one worker's question made its card over
 * 3,000px tall). The clamp is visual only; the whole text stays in the DOM.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { ChevronUp } from 'lucide-react';
import { WaitText, type WaitTextContext } from './WaitText';
import { SessionStateIcon, type StateIconState } from '@/web/chat/components/shared/session-state-icon/SessionStateIcon';
import type { WorkerJobs } from './NarrowPanel';
import { stripWorkerQuestionMarker, workerPendingState, workerResumedAfterReport, workerRuntimeWord, workerWaitingOn, type WorkerCardState } from '@/types/worker-events';

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


export function WorkerRow({
  worker,
  coordinatorRunning,
  onOpen,
  waitContext,
  pointed,
  pointing,
  jobs,
}: {
  worker: WorkerCardState;
  coordinatorRunning: boolean;
  onOpen?: (conversationId: string) => void;
  waitContext?: WaitTextContext;
  pointed: boolean;
  /** Some reference is under the pointer, so only the row it names is lit. */
  pointing: boolean;
  jobs?: WorkerJobs;
}): JSX.Element {
  const { state, needsYou, waiting } = workerStateLine(worker, coordinatorRunning);
  const waitingOn = waiting ? workerWaitingOn(worker) : null;
  // The cube and the activity phrase both claim work is happening now, so
  // they follow the runtime rather than the assignment phase.
  const working = workerPendingState(worker) === 'working' || ((worker.phase === 'working' || workerResumedAfterReport(worker))
    && worker.runtime !== 'idle' && worker.runtime !== 'exited' && worker.runtime !== 'stopping');
  const jobMoving = jobs !== undefined && !jobs.stalled;
  const icon: StateIconState = jobs?.stalled ? { kind: 'idle' }
    : working ? { kind: 'working', level: 1 }
    : worker.phase === 'asked' || (waiting && jobMoving) ? { kind: 'waiting' }
    : { kind: 'idle' };

  const question = worker.phase === 'asked' && worker.question ? stripWorkerQuestionMarker(worker.question) : null;
  const [questionOpen, setQuestionOpen] = useState(false);
  const [questionClipped, setQuestionClipped] = useState(false);
  const questionRef = useRef<HTMLSpanElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = questionRef.current;
    if (!node || questionOpen) return;
    const measure = () => setQuestionClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [question, questionOpen]);

  const waitPhrase = waitingOn && worker.waitPhrase;
  const waitText = waitPhrase || waitingOn;
  const waitReason = waitText ? (waitContext ? <WaitText text={waitText} {...waitContext} /> : waitText) : null;
  let status: React.ReactNode;
  if (waitReason) {
    status = (
      <span data-testid="worker-state" className="text-fg-3">
        {waitPhrase ? 'Waiting for' : 'Waiting on'} {waitReason}
      </span>
    );
  } else {
    status = (
      <>
        {working && worker.activity
          ? <span data-testid="worker-activity" className="text-fg-3">{worker.activity}</span>
          : <span data-testid="worker-state" className={needsYou ? 'text-accent' : 'text-fg-3'}>{state}</span>}
      </>
    );
  }

  // The toggle is a sibling of the open button, not inside it: nested
  // buttons are invalid and the inner click would also open the worker.
  return (
    <div
      ref={rowRef}
      data-testid="worker-card"
      data-worker={worker.worker}
      data-worker-phase={worker.phase}
      data-pointed={pointed || undefined}
      className={`group rounded-sm bg-bg transition-colors ${pointing ? '' : 'hover:bg-surface-2'}`}
    >
      <div className="flex items-start">
      <button
        type="button"
        onClick={onOpen ? () => onOpen(worker.worker) : undefined}
        className="flex min-w-0 flex-1 items-start gap-2.5 px-2 py-1.5 text-left"
      >
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center ${pointed ? 'text-fg-2' : 'text-fg-3'}`}>
          <SessionStateIcon state={icon} variant="session" />
        </span>
        <span className="flex min-h-7 min-w-0 flex-1 flex-col justify-center">
          <span className={`text-[13px] leading-[1.45] break-words text-pretty ${jobs || pointed ? 'text-fg' : 'text-fg-2'}`}>{worker.task}</span>
          <span className="mt-0.5 text-[12.5px] leading-[1.4] break-words">{status}</span>
          {question && (
            <span
              ref={questionRef}
              data-testid="worker-question"
              className={`mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-[1.45] text-fg-2 ${questionOpen ? '' : 'line-clamp-4'}`}
            >
              {question}
            </span>
          )}
          {jobs?.content}
        </span>
      </button>
      </div>
      {question && (questionClipped || questionOpen) && (
        <button
          type="button"
          data-testid="worker-question-toggle"
          aria-expanded={questionOpen}
          onClick={() => {
            // Collapsing from deep in a long question would leave the row
            // scrolled away above the panel's view.
            if (questionOpen) requestAnimationFrame(() => rowRef.current?.scrollIntoView({ block: 'nearest' }));
            setQuestionOpen((open) => !open);
          }}
          className="sticky bottom-0 -mt-1 flex w-full items-center gap-1 rounded-b-sm bg-inherit pb-1.5 pl-[46px] pt-1 text-left text-[12px] font-medium text-fg-3 transition-colors hover:text-fg"
        >
          {questionOpen ? <ChevronUp size={13} className="shrink-0" aria-hidden /> : null}
          <span>{questionOpen ? 'Show less' : 'Show full question'}</span>
        </button>
      )}
    </div>
  );
}
