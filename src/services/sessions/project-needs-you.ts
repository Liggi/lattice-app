/**
 * Whether a project needs the user now. Candidates are collected from the
 * project record deterministically: open threads the user owns or that wait
 * on a decision. Jev then scores each for "does the user need to act on this
 * now" and "has the user parked it on purpose"; a thread counts when
 * act × (1 − parked) is over the bar. The bar was set on 2026-09-26
 * from a table of real scores.
 *
 * The status poll only ever reads the cache. A thread without a current score
 * is scored in the background; when the score lands the project's status is
 * pushed as changed, so the client refetches it. A score stands until the
 * thread's `updatedAt` changes.
 *
 * The project's own open question card (`lattice ask`) is a candidate too,
 * scored the same way: the agent has stopped on a call it says only the user
 * can make. It stops counting once answered, replaced or settled by a
 * message (`types/decisions.ts`).
 *
 * A message from the user to the project answers every ask that was waiting
 * before it, whether or not the coordinator has updated its record yet
 * (2026-09-26: Needs you stayed lit on projects the user had answered and
 * that were working again). The composer's send records it as a `user:sent`
 * event in the coordinator's log, so it survives a restart.
 */

import { withoutThreadRefs, type ProjectOpenThread } from '../../types/project-state.js';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { getEventStorage } from '../../harness/event-message-reader.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { iterateEventsNewestFirst } from '../../session-history/repository.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { createLogger } from '../infrastructure/logger.js';
import { judgeNouls, type NoulQuestion } from '../infrastructure/typesafe-client.js';
import { SessionInfoService } from './session-info-service.js';
import { readProjectState } from './project-state.js';
import { foldedWorkerStates, workerOutputSince } from './worker-events.js';
import { userName } from '../user-profile.js';
import { noteStatusChanged } from './session-status-changes.js';
import { openDecision, type OpenDecision } from './open-decision.js';

const logger = createLogger('ProjectNeedsYou');

export const NEEDS_YOU_THRESHOLD = 0.55;
const JEV_TIMEOUT_MS = 15_000;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const MAX_IN_FLIGHT = 4;
const DAY_MS = 86_400_000;

export interface NeedsYouItem {
  seq: number;
  /** What it waits on, in the record's own words. */
  text: string;
  /** What the thread is for. */
  thread: string;
  /** When the thread started waiting on what it waits on now. */
  since: number;
  score: number;
}

interface ThreadScore {
  updatedAt: number;
  act: number;
  parked: number;
  score: number;
}

const scores = new Map<string, ThreadScore>();
const failedAt = new Map<string, number>();
/** Queued or running, so a second poll does not queue the same thread twice. */
const pending = new Set<string>();
let running = 0;
const queue: Array<() => Promise<void>> = [];
const snapshots = new Map<string, ProjectSnapshot>();
let loggedUnavailable = false;

/** Test seam: the caches are module-level. */
export function __resetNeedsYouForTests(): void {
  scores.clear();
  failedAt.clear();
  pending.clear();
  running = 0;
  queue.length = 0;
  snapshots.clear();
  loggedUnavailable = false;
}

export function isNeedsYouCandidate(thread: ProjectOpenThread): boolean {
  // A parked thread is kept, not asking for anything.
  if (thread.parked) return false;
  return thread.owner?.kind === 'user' || thread.waitingOn?.kind === 'decision';
}

function actQuestion(name: string): NoulQuestion {
  return {
    instructions: `${name} is the person these AI agents work for. Does ${name} need to act on \`thread\` now? Read what the thread is for, where it has got to, who owns it, what it is waiting on and the next action, and how long it has waited.`,
    criteria: {
      true: `Work is held up until ${name} himself acts, and nothing but his action is missing: a decision or choice only he can make, his go-ahead to merge, ship or build something already prepared, feedback or a test he was asked for.`,
      false: `${name} does not need to act now: someone or something else moves it next (a worker, another person, an event that has not happened yet), ${name} deliberately parked it for later, or it is an optional idea or a check that will happen on its own in normal use.`,
    },
  };
}

