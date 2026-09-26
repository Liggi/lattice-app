/**
 * Moving work between projects: a worker (`session move-worker`) or an open
 * thread (`session move-thread`), for when a project is split in two.
 *
 * A worker belongs to a project in two places, and a move has to change
 * both. `conversations.picked_up_from` decides where its reports are
 * delivered. The card, the roster and the thread come from the coordinator's
 * own event log, which cannot be edited: a move that only rewrote the column
 * left the card in the old project and the new one saying it had dispatched
 * nobody (the canary split, 2026-09-23). So the old log gets a
 * `worker:moved`, which takes the card away, and the new one a
 * `worker:started` carrying `movedFrom`, which makes one where it stood.
 *
 * A thread is a fold over notes in one log, and its id is the seq of its
 * `open` note there, so it cannot keep its id. It is opened again in the new
 * project with what it had — text, where it has got to, owner, next action,
 * wait, workers, evidence — plus a pointer back, and closed in the old one
 * saying where it went.
 *
 * Anything a moved worker or thread reported that nobody had accounted for is
 * copied into the new log and becomes that project's to dispose of; the old
 * project stops owing it. A report still waiting in the old coordinator's
 * inbox is not moved: the move is refused until it has been read, because a
 * row half-moved between two inboxes is worse than a short wait.
 */

import type Database from 'better-sqlite3';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import { ConversationService } from './conversation-service.js';
import { SessionInfoService } from './session-info-service.js';
import { appendProjectNote, readProjectState } from './project-state.js';
import { appendWorkerEvent, readWorkerStates, startAccountingIfUnstarted } from './worker-events.js';
import { readWorkerRuntime } from './worker-runtime.js';
import {
  WORKER_REPORT_SUMMARY_EVENT,
  type MovedEventOrigin,
  type WorkerAskedData,
  type WorkerReportedData,
  type WorkerReportSummaryData,
} from '../../types/worker-events.js';
import type { PendingAttention, ProjectOpenThread } from '../../types/project-state.js';

export class ProjectMoveError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}

export interface WorkerMoveResult {
  worker: string;
  from: string;
  to: string;
  /** The open thread in the new project it was attached to; null when none. */
  thread: number | null;
  /** Old seq -> new seq for each report or question carried over. */
  copied: Array<{ from: number; to: number }>;
  /** Things the move did not change and someone should look at. */
  warnings: string[];
  /**
   * Whether the worker is in a turn now, which is when it needs telling: it
   * will read a message at its next input point. An idle or archived one
   * would be started up by the message, so the CLI leaves it be.
   */
  midTurn: boolean;
}

export interface ThreadMoveResult {
  from: string;
  to: string;
  /** The thread's id in the project it left. */
  thread: number;
  /** Its id in the project it moved to. */
  newThread: number;
  copied: Array<{ from: number; to: number }>;
  workers: WorkerMoveResult[];
  warnings: string[];
}

function db(): Database.Database {
  return DatabaseProvider.getInstance().getDb();
}

/** What a project is called: the name the user gave it, else the generated one, else its outcome. */
async function projectLabel(coordinator: string): Promise<string | null> {
  try {
    const info = await SessionInfoService.getInstance().getSessionInfo(coordinator);
    const named = info.custom_name?.trim() || info.project_name?.trim();
    if (named) return named;
  } catch {
    // Falls through to the outcome.
  }
  return readProjectState(coordinator).outcome?.trim() || null;
}

function requireCoordinator(id: string, role: 'from' | 'to'): void {
  const conversation = ConversationService.getInstance().getConversation(id);
  if (!conversation) throw new ProjectMoveError(`${role} ${id} not found`, 404);
  if (!conversation.coordinator) throw new ProjectMoveError(`${role} ${id} is not a project coordinator`);
}

/**
 * Reports and questions from `from` that are still waiting in its inbox. A
 * move is refused while any of these exist; see the file comment.
 */
function unreadWorkerRows(from: string, match: { worker?: string; seqs?: ReadonlySet<number> }): number {
  const rows = db().prepare(
    `SELECT worker, source_seq FROM session_inbox
      WHERE session_id = ? AND read_at IS NULL AND source IN ('worker-report', 'worker-question')`,
  ).all(from) as Array<{ worker: string | null; source_seq: number | null }>;
  return rows.filter((row) => (match.worker !== undefined && row.worker === match.worker)
    || (match.seqs !== undefined && row.source_seq !== null && match.seqs.has(row.source_seq))).length;
}

/**
 * Copy pending reports and questions into `to`, each still owed a
 * disposition there. With `thread`, they count against that thread whether
 * or not the worker that wrote them came along. A report's card summary comes
 * too, so the copy reads the same as the original.
 */
