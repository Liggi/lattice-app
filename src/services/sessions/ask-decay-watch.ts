/**
 * Asks the user leaves unanswered go to the project's backlog (2026-10-11,
 * thread 40853; Jason: "if i've moved way past it, or i didn't look at it
 * for 7 hours, it's probably either to go onto a 'backlog' of sorts for the
 * project or just fade away").
 *
 * Each pass parks every thread of a recently active coordinator that has
 * waited on the user for `ASK_DECAY_MS` without an answer, marked as decayed,
 * so it leaves Your calls and the sidebar's Needs you and sits in the panel's
 * backlog, where the user can restore it. The coordinator gets one line,
 * queued for its next input rather than waking it: a turn spent only on
 * reading that line would cost more than the line is worth. A new `--ask` on
 * the thread brings it back (`foldProjectState`).
 *
 * Left alone: a thread a live worker is on (a call that holds work up never
 * drops off, as in `types/your-calls.ts`), one other work waits on (`waitedOn`),
 * one the user has answered from its row or card since it began waiting, and
 * one waiting since before a message the coordinator is still taking in. Its age runs from the later of its wait
 * and the open question card about it, as the row's does.
 */

import { waitedThread, withoutThreadRefs, type ProjectOpenThread, type ProjectState } from '../../types/project-state.js';
import { isNeedsYou, threadOfWorker } from '../../types/state-of-play.js';
import type { WorkerState } from '../../types/worker-events.js';
import { DECISION_DISMISSED_EVENT } from '../../types/decisions.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { createLogger } from '../infrastructure/logger.js';
import { repliesOf } from './held-replies.js';
import { openDecision, type OpenDecision } from './open-decision.js';
import { appendProjectNote, readProjectState } from './project-state.js';
import { enqueueInboxItem } from './session-inbox.js';
import { ACTIVE_WINDOW_MS, activeCoordinators, alreadyQueued, isArchived } from './wait-watch.js';
import { readWorkerStates } from './worker-events.js';

const logger = createLogger('AskDecayWatch');

/** How long an ask can go unanswered before it moves to the backlog (Priority for 24h, All until 72h). */
export const ASK_DECAY_MS = 72 * 60 * 60 * 1000;

const SENDER = 'the server';

export interface DecayingAsk {
  thread: ProjectOpenThread;
  /** When it started waiting on the user, as its row counts it. */
  since: number;
}

/** The threads whose ask has gone unanswered past `ASK_DECAY_MS`. Pure; exported for tests. */
export function decayingAsks(input: {
  state: ProjectState;
  /** Workers not archived: the panel's live workers. */
  liveWorkers: ReadonlyArray<Pick<WorkerState, 'worker' | 'thread' | 'movedOn'> & Partial<Pick<WorkerState, 'phase' | 'waitingOn' | 'workedSinceReport'>>>;
  card: OpenDecision | null;
  repliedAt: ReadonlyMap<string, number>;
  now: number;
}): DecayingAsk[] {
  const { state, liveWorkers, card, repliedAt, now } = input;
  // A worker that already reported and stayed idle is no longer actively held up on the thread
  // (if it explicitly reported waiting on the thread, `waitedOn` below still keeps the ask alive).
  const worked = new Set(
    liveWorkers
      .filter((worker) => worker.phase !== 'reported' || Boolean(worker.workedSinceReport))
      .map((worker) => threadOfWorker(worker, state.open)),
  );
  return state.open.flatMap((thread) => {
    if (!isNeedsYou(thread) || worked.has(thread.seq) || waitedOn(thread, state.open, liveWorkers)) return [];
    const since = Math.max(thread.waitingSince, card?.asked.thread === thread.seq ? card.shownAt : 0);
    if (now - since < ASK_DECAY_MS) return [];
    if ((repliedAt.get(`t:${thread.seq}`) ?? -Infinity) >= since) return [];
    if (state.answeredBefore !== null && since <= state.answeredBefore) return [];
    return [{ thread, since }];
  });
}

