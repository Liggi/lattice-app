/**
 * The cross-project Inbox (`GET /api/inbox`, `types/inbox-feed.ts`): what is
 * waiting on the user, or has gone wrong, across every open session.
 *
 * - an open question card (`lattice ask`), until answered, dismissed or settled;
 * - a project thread that is the user's move ("Waiting on you"), unless a
 *   card already stands for it or the user has replied since it began
 *   waiting. A fresh one (under a day) or one holding up an active worker is
 *   priority; an older one stays in the list rather than vanishing;
 * - a session whose last run failed, or whose retry circuit is open
 *   (`retry-circuit-breaker.ts`);
 * - a running job that has stopped moving or whose count cannot be read;
 * - a pull request with failing checks, from the shipping watcher's last read
 *   only: the Inbox never waits on gh. A pull request two projects mention is
 *   listed once, under the first project read. One referenced only by parked
 *   or closed threads drops out of Priority so old PRs do not crowd active work.
 *
 * Everything here reads local state the server already keeps, so the feed
 * answers without network I/O.
 */

import type { InboxFeedResponse, InboxItem } from '../../types/inbox-feed.js';
import type { ProjectOpenThread, ProjectState } from '../../types/project-state.js';
import { waitWords, withoutThreadRefs } from '../../types/project-state.js';
import { isNeedsYou, threadOfWorker } from '../../types/state-of-play.js';
import type { WorkerState } from '../../types/worker-events.js';
import type { JobProgress } from './job-progress.js';
import { cannotRead, isIndeterminateJob, needsLook, quietSince } from '../../types/job-stall.js';
import type { RunFailure } from '../../harness/derive-session-status.js';
import type { ProjectShipping } from './project-shipping.js';
import type { OpenDecision } from './open-decision.js';
import { alertSignature } from './inbox-dismissals.js';
import { createLogger } from '../infrastructure/logger.js';

const logger = createLogger('InboxFeed');

const DAY_MS = 24 * 60 * 60_000;

export interface InboxConversation {
  conversationId: string;
  /** The session's own name. */
  title: string;
  /** The coordinator it was picked up from, when it is a worker. */
  pickedUpFrom: string | null;
  coordinator: boolean;
}

/** Where the feed reads from; `readInboxSources` wires the server's own. */
export interface InboxSources {
  now: number;
  /** The open (non-archived) conversations. */
  conversations: InboxConversation[];
  openDecision(conversationId: string): OpenDecision | null;
  /** A coordinator's project record. */
  project(conversationId: string): ProjectState | null;
  /** A coordinator's workers. */
  workers(conversationId: string): WorkerState[];
  /** When the user last replied about each thread (`t:<seq>`) and card (`d:<id>`). */
  repliedAt(conversationId: string): ReadonlyMap<string, number>;
  failure(conversationId: string): RunFailure | null;
  /** Jobs still running. */
  runningJobs(): JobProgress[];
  /** A coordinator's last shipping read, without starting one. */
  shipping(conversationId: string): ProjectShipping | null;
  /** Optional fallback context excerpt from the asking turn when a legacy card carries none. */
  decisionContext?(conversationId: string, decisionSeq: number): string | null;
  /** Optional filter for locally dismissed alert items (`failing-pr`, `failed-run`, `stalled-job`). */
  isDismissed?(itemId: string, signature: string): boolean;
}

/** A worker is actively held up on a thread unless it already reported and stayed idle. */
function isActiveWorker(worker: Pick<WorkerState, 'phase' | 'workedSinceReport'>): boolean {
  return worker.phase !== 'reported' || Boolean(worker.workedSinceReport);
}

