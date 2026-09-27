/**
 * The user dismissing one of a coordinator's threads from the panel, and
 * bringing one back (2026-09-27).
 *
 * Dismissing parks the thread as the user's call, stops the workers carrying
 * it the way the Stop button does, closes the question card the coordinator
 * asked about it (`lattice ask --thread`), and hands the coordinator one
 * attributed line saying so, so it stops working on it and does not bring it
 * back. Bringing it back unparks it and tells the coordinator the same way;
 * the workers that were stopped stay stopped.
 *
 * The thread shows each as a line from its park or unpark note, which carries
 * the name the panel showed; the inbox line is for the coordinator only.
 */

import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { createLogger } from '../infrastructure/logger.js';
import { DECISION_DISMISSED_EVENT, isOpenDecision } from '../../types/decisions.js';
import { threadOfWorker } from '../../types/state-of-play.js';
import { withoutThreadRefs, type ProjectOpenThread } from '../../types/project-state.js';
import { appendProjectNote, readProjectState } from './project-state.js';
import { readWorkerStates } from './worker-events.js';
import { decisionsIn } from './open-decision.js';
import { enqueueInboxItem } from './session-inbox.js';
import { handOverNow } from './immediate-delivery.js';
import { interruptTurn } from './turn-interrupt.js';
import { UserName } from '../user-profile.js';

const logger = createLogger('ThreadDismissal');

export class DismissalError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function panelName(thread: ProjectOpenThread): string {
  return withoutThreadRefs(thread.label ?? thread.text);
}

/** The line the coordinator reads when the user dismisses a thread. Exported for tests. */
export function dismissedLine(thread: ProjectOpenThread, stopped: readonly string[]): string {
  const workers = stopped.length === 0 ? ''
    : stopped.length === 1 ? ` Its worker ${stopped[0]} was stopped.`
    : ` Its workers ${stopped.join(', ')} were stopped.`;
  return `${UserName()} dismissed thread [${thread.seq}] "${panelName(thread)}" from their panel. It is parked as their call.${workers}`
    + ' Stop working on it and do not bring it back; they can restore it from Parked themselves.';
}

/** The line the coordinator reads when the user brings a dismissed or parked thread back. Exported for tests. */
export function restoredLine(thread: ProjectOpenThread): string {
  return `${UserName()} brought thread [${thread.seq}] "${panelName(thread)}" back from Parked. It is open again;`
    + ' any worker stopped when it was dismissed is still stopped.';
}

function openThread(coordinator: string, seq: number): ProjectOpenThread {
  const thread = readProjectState(coordinator).open.find((candidate) => candidate.seq === seq);
  if (!thread) throw new DismissalError(`Thread ${seq} is not an open thread of this project.`, 404);
  return thread;
}

async function tellCoordinator(coordinator: string, text: string): Promise<void> {
  const inboxId = enqueueInboxItem({ sessionId: coordinator, source: 'dismissal', text });
  await handOverNow(coordinator, inboxId);
}

export async function dismissThread(coordinator: string, seq: number): Promise<{ stopped: string[] }> {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  const thread = openThread(coordinator, seq);
  if (thread.parked) throw new DismissalError(`Thread ${seq} is already parked.`, 409);

  const state = readProjectState(coordinator);
  const carrying = readWorkerStates(coordinator).filter((worker) => threadOfWorker(worker, state.open) === seq);

  if (appendProjectNote(coordinator, { kind: 'park', text: `${UserName()} dismissed it from the panel`, by: 'user', ref: seq, label: panelName(thread) }) === null) {
    throw new Error(`The dismissal could not be written to ${coordinator}`);
  }

  // As the Stop button does, without its "stopped your worker" line: the
  // dismissal line says so.
  const stopped: string[] = [];
  for (const worker of carrying) {
    const before = manager.inspect(worker.worker);
    const midTurn = Boolean(before?.processAlive) && (before?.status === 'streaming' || before?.status === 'starting');
    if (!midTurn) continue;
    try {
      await interruptTurn(manager, worker.worker);
      stopped.push(worker.worker);
    } catch (err) {
      logger.warn('Stopping a dismissed thread\'s worker failed', { coordinator, worker: worker.worker, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const decision of decisionsIn(coordinator).values()) {
    if (decision.asked.thread === seq && isOpenDecision(decision)) {
      appendCustomHarnessEvent(manager, coordinator, DECISION_DISMISSED_EVENT, { id: decision.asked.id });
    }
  }

  await tellCoordinator(coordinator, dismissedLine(thread, stopped));
  return { stopped };
}

export async function restoreThread(coordinator: string, seq: number): Promise<void> {
  const thread = openThread(coordinator, seq);
  if (!thread.parked) throw new DismissalError(`Thread ${seq} is not parked.`, 409);
  if (appendProjectNote(coordinator, { kind: 'unpark', text: `${UserName()} brought it back from Parked`, by: 'user', ref: seq, label: panelName(thread) }) === null) {
    throw new Error(`The restore could not be written to ${coordinator}`);
  }
  await tellCoordinator(coordinator, restoredLine(thread));
}