function parkedQuestion(name: string): NoulQuestion {
  return {
    instructions: `Has ${name} put \`thread\` off on purpose? Read the waiting-on text, the next action and where it has got to.`,
    criteria: {
      true: `${name} has deliberately parked or deferred it, or it is set to wait until something later happens (after a game, after fixes land, after another person answers, when he next uses a feature, when he says to resume).`,
      false: `Nothing says it was put off: it is ready for ${name}'s answer or go-ahead now.`,
    },
  };
}

function renderState(project: string, thread: ProjectOpenThread, now: number): string {
  return JSON.stringify({
    project,
    thread: {
      purpose: thread.text,
      where_it_has_got_to: thread.summary,
      owner: thread.owner?.kind ?? null,
      waiting_on: thread.waitingOn ?? null,
      next_action: thread.nextAction,
      days_since_last_update: Math.round(((now - thread.updatedAt) / DAY_MS) * 10) / 10,
    },
  });
}

/** The card as the thread-shaped state Jev reads for a thread. */
function renderCard(project: string, card: OpenDecision, now: number): string {
  return JSON.stringify({
    project,
    thread: {
      purpose: card.asked.question,
      where_it_has_got_to: `The agent stopped and put this question to ${userName()} on a card, with these options: ${card.asked.options
        .map((option) => option.consequence ? `${option.label} (${option.consequence})` : option.label).join('; ')}.`,
      owner: 'user',
      waiting_on: { kind: 'decision', text: card.asked.question },
      next_action: `${userName()} picks an option or answers in their own words.`,
      days_since_last_update: Math.round(((now - card.shownAt) / DAY_MS) * 10) / 10,
    },
  });
}

function projectName(coordinatorId: string): string {
  const info = SessionInfoService.getInstance().getSessionInfoSync(coordinatorId);
  return info?.custom_name?.trim() || info?.project_name?.trim() || coordinatorId;
}

function pump(): void {
  while (running < MAX_IN_FLIGHT && queue.length > 0) {
    running++;
    void queue.shift()!().finally(() => {
      running--;
      pump();
    });
  }
}

function scoreInBackground(coordinatorId: string, key: string, updatedAt: number, seq: number, render: (project: string, now: number) => string): void {
  if (pending.has(key)) return;
  const failed = failedAt.get(key);
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_FAILURE_MS) return;
  pending.add(key);
  queue.push(async () => {
    try {
      const name = userName();
      const { nouls } = await judgeNouls(
        render(projectName(coordinatorId), Date.now()),
        { act: actQuestion(name), parked: parkedQuestion(name) },
        { timeoutMs: JEV_TIMEOUT_MS, cost: { operation: 'NEEDS_YOU', sessionId: coordinatorId } },
      );
      const score = nouls.act * (1 - nouls.parked);
      scores.set(key, { updatedAt, act: nouls.act, parked: nouls.parked, score });
      failedAt.delete(key);
      noteStatusChanged(coordinatorId);
      logger.info('Scored a thread waiting on the user', { coordinatorId, seq, act: nouls.act, parked: nouls.parked, score });
    } catch (err) {
      failedAt.set(key, Date.now());
      const error = err instanceof Error ? err.message : String(err);
      if (!loggedUnavailable) logger.warn('Needs-you scoring unavailable', { coordinatorId, seq, error });
      loggedUnavailable = true;
    } finally {
      pending.delete(key);
    }
  });
  pump();
}

function isCoordinator(conversationId: string): boolean {
  const row = DatabaseProvider.getInstance().getDb()
    .prepare('SELECT coordinator FROM conversations WHERE conversation_id = ?')
    .get(conversationId) as { coordinator?: number } | undefined;
  return row?.coordinator === 1;
}

export const USER_SENT_EVENT = 'user:sent';

/** Record that the user has just sent this project a message; a no-op for a conversation that is not a project. */
export function noteUserSent(manager: SessionManager, conversationId: string): void {
  if (!isCoordinator(conversationId)) return;
  appendCustomHarnessEvent(manager, conversationId, USER_SENT_EVENT, {});
  noteStatusChanged(conversationId);
}

function lastUserSentAt(coordinatorId: string): number {
  for (const event of iterateEventsNewestFirst(coordinatorId, [USER_SENT_EVENT])) return event.timestamp;
  return 0;
}