export function buildInboxFeed(sources: InboxSources): InboxFeedResponse {
  const { now, conversations } = sources;
  const byId = new Map(conversations.map((conversation) => [conversation.conversationId, conversation]));
  const projectTitle = (conversation: InboxConversation): string => {
    const coordinator = conversation.pickedUpFrom ? byId.get(conversation.pickedUpFrom) : null;
    return coordinator?.title ?? conversation.title;
  };
  const href = (conversationId: string) => `/c/${conversationId}`;
  const items: InboxItem[] = [];
  const listedPulls = new Set<string>();
  const live = new Set(conversations.map((candidate) => candidate.conversationId));
  const projects = new Map<string, ProjectState | null>();
  const projectOf = (conversationId: string) => {
    if (!projects.has(conversationId)) projects.set(conversationId, safely(() => sources.project(conversationId), null));
    return projects.get(conversationId) ?? null;
  };

  for (const conversation of conversations) {
    const { conversationId } = conversation;
    const base = { conversationId, projectTitle: projectTitle(conversation), href: href(conversationId) };
    const project = conversation.coordinator ? projectOf(conversationId) : null;
    const open = project?.open ?? [];
    const carrying = new Map<number, number>();
    if (project) {
      for (const worker of safely(() => sources.workers(conversationId), [] as WorkerState[])) {
        if (!live.has(worker.worker) || !isActiveWorker(worker)) continue;
        const seq = threadOfWorker(worker, open);
        if (seq !== null) carrying.set(seq, (carrying.get(seq) ?? 0) + 1);
      }
    }

    // 1. The open question card.
    const decision = safely(() => sources.openDecision(conversationId), null);
    const cardThread = decision?.asked.thread;
    if (decision) {
      const thread = cardThread !== undefined ? open.find((candidate) => candidate.seq === cardThread) : undefined;
      const holdingWorkers = thread ? (carrying.get(thread.seq) ?? 0) : 0;
      const holdingReason = holdingWorkers > 0 ? `Holding up ${holdingWorkers === 1 ? 'a worker' : `${holdingWorkers} workers`}` : null;
      const hasContext = Boolean(decision.asked.context?.length || decision.asked.detail?.trim());
      const fallbackDetail = !hasContext
        ? (thread?.summary ? withoutThreadRefs(thread.summary) : null)
          ?? (thread?.ask ? withoutThreadRefs(thread.ask) : null)
          ?? safely(() => sources.decisionContext?.(conversationId, decision.seq) ?? null, null)
        : null;
      items.push({
        ...base,
        id: `decision:${conversationId}:${decision.asked.id}`,
        kind: 'decision',
        ...(decision.asked.requestKind ? { requestKind: decision.asked.requestKind } : {}),
        glyph: 'decision',
        priority: now - decision.shownAt < DAY_MS || holdingWorkers > 0,
        ...(decision.asked.priorityReason
          ? { priorityReason: decision.asked.priorityReason }
          : holdingReason
            ? { priorityReason: holdingReason }
            : {}),
        title: (thread && threadName(thread)) || decision.asked.question,
        reason: holdingReason ?? 'Asks you to decide',
        detail: decision.asked.detail ?? fallbackDetail,
        ...(decision.asked.context?.length ? { context: decision.asked.context } : {}),
        ...(decision.asked.metrics?.length ? { metrics: decision.asked.metrics } : {}),
        ...(decision.asked.artifact ? { artifact: decision.asked.artifact } : {}),
        ...(decision.asked.ifUnanswered ? { ifUnanswered: decision.asked.ifUnanswered } : {}),
        since: decision.shownAt,
        action: {
          kind: 'decision',
          decisionId: decision.asked.id,
          question: decision.asked.question,
          options: decision.asked.options.map((option) => ({
            label: option.label,
            ...(option.consequence ? { description: option.consequence } : {}),
            ...(option.recommended ? { recommended: true } : {}),
          })),
          ...(cardThread !== undefined ? { threadSeq: cardThread } : {}),
          ...(thread && !thread.parked ? { canPark: true } : {}),
        },
      });
    }

    // 2. Threads that are the user's move.
    if (project) {
      const replied = safely(() => sources.repliedAt(conversationId), new Map<string, number>());
      for (const thread of open) {
        if (!isNeedsYou(thread) || thread.seq === cardThread) continue;
        const since = thread.waitingSince ?? thread.updatedAt;
        // Answered since it began waiting: done with until a new ask.
        if ((replied.get(`t:${thread.seq}`) ?? 0) >= since) continue;
        const workers = carrying.get(thread.seq) ?? 0;
        const question = threadAsk(thread, open) ?? threadName(thread) ?? 'Waiting on you';
        const holdingReason = workers > 0 ? `Holding up ${workers === 1 ? 'a worker' : `${workers} workers`}` : null;
        items.push({
          ...base,
          id: `call:${conversationId}:${thread.seq}`,
          kind: 'call',
          glyph: 'decision',
          priority: now - since < DAY_MS || workers > 0,
          ...(holdingReason ? { priorityReason: holdingReason } : {}),
          title: threadName(thread) || question,
          reason: holdingReason ?? 'Waiting on you',
          detail: thread.summary ? withoutThreadRefs(thread.summary) : null,
          since,
          action: { kind: 'thread', threadSeq: thread.seq, question, askText: thread.ask ?? null, canPark: true, canDismiss: true },
        });
      }
    }

    // 3. A failed run, or one that stopped retrying.
    const failure = safely(() => sources.failure(conversationId), null);
    if (failure) {
      items.push({
        ...base,
        id: `failed-run:${conversationId}`,
        kind: 'failed-run',
        glyph: 'failed',
        priority: true,
        title: conversation.title,
        reason: failure.circuitBroken ? 'Stopped retrying after repeated failures' : 'Its last run failed',
        detail: failure.message,
        since: failure.at,
        action: { kind: 'retry', errorMessage: failure.message, ...(failure.circuitBroken ? { circuitBroken: true } : {}) },
      });
    }

    // 5. Pull requests with failing checks, from the last read only.
    if (conversation.coordinator) {
      const shipping = safely(() => sources.shipping(conversationId), null);
      for (const item of shipping?.items ?? []) {
        if (item.stage !== 'checks-failing' || listedPulls.has(item.key)) continue;
        listedPulls.add(item.key);
        const pr = pullRef(item.key, item.failedChecks);
        const parkedOnly = pr ? isPrOnlyOnInactiveThreads(project, pr.number) : false;
        items.push({
          ...base,
          id: `failing-pr:${conversationId}:${item.key}`,
          kind: 'failing-pr',
          glyph: 'failed',
          priority: !parkedOnly,
          title: item.title,
          reason: item.stageLabel,
          since: item.at ?? now,
          href: item.href ?? base.href,
          ...(pr ? { pr } : {}),
          action: { kind: 'open', label: 'Open PR' },
        });
      }
    }
  }

  // 4. Running jobs that need a look, under the session that started them.
  for (const job of safely(() => sources.runningJobs(), [] as JobProgress[])) {
    const conversation = byId.get(job.session);
    if (!conversation || !needsLook(job, now)) continue;
    const unreadable = cannotRead(job);
    const silent = unreadable === null && isIndeterminateJob(job);
    items.push({
      conversationId: job.session,
      projectTitle: projectTitle(conversation),
      href: href(conversation.pickedUpFrom ?? job.session),
      id: `stalled-job:${job.session}:${job.label}`,
      kind: 'stalled-job',
      glyph: 'stalled',
      priority: true,
      title: job.label,
      reason: unreadable ? "Can't read its count" : silent ? 'No output' : 'Stopped moving',
      detail: unreadable ?? (silent ? `Has produced no output for ${Math.max(1, Math.round((now - quietSince(job)) / 60_000))} min` : `${job.done} of ${job.total}`),
      since: unreadable ? job.readError?.since ?? job.movedAt : quietSince(job),
    });
  }

  const visible = sources.isDismissed
    ? items.filter((item) => {
      const sig = alertSignature(item);
      return !sig || !sources.isDismissed!(item.id, sig);
    })
    : items;

  visible.sort((a, b) => Number(b.priority) - Number(a.priority) || b.since - a.since);
  return {
    items: visible,
    priorityCount: visible.filter((item) => item.priority).length,
    totalCount: visible.length,
    generatedAt: now,
  };
}

