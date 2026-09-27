/**
 * The coordinator panel's to-do list as a state of play: what needs the
 * user, what is moving and what is next, in the user's order (2026-09-27).
 *
 * Derived from the coordinator's project state and its worker roster, so
 * nothing new has to be kept in step:
 *
 *   Needs you    the thread's owner is the user, or it waits on a decision.
 *   In progress  a live worker is on it, or it waits on something outside
 *                the project (a worker, a dependency, a resource, someone
 *                else as its owner).
 *   Next         the rest: open, not the user's, nobody on it, not waiting.
 *
 * A live worker on no open thread is In progress in its own right, named
 * by its task, so running work never drops out of the panel. One on a
 * parked thread is not listed: it was parked with it.
 *
 * Order within each section is the project's rank (`note --rank`), then the
 * priority's thread if nothing is ranked, then the order threads opened.
 * Parked threads are listed apart, and their order is the order they opened.
 */

import type { ProjectOpenThread, ProjectState } from './project-state.js';
import type { WorkerCardState } from './worker-events.js';

export interface PlayItem {
  /** `thread` for a thread of the project; `worker` for a live worker on no open thread. */
  kind: 'thread' | 'worker';
  /** The thread id, or the worker's conversation id. */
  key: string;
  thread: ProjectOpenThread | null;
  /** What the panel calls it: the coordinator's short label, else the thread's text, else the worker's task. */
  label: string;
  /** Live workers on it, in dispatch order. */
  workers: WorkerCardState[];
  /** Set when it is held on something outside the project: what, in the coordinator's words. */
  heldOn: string | null;
}

export interface StateOfPlay {
  needsYou: PlayItem[];
  inProgress: PlayItem[];
  next: PlayItem[];
  parked: PlayItem[];
}

/** Whether the thread is the user's move. */
export function isUsersMove(thread: ProjectOpenThread): boolean {
  return thread.owner?.kind === 'user' || thread.waitingOn?.kind === 'decision';
}

/**
 * Which open thread a worker is carrying: the one it was dispatched onto, else
 * the latest that names it, as one of its workers or as its owner.
 */
export function threadOfWorker(worker: Pick<WorkerCardState, 'worker' | 'thread'>, open: readonly ProjectOpenThread[]): number | null {
  if (worker.thread !== null && open.some((thread) => thread.seq === worker.thread)) return worker.thread;
  const naming = open.filter((thread) => thread.workers.includes(worker.worker)
    || (thread.owner?.kind === 'worker' && thread.owner.worker === worker.worker));
  return naming.length > 0 ? naming[naming.length - 1].seq : null;
}

function heldOn(thread: ProjectOpenThread): string | null {
  if (thread.waitingOn && thread.waitingOn.kind !== 'decision') return thread.waitingOn.text;
  if (thread.owner?.kind === 'external') return thread.owner.who;
  return null;
}

export function deriveStateOfPlay(project: ProjectState, workers: readonly WorkerCardState[]): StateOfPlay {
  const open = project.open.filter((thread) => !thread.parked);
  const live = workers.filter((worker) => !worker.archived);

  const onThread = new Map<number, WorkerCardState[]>();
  const loose: WorkerCardState[] = [];
  const parkedSeqs = new Set(project.open.filter((thread) => thread.parked).map((thread) => thread.seq));
  for (const worker of live) {
    // A worker on a parked thread went with it: dismissing a thread stops its workers.
    const seq = threadOfWorker(worker, project.open);
    if (seq !== null && parkedSeqs.has(seq)) continue;
    if (seq === null) loose.push(worker);
    else onThread.set(seq, [...(onThread.get(seq) ?? []), worker]);
  }

  const ranked = project.rank?.length ? project.rank : project.priority?.thread != null ? [project.priority.thread] : [];
  const position = (seq: number): number => {
    const at = ranked.indexOf(seq);
    return at === -1 ? ranked.length : at;
  };
  const inOrder = [...open].sort((a, b) => position(a.seq) - position(b.seq) || a.seq - b.seq);

  const play: StateOfPlay = { needsYou: [], inProgress: [], next: [], parked: [] };
  for (const thread of inOrder) {
    const item: PlayItem = {
      kind: 'thread',
      key: String(thread.seq),
      thread,
      label: thread.label ?? thread.text,
      workers: onThread.get(thread.seq) ?? [],
      heldOn: heldOn(thread),
    };
    if (isUsersMove(thread)) play.needsYou.push(item);
    else if (item.workers.length > 0 || item.heldOn) play.inProgress.push(item);
    else play.next.push(item);
  }
  for (const worker of loose) {
    play.inProgress.push({ kind: 'worker', key: worker.worker, thread: null, label: worker.task, workers: [worker], heldOn: null });
  }
  for (const thread of project.open.filter((candidate) => candidate.parked)) {
    play.parked.push({ kind: 'thread', key: String(thread.seq), thread, label: thread.label ?? thread.text, workers: [], heldOn: null });
  }
  return play;
}