interface ProjectSnapshot {
  seq: number;
  threads: ProjectOpenThread[];
  workingOn: string | null;
  workerTasks: Record<string, string>;
  /** Workers whose latest report said what they stopped to wait on, and when they reported. */
  reportedWaits: Array<{ worker: string; waitingOn: string; since: number }>;
  /** When the user last sent the project a message, epoch ms; 0 if never recorded. */
  userSentAt: number;
  /** The project's own question card, while it waits on the user. */
  card: OpenDecision | null;
}

function snapshot(coordinatorId: string): ProjectSnapshot {
  const seq = getEventStorage().maxSeq(coordinatorId);
  const cached = snapshots.get(coordinatorId);
  if (cached && cached.seq === seq) return cached;
  const state = readProjectState(coordinatorId);
  const focus = state.priority?.text ?? state.now;
  const workers = foldedWorkerStates(coordinatorId);
  const entry = {
    seq,
    threads: state.open.filter(isNeedsYouCandidate),
    workingOn: focus ? withoutThreadRefs(focus) || null : null,
    workerTasks: Object.fromEntries(workers.map(worker => [worker.worker, worker.task])),
    reportedWaits: workers.flatMap(worker => worker.phase === 'reported' && worker.waitingOn
      ? [{ worker: worker.worker, waitingOn: worker.waitingOn, since: worker.since }] : []),
    userSentAt: lastUserSentAt(coordinatorId),
    card: openDecision(coordinatorId),
  };
  snapshots.set(coordinatorId, entry);
  return entry;
}

/** The project's Working on line, as the right panel heads it; null when it has none or is not a project. */
export function projectWorkingOn(conversationId: string): string | null {
  return isCoordinator(conversationId) ? snapshot(conversationId).workingOn : null;
}

/** Each worker's task, the name its card in the right panel carries; null when not a project. */
export function projectWorkerTasks(conversationId: string): Record<string, string> | null {
  return isCoordinator(conversationId) ? snapshot(conversationId).workerTasks : null;
}

/**
 * What each worker declared it is waiting on, while it still is; null when not
 * a project. Read fresh each time: a worker that has output since its report
 * has resumed, and its own log does not move the coordinator's.
 */
export function projectWorkerWaits(conversationId: string): Record<string, string> | null {
  if (!isCoordinator(conversationId)) return null;
  return Object.fromEntries(snapshot(conversationId).reportedWaits
    .filter(wait => !workerOutputSince(wait.worker, wait.since))
    .map(wait => [wait.worker, wait.waitingOn]));
}

/**
 * The threads in this project over the bar, highest first; null when the
 * conversation is not a coordinator. Never waits on Jev.
 */
export function projectNeedsYou(conversationId: string): NeedsYouItem[] | null {
  if (!isCoordinator(conversationId)) return null;
  const items: NeedsYouItem[] = [];
  const { threads, userSentAt, card } = snapshot(conversationId);
  for (const thread of threads) {
    if (thread.waitingSince <= userSentAt) continue;
    const key = `${conversationId}:${thread.seq}`;
    const scored = scores.get(key);
    if (!scored || scored.updatedAt !== thread.updatedAt) {
      scoreInBackground(conversationId, key, thread.updatedAt, thread.seq, (project, now) => renderState(project, thread, now));
      continue;
    }
    if (scored.score > NEEDS_YOU_THRESHOLD) {
      items.push({
        seq: thread.seq,
        text: thread.waitingOn?.text || thread.nextAction || thread.text,
        thread: thread.text,
        since: thread.waitingSince,
        score: Math.round(scored.score * 100) / 100,
      });
    }
  }
  if (card && card.shownAt > userSentAt) {
    const key = `${conversationId}:card:${card.asked.id}`;
    const scored = scores.get(key);
    if (!scored) {
      scoreInBackground(conversationId, key, card.shownAt, card.seq, (project, now) => renderCard(project, card, now));
    } else if (scored.score > NEEDS_YOU_THRESHOLD) {
      items.push({
        seq: card.seq,
        text: card.asked.question,
        thread: card.asked.question,
        since: card.shownAt,
        score: Math.round(scored.score * 100) / 100,
      });
    }
  }
  return items.sort((a, b) => b.score - a.score);
}