/** True when a PR number appears only on parked or closed threads, never on an active open thread. */
function isPrOnlyOnInactiveThreads(project: ProjectState | null, prNumber: number): boolean {
  if (!project) return false;
  const pattern = new RegExp(`(?:#|\\bPR\\s+|pull\\/)${prNumber}\\b`, 'i');
  const threadMentions = (thread: Pick<ProjectOpenThread, 'text' | 'name' | 'label' | 'summary' | 'nextAction' | 'evidence'> | ProjectState['closed'][number]): boolean => {
    const parts: string[] = [thread.text, thread.name ?? '', ...(thread.evidence ?? [])];
    if ('label' in thread && thread.label) parts.push(thread.label);
    if ('summary' in thread && thread.summary) parts.push(thread.summary);
    if ('nextAction' in thread && thread.nextAction) parts.push(thread.nextAction);
    return parts.some((part) => pattern.test(part));
  };
  const open = project.open ?? [];
  const closed = project.closed ?? [];
  if (open.some((thread) => !thread.parked && threadMentions(thread))) return false;
  return open.some((thread) => Boolean(thread.parked) && threadMentions(thread))
    || closed.some((thread) => threadMentions(thread));
}

/** "owner/repo#12" as the Inbox names a pull request; a key of another shape gives none. */
function pullRef(key: string, failedChecks: string[] | undefined): InboxItem['pr'] | null {
  const match = /^[^/#]+\/([^/#]+)#(\d+)$/.exec(key);
  return match ? { repo: match[1], number: Number(match[2]), failedChecks: failedChecks ?? [] } : null;
}

function threadName(thread: ProjectOpenThread): string | null {
  const name = thread.name ? withoutThreadRefs(thread.name).trim() : '';
  return name || null;
}

/** The thread's ask: its label, else what the decision waits on, else its next step (as Your calls words it). */
function threadAsk(thread: ProjectOpenThread, open: readonly ProjectOpenThread[]): string | null {
  const ask = thread.label
    ?? (thread.waitingOn?.kind === 'decision' ? `Waiting on ${waitWords(thread.waitingOn, open)}` : null)
    ?? thread.nextAction;
  return ask ? withoutThreadRefs(ask) : null;
}

/** One session's unreadable record leaves its items out, logged, rather than failing the whole feed. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    logger.warn('Inbox could not read part of a session', { error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}
