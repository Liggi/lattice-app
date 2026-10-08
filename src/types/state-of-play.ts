/**
 * The coordinator panel's to-do list as a state of play: what needs the
 * user, who is working, what is held and what is next, in the user's order.
 *
 * Derived from the coordinator's project state and its worker roster, so
 * nothing new has to be kept in step:
 *
 *   Needs you    the thread's owner is the user (`isNeedsYou`). A thread
 *                someone else owns never shows here, whatever it waits on:
 *                "waiting on a decision" also covered decisions other people
 *                owed, and half the long-lived rows were not the user's
 *                (2026-10-07, two weeks of real projects replayed).
 *   Workers      every live worker, named by its task, whatever thread it is
 *                on (2026-09-28, Jason picked a list of its own over folding
 *                workers into the threads: a worker sent on to new work while
 *                its thread waited on him showed nowhere). A thread a live
 *                worker carries is not listed again; the worker stands for it.
 *   In progress  nobody on it, and it waits on something outside the project
 *                (a worker, a dependency, a resource, someone else as owner).
 *   Next         the rest: open, not the user's, nobody on it, not waiting.
 *
 * A worker on a parked thread is not listed: it was parked with it.
 *
 * Order within each section is the project's rank (`note --rank`), then the
 * priority's thread if nothing is ranked, then the order threads opened.
 * Parked threads are listed apart, and their order is the order they opened.
 */

import type { ProjectOpenThread, ProjectState } from './project-state.js';
import type { WorkerCardState } from './worker-events.js';

export interface PlayItem {
  /** The thread id. */
  key: string;
  thread: ProjectOpenThread;
  /** What the panel calls it: the coordinator's short label, else the thread's text. */
  label: string;
  /** Live workers carrying it, in dispatch order: what dismissing it stops. */
  workers: WorkerCardState[];
  /** Set when it is held on something outside the project: what, in the coordinator's words. */
  heldOn: string | null;
}

export interface StateOfPlay {
  needsYou: PlayItem[];
  /** Live workers, in dispatch order. */
  workers: WorkerCardState[];
  inProgress: PlayItem[];
  next: PlayItem[];
  parked: PlayItem[];
}

/** Whether the thread is the user's move: they own it. */
export function isUsersMove(thread: Pick<ProjectOpenThread, 'owner'>): boolean {
  return thread.owner?.kind === 'user';
}

/**
 * Whether the thread is listed under Needs you: open, not parked and the
 * user's move. A message from the user never hides it here (2026-10-07,
 * Jason: every row vanished at any message, even "lol"); only the sidebar's
 * indicator pauses on one (`project-needs-you.ts`).
 */
export function isNeedsYou(thread: ProjectOpenThread): boolean {
  return !thread.parked && isUsersMove(thread);
}

/**
 * Which open thread a worker is carrying: the one it was dispatched or last
 * reassigned onto, else the latest that names it, as one of its workers or as
 * its owner. A reassigned worker carries only the thread its reassignment
 * named: the threads that still list it are ones it has left.
 */
export function threadOfWorker(worker: Pick<WorkerCardState, 'worker' | 'thread' | 'movedOn'>, open: readonly ProjectOpenThread[]): number | null {
  if (worker.thread !== null && open.some((thread) => thread.seq === worker.thread)) return worker.thread;
  if (worker.movedOn) return null;
  const naming = open.filter((thread) => thread.workers.includes(worker.worker)
    || (thread.owner?.kind === 'worker' && thread.owner.worker === worker.worker));
  return naming.length > 0 ? naming[naming.length - 1].seq : null;
}

/** What a thread that is not the user's move is held on, if anything. */
function heldOn(thread: ProjectOpenThread): string | null {
  if (thread.waitingOn) return thread.waitingOn.text;
  if (thread.owner?.kind === 'external') return thread.owner.who;
  return null;
}

export function deriveStateOfPlay(project: ProjectState, workers: readonly WorkerCardState[]): StateOfPlay {
  const open = project.open.filter((thread) => !thread.parked);
  const parkedSeqs = new Set(project.open.filter((thread) => thread.parked).map((thread) => thread.seq));

  const onThread = new Map<number, WorkerCardState[]>();
  const live: WorkerCardState[] = [];
  for (const worker of workers) {
    if (worker.archived) continue;
    // A worker on a parked thread went with it: dismissing a thread stops its workers.
    const seq = threadOfWorker(worker, project.open);
    if (seq !== null && parkedSeqs.has(seq)) continue;
    live.push(worker);
    if (seq !== null) onThread.set(seq, [...(onThread.get(seq) ?? []), worker]);
  }

  const ranked = project.rank?.length ? project.rank : project.priority?.thread != null ? [project.priority.thread] : [];
  const position = (seq: number): number => {
    const at = ranked.indexOf(seq);
    return at === -1 ? ranked.length : at;
  };
  const inOrder = [...open].sort((a, b) => position(a.seq) - position(b.seq) || a.seq - b.seq);

  const play: StateOfPlay = { needsYou: [], workers: live, inProgress: [], next: [], parked: [] };
  for (const thread of inOrder) {
    const needsYou = isNeedsYou(thread);
    const item: PlayItem = {
      key: String(thread.seq),
      thread,
      label: thread.label ?? thread.text,
      workers: onThread.get(thread.seq) ?? [],
      heldOn: needsYou ? null : heldOn(thread),
    };
    if (needsYou) play.needsYou.push(item);
    else if (item.workers.length > 0) continue;
    else if (item.heldOn) play.inProgress.push(item);
    else play.next.push(item);
  }
  for (const thread of project.open.filter((candidate) => candidate.parked)) {
    play.parked.push({ key: String(thread.seq), thread, label: thread.label ?? thread.text, workers: [], heldOn: null });
  }
  return play;
}