function copyPending(
  from: string,
  to: string,
  fromProject: string | null,
  items: readonly PendingAttention[],
  thread: number | null,
): Array<{ from: number; to: number }> {
  if (items.length === 0) return [];
  const manager = getHarnessSessionManager();
  if (!manager) throw new ProjectMoveError('no harness session manager; nothing was copied', 503);
  const events = getEvents(from);
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const copied: Array<{ from: number; to: number }> = [];
  for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    const original = bySeq.get(item.seq);
    if (!original) continue;
    const movedFrom: MovedEventOrigin = { coordinator: from, project: fromProject, seq: item.seq };
    const extra = { movedFrom, ...(thread !== null ? { thread } : {}) };
    const appended = original.type === 'worker:asked'
      ? appendWorkerEvent(to, 'worker:asked', { ...(original.data as WorkerAskedData), ...extra })
      : appendWorkerEvent(to, 'worker:reported', { ...(original.data as WorkerReportedData), ...extra });
    if (!appended) throw new ProjectMoveError(`could not copy event ${item.seq} into ${to}`, 500);
    copied.push({ from: item.seq, to: appended.seq });
    const summary = events.find((event) => event.type === WORKER_REPORT_SUMMARY_EVENT
      && (event.data as Partial<WorkerReportSummaryData>)?.reportSeq === item.seq);
    if (summary) {
      appendCustomHarnessEvent(manager, to, WORKER_REPORT_SUMMARY_EVENT, {
        ...(summary.data as WorkerReportSummaryData),
        reportSeq: appended.seq,
      } satisfies WorkerReportSummaryData);
    }
  }
  return copied;
}

/**
 * Move one worker from the project that dispatched it (or last received it)
 * to another. Its later reports go to `to`, both projects' cards say so, and
 * whatever it had outstanding in `from` is owed in `to` instead. A worker
 * mid-turn needs nothing special: its report is delivered at the end of the
 * turn, and delivery reads the column this changes.
 */
export async function moveWorker(input: {
  worker: string;
  from: string;
  to: string;
  thread?: number;
  /** Set by `moveThread`, which has already copied the thread's reports. */
  skipCopy?: ReadonlySet<number>;
}): Promise<WorkerMoveResult> {
  const { worker, from, to } = input;
  if (from === to) throw new ProjectMoveError('from and to are the same project');
  requireCoordinator(from, 'from');
  requireCoordinator(to, 'to');
  const conversation = ConversationService.getInstance().getConversation(worker);
  if (!conversation) throw new ProjectMoveError(`worker ${worker} not found`, 404);
  if (conversation.pickedUpFrom !== from) {
    throw new ProjectMoveError(`${worker} reports to ${conversation.pickedUpFrom ?? 'no project'}, not ${from}`);
  }
  const card = readWorkerStates(from).find((state) => state.worker === worker);
  if (!card) throw new ProjectMoveError(`${from} has no card for ${worker}; nothing to move`);

  const toState = readProjectState(to);
  const thread = input.thread ?? null;
  if (thread !== null && !toState.open.some((candidate) => candidate.seq === thread)) {
    throw new ProjectMoveError(`thread ${thread} is not open in ${to}: ${toState.open.map((t) => t.seq).join(', ') || 'none open'}`);
  }
  const waiting = unreadWorkerRows(from, { worker });
  if (waiting > 0) {
    throw new ProjectMoveError(
      `${from} has ${waiting} report${waiting === 1 ? '' : 's'} or question${waiting === 1 ? '' : 's'} from ${worker} it has not read yet; `
        + 'move it once they have been delivered',
      409,
    );
  }

  const fromState = readProjectState(from);
  const [fromProject, toProject] = await Promise.all([projectLabel(from), projectLabel(to)]);

  // The new card first, so a report the worker ends its turn with in the
  // middle of this lands on a project that already knows it.
  const started = appendWorkerEvent(to, 'worker:started', {
    worker,
    provider: card.provider,
    model: card.model,
    task: card.task,
    ...(thread !== null ? { thread } : {}),
    movedFrom: { coordinator: from, project: fromProject, phase: card.phase },
  });
  if (!started) throw new ProjectMoveError(`could not write the worker into ${to}; nothing was moved`, 500);

  const pending = fromState.attention.filter((item) => item.worker === worker && !input.skipCopy?.has(item.seq));
  const copied = copyPending(from, to, fromProject, pending, null);

  db().transaction(() => {
    db().prepare('UPDATE conversations SET picked_up_from = ?, updated_at = ? WHERE conversation_id = ?')
      .run(to, new Date().toISOString(), worker);
    db().prepare('UPDATE worker_activity SET coordinator = ? WHERE worker = ?').run(to, worker);
  })();
  appendWorkerEvent(from, 'worker:moved', { worker, to, project: toProject, task: card.task });

  // What the move leaves for someone to decide: work in the old project that
  // still names this worker. Rewriting those threads would be guessing.
  const warnings = fromState.open
    .filter((candidate) => (candidate.owner?.kind === 'worker' && candidate.owner.worker === worker)
      || (candidate.waitingOn?.worker === worker))
    .map((candidate) => `thread [${candidate.seq}] in ${from} still names ${worker} as its owner or what it waits on`);
  const runtime = readWorkerRuntime(worker);
  const archived = Boolean((await SessionInfoService.getInstance().getSessionInfo(worker)).archived);
  const midTurn = !archived && (runtime === 'working' || runtime === 'starting');
  return { worker, from, to, thread, copied, warnings, midTurn };
}