/**
 * Whether other work is blocked on the thread: an open thread waiting on it as
 * a dependency (`--waiting-on dependency:<id>`), or a live worker whose report
 * still says it is waiting on it, by id or by the thread's name. Such a
 * question stays in front of the user rather than going to the backlog
 * (2026-10-17, CK3 thread 8112 decayed while four threads waited on it).
 */
export function waitedOn(
  thread: ProjectOpenThread,
  open: readonly ProjectOpenThread[],
  liveWorkers: ReadonlyArray<Partial<Pick<WorkerState, 'phase' | 'waitingOn' | 'workedSinceReport'>>>,
): boolean {
  if (open.some((other) => other.seq !== thread.seq && !other.parked && other.waitingOn && waitedThread(other.waitingOn) === thread.seq)) {
    return true;
  }
  const id = new RegExp(`(?<![\\d.])${thread.seq}(?![\\d.])`);
  const name = thread.name?.trim().toLowerCase();
  return liveWorkers.some((worker) => {
    if (worker.phase !== 'reported' || worker.workedSinceReport || !worker.waitingOn) return false;
    return id.test(worker.waitingOn) || (Boolean(name) && worker.waitingOn.toLowerCase().includes(name!));
  });
}

/** The line the coordinator reads, written to the user as "you" like every message they can read. Exported for tests. */
export function decayedLine(thread: ProjectOpenThread, waited: number): string {
  const name = withoutThreadRefs(thread.label ?? thread.name ?? thread.text);
  return `You left thread [${thread.seq}] "${name}" unanswered for ${Math.floor(waited / 3_600_000)} hours,`
    + ' so it has moved to the project\'s backlog. You can restore it from there.'
    + ' Ask again with a new --ask only if the work is truly blocked on you; otherwise leave it parked.';
}

/** Park each of one coordinator's asks that has decayed and queue its line. Returns the threads parked. Never throws. */
export function checkAskDecay(coordinator: string, now: number = Date.now()): number[] {
  const parked: number[] = [];
  try {
    const state = readProjectState(coordinator);
    if (!state.open.some(isNeedsYou)) return parked;
    const card = openDecision(coordinator);
    const due = decayingAsks({
      state,
      liveWorkers: readWorkerStates(coordinator).filter((worker) => !isArchived(worker.worker)),
      card,
      repliedAt: repliesOf(coordinator),
      now,
    });
    for (const { thread, since } of due) {
      const seq = appendProjectNote(coordinator, {
        kind: 'park',
        text: 'Unanswered for 72 hours',
        by: 'coordinator',
        ref: thread.seq,
        decayed: true,
      });
      if (seq === null) continue;
      parked.push(thread.seq);
      // Its card would otherwise stand in the panel on its own, as a card about a parked thread.
      if (card?.asked.thread === thread.seq) {
        const manager = getHarnessSessionManager();
        if (manager) appendCustomHarnessEvent(manager, coordinator, DECISION_DISMISSED_EVENT, { id: card.asked.id });
      }
      const deliveryId = `ask-decay:${thread.seq}:${since}`;
      if (!alreadyQueued(coordinator, deliveryId)) {
        enqueueInboxItem({ sessionId: coordinator, source: 'agent', sender: SENDER, text: decayedLine(thread, now - since), deliveryId });
      }
      logger.info('An ask went unanswered; moved it to the backlog', { coordinator, thread: thread.seq, since });
    }
  } catch (err) {
    logger.error('Checking for unanswered asks failed', err, { coordinator });
  }
  return parked;
}

/** The periodic pass: every recently active coordinator. */
export function checkAllAskDecay(now: number = Date.now()): void {
  for (const coordinator of activeCoordinators(now - ACTIVE_WINDOW_MS)) checkAskDecay(coordinator, now);
}
