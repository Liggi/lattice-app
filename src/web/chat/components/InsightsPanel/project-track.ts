import { withoutThreadRefs, type ProjectOpenThread, type ProjectState } from '@/types/project-state';
import { threadOfWorker } from '@/types/state-of-play';
import type { WorkerCardState } from '@/types/worker-events';

export interface TrackStep {
  seq: number;
  label: string;
  state: 'done' | 'progress' | 'waiting' | 'todo';
  /** Short coordinator status shown on hover (e.g. "In review", "Live, retry unseen"). */
  detail?: string;
}

/** How many finished threads lead the chain; tightened when many open threads are active. */
const DONE_SHOWN = 3;
const DONE_SHOWN_BUSY = 2;

/**
 * A thread is in progress when a live worker carries it, or a worker owns it
 * and nothing holds it. A worker-owned thread that waits on something no live
 * worker is doing (a coordinator naming itself as owner, a dependency) is
 * waiting, not in progress.
 */
function isInProgress(thread: ProjectOpenThread, carried: ReadonlySet<number>, live: ReadonlySet<string>): boolean {
  if (carried.has(thread.seq)) return true;
  if (thread.owner?.kind !== 'worker') return false;
  if (thread.waitingOn === null) return true;
  return thread.waitingOn.kind === 'worker' && Boolean(thread.waitingOn.worker) && live.has(thread.waitingOn.worker!);
}

function isWaiting(thread: ProjectOpenThread): boolean {
  return thread.waitingOn !== null || thread.owner?.kind === 'external';
}

/**
 * The project's threads as a step chain: recent closed threads, then active
 * work (threads carried by a live worker or owned by one), then threads held
 * on something outside (dependency, resource, decision, external owner), then
 * unstarted queued threads — always in monotonic done -> progress -> waiting
 * -> todo order so the chain never zigzags or presents shipped-but-waiting
 * work as unstarted.
 */
export function deriveTrack(project: ProjectState | null, workers: WorkerCardState[]): TrackStep[] {
  if (!project) return [];
  const named = (name: string | null) => (name ? withoutThreadRefs(name).trim() : '');

  const ranked = project.rank?.length ? project.rank : project.priority?.thread != null ? [project.priority.thread] : [];
  const rank = new Map(ranked.map((seq, index) => [seq, index]));
  const carried = new Set<number>();
  const live = new Set<string>();
  for (const worker of workers) {
    if (worker.archived) continue;
    live.add(worker.worker);
    const seq = threadOfWorker(worker, project.open);
    if (seq !== null) carried.add(seq);
  }

  const openNamed = project.open.filter((thread) => !thread.parked && named(thread.name));
  // A chain of nothing but finished work says nothing about where the project is.
  if (openNamed.length === 0) return [];

  const openOrder = (a: ProjectOpenThread, b: ProjectOpenThread) =>
    (rank.get(a.seq) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.seq) ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq;
  const toStep = (state: 'progress' | 'waiting' | 'todo') => (thread: ProjectOpenThread): TrackStep => ({
    seq: thread.seq,
    label: named(thread.name),
    state,
    detail: named(thread.label) || undefined,
  });

  const progress = openNamed
    .filter((thread) => isInProgress(thread, carried, live))
    .sort(openOrder)
    .map(toStep('progress'));
  const waiting = openNamed
    .filter((thread) => !isInProgress(thread, carried, live) && isWaiting(thread))
    .sort(openOrder)
    .map(toStep('waiting'));
  const todo = openNamed
    .filter((thread) => !isInProgress(thread, carried, live) && !isWaiting(thread))
    .sort(openOrder)
    .map(toStep('todo'));

  const openNames = new Set(openNamed.map((thread) => named(thread.name).toLowerCase()));
  const doneLimit = openNamed.length >= 4 ? DONE_SHOWN_BUSY : DONE_SHOWN;
  const done = project.closed
    .filter((thread) => {
      const label = named(thread.name);
      return Boolean(label) && !openNames.has(label.toLowerCase());
    })
    .sort((a, b) => (a.closedAt ?? a.updatedAt) - (b.closedAt ?? b.updatedAt))
    .slice(-doneLimit)
    .map((thread): TrackStep => ({ seq: thread.seq, label: named(thread.name), state: 'done' }));

  return [...done, ...progress, ...waiting, ...todo];
}