/**
 * Move one open thread, with where it has got to and whatever it is owed,
 * from one project's record to another's. The workers carrying it come too,
 * unless one is also carrying another open thread in the old project, which
 * would be left with nobody; those are named in the warnings instead.
 */
export async function moveThread(input: { from: string; to: string; thread: number }): Promise<ThreadMoveResult> {
  const { from, to, thread } = input;
  if (from === to) throw new ProjectMoveError('from and to are the same project');
  requireCoordinator(from, 'from');
  requireCoordinator(to, 'to');
  const fromState = readProjectState(from);
  const source: ProjectOpenThread | undefined = fromState.open.find((candidate) => candidate.seq === thread);
  if (!source) {
    const closed = fromState.closed.some((candidate) => candidate.seq === thread);
    throw new ProjectMoveError(closed
      ? `thread ${thread} is closed in ${from}; only open work moves`
      : `thread ${thread} is not a thread of ${from}: ${fromState.open.map((t) => t.seq).join(', ') || 'none open'}`);
  }
  const owed = fromState.attention.filter((item) => item.thread === thread);
  const waiting = unreadWorkerRows(from, { seqs: new Set(owed.map((item) => item.seq)) });
  if (waiting > 0) {
    throw new ProjectMoveError(`${from} has ${waiting} report${waiting === 1 ? '' : 's'} on this thread it has not read yet; move it once they have been delivered`, 409);
  }

  // Which of its workers can come along: still reporting to `from`, and not
  // also carrying something else there.
  const conversations = ConversationService.getInstance();
  const elsewhere = new Set(fromState.open
    .filter((candidate) => candidate.seq !== thread)
    .flatMap((candidate) => [...candidate.workers, ...(candidate.owner?.kind === 'worker' ? [candidate.owner.worker] : [])]));
  const warnings: string[] = [];
  const movers: string[] = [];
  for (const worker of source.workers) {
    if (conversations.getConversation(worker)?.pickedUpFrom !== from) continue;
    if (elsewhere.has(worker)) {
      warnings.push(`${worker} also carries another open thread in ${from}, so it stayed; move it with move-worker if it should go`);
      continue;
    }
    movers.push(worker);
  }

  const [fromProject, toProject] = await Promise.all([projectLabel(from), projectLabel(to)]);
  // Accounting has to be on before the copies land, or they would arrive as
  // history nobody is asked to dispose of.
  startAccountingIfUnstarted(to);
  const opened = appendProjectNote(to, {
    kind: 'open',
    text: source.text,
    by: 'coordinator',
    ...(source.owner ? { owner: source.owner } : {}),
    ...(source.nextAction ? { nextAction: source.nextAction } : {}),
    waitingOn: source.waitingOn,
    workers: source.workers,
    evidence: [...source.evidence, `moved from ${fromProject ? `${fromProject} (${from})` : from} thread [${thread}]`],
    movedFrom: { coordinator: from, thread },
  });
  if (opened === null) throw new ProjectMoveError(`could not open the thread in ${to}; nothing was moved`, 500);
  if (source.summary) {
    appendProjectNote(to, { kind: 'update', text: source.summary, by: 'coordinator', ref: opened });
  }
  const copied = copyPending(from, to, fromProject, owed, opened);

  const moved: WorkerMoveResult[] = [];
  const alreadyCopied = new Set(owed.map((item) => item.seq));
  for (const worker of movers) {
    moved.push(await moveWorker({ worker, from, to, thread: opened, skipCopy: alreadyCopied }));
  }

  // Closing accounts for what the thread was owed here; the copies are owed there.
  appendProjectNote(from, {
    kind: 'close',
    text: `Moved to ${toProject ?? to} as thread [${opened}]`,
    by: 'coordinator',
    ref: thread,
    movedTo: { coordinator: to, thread: opened },
  });
  return {
    from, to, thread, newThread: opened, copied, workers: moved,
    warnings: [...warnings, ...moved.flatMap((result) => result.warnings.filter((warning) => !warning.startsWith(`thread [${thread}]`)))],
  };
}
