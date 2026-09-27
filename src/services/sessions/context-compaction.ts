/**
 * Context compaction policy.
 *
 * Nobody types `/compact`. When a session's context passes the threshold the
 * server compacts it at the next turn end, the same way the composer's
 * compact control does (Claude: the CLI's `/compact`; Codex: thread compaction).
 * That applies to coordinators and workers alike; the coordinator does not
 * manage anyone's context, it just sees the sizes.
 *
 * A coordinator's standing preamble lives in its first user message, and a
 * compaction summary keeps what was being done rather than how to do it, so
 * after a coordinator compacts the next input carries the preamble again
 * plus the state of its workers, read from the worker events in its own log
 * (the durable record; see `worker-events.ts`). The block is bounded by
 * markers the thread strips, so the user's message still reads as theirs.
 *
 * Why 200K: it is a quality threshold, not a
 * window limit — a Codex coordinator was compacted by hand at 93K and 134K
 * because it had degraded, and each compaction cost two to three minutes.
 * Claude Code compacts on its own near its window (observed at ~167K on a
 * 200K model), so this mostly reaches Codex sessions and large-window Claude
 * models.
 */

import { createLogger } from '../infrastructure/logger.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { getEvents, iterateEventsNewestFirst } from '../../session-history/repository.js';
import type { RawEvent } from '../../session-history/types.js';
import { contextTokensNewestFirst, type UsageEventLike } from '../../session-history/context-tokens.js';
import { ConversationService } from './conversation-service.js';
import { buildCoordinatorPreamble, buildWorkerPreamble, latticeCli } from './pickup-prompts.js';
import { installedProviders } from './installed-providers.js';
import { tryAdmitTurn } from './turn-admission.js';
import { unfinishedSwitch } from './coordinator-switch-state.js';
import { foldProjectState, type ProjectOpenThread } from '../../types/project-state.js';

import {
  CONTEXT_RESTORE_END,
  CONTEXT_RESTORE_PREFIX,
  foldWorkerStates,
  stripWorkerQuestionMarker,
  type WorkerEventLike,
  type WorkerReportedData,
  type WorkerState,
} from '../../types/worker-events.js';
import { markWorkedSinceReport, readWorkerStates } from './worker-events.js';
import { userName } from '../user-profile.js';

const logger = createLogger('ContextCompaction');

const DEFAULT_THRESHOLD_TOKENS = 200_000;
/** A failed or ignored attempt is not retried at every turn end. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

export function autoCompactThresholdTokens(): number {
  const raw = Number(process.env.LATTICE_AUTO_COMPACT_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD_TOKENS;
}

/** Context size of a conversation from its stored events; null when unknown. */
export function conversationContextTokens(conversationId: string): number | null {
  const provider = ConversationService.getInstance().getConversation(conversationId)?.latestProvider ?? null;
  return contextTokensNewestFirst(iterateEventsNewestFirst(conversationId, ['turn:end', 'content']), provider);
}

const lastAttemptAt = new Map<string, number>();

/**
 * Called at every turn end. Starts a compaction when the session is idle,
 * alive and over the threshold. Returns true when one was started, so the
 * caller can leave worker deliveries for the turn end the compaction
 * produces. Never rejects.
 *
 * A compaction is a turn, so it takes the session's turn admission
 * (turn-admission.ts) — and only if nobody holds it. A send that is
 * cancelling the current turn, or a drain already composing its batch, owns
 * the boundary; compacting under them would open a turn they are about to
 * write into. Deferred, not queued: the next turn end asks again.
 */
export async function maybeAutoCompact(sessionId: string): Promise<boolean> {
  const manager = getHarnessSessionManager();
  const diagnostics = manager?.inspect(sessionId);
  if (!manager || !diagnostics?.processAlive || diagnostics.status !== 'idle') return false;
  if (stoppedSinceLastInput(sessionId)) return false;

  const tokens = conversationContextTokens(sessionId);
  const threshold = autoCompactThresholdTokens();
  if (tokens === null || tokens < threshold) return false;

  const last = lastAttemptAt.get(sessionId) ?? 0;
  if (Date.now() - last < RETRY_AFTER_MS) return false;

  const admission = tryAdmitTurn(sessionId, 'auto-compact');
  if (!admission) {
    logger.info('Context over threshold; compaction deferred behind the turn admission holder', { sessionId, tokens });
    return false;
  }
  try {
    // Re-read under the admission: the holder before us may have opened a turn.
    if (manager.inspect(sessionId)?.status !== 'idle') return false;
    // Not while a coordinator switch is unfinished: which provider this would
    // compact is what is in doubt, and `switch` is what resolves it.
    if (unfinishedSwitch(sessionId, ConversationService.getInstance())) {
      logger.info('Context over threshold; compaction held while a coordinator switch is unfinished', { sessionId, tokens });
      return false;
    }
    lastAttemptAt.set(sessionId, Date.now());
    logger.info('Context over threshold; compacting', { sessionId, tokens, threshold });
    await manager.compact(sessionId);
    return true;
  } catch (err) {
    logger.warn('Auto-compaction did not start', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    admission.release();
  }
}

/**
 * Whether the turn that just ended was stopped. A Stop escalates to SIGTERM
 * after three seconds whether or not the turn has ended, so its process may
 * be dying while it still reads alive; a `/compact` written then is lost with
 * it (conv-l7QfLDca1s0J, 2026-09-26 10:52). The next turn end compacts instead.
 */
function stoppedSinceLastInput(sessionId: string): boolean {
  for (const event of iterateEventsNewestFirst(sessionId, ['stop:requested', 'input:sent', 'run:start'])) {
    return event.type === 'stop:requested';
  }
  return false;
}

/** True when a compaction boundary is the newest thing since the last real input. */
export function compactedSinceLastInput(events: readonly UsageEventLike[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'input:sent') {
      if ((event.data as { source?: string }).source === 'command') continue;
      return false;
    }
    if (event.type === 'turn:end' && (event.data as { compact?: boolean }).compact) return true;
  }
  return false;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
}

function describeWorker(state: WorkerState, lastReport: string | null, cli: string): string {
  const who = [state.worker, state.provider, state.model, state.thread !== null ? `thread [${state.thread}]` : null]
    .filter(Boolean).join(' · ');
  const read = `full text: \`${cli} session transcript ${state.worker} --last 2\``;
  let status: string;
  if (state.phase === 'asked' && state.question) {
    status = `waiting on your answer since ${formatTime(state.since)}: "${firstLine(stripWorkerQuestionMarker(state.question))}" (${read})`;
  } else if (state.phase === 'reported' && state.workedSinceReport) {
    status = `reported at ${formatTime(state.since)}, then carried on working with no report since (${read})`;
  } else if (state.phase === 'reported' && state.waitingOn) {
    status = `reported at ${formatTime(state.since)} and waiting on ${state.waitingOn} (${read})`;
  } else if (state.phase === 'reported') {
    status = `reported at ${formatTime(state.since)}: "${firstLine(lastReport ?? '')}" (${read})`;
  } else {
    status = `working since ${formatTime(state.since)}`;
  }
  return `- ${who} — ${state.task}\n  ${status}`;
}

/**
 * The coordinator's workers as text, from its own log: who, the task, and
 * where each stands. Read by the restore block.
 */
export function renderWorkerRoster(events: readonly WorkerEventLike[], cli: string): string {
  const lastReports = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'worker:reported') continue;
    const data = event.data as WorkerReportedData;
    if (data?.worker) lastReports.set(data.worker, data.text);
  }
  const workers = markWorkedSinceReport(foldWorkerStates(events));
  if (workers.length === 0) return 'You have not dispatched any workers in this conversation.';
  return ['Your workers, from the server\'s record of this conversation (dispatch order):',
    ...workers.map((state) => describeWorker(state, lastReports.get(state.worker) ?? null, cli)),
  ].join('\n');
}

/**
 * The block to put in front of a coordinator's next input after it compacts:
 * its preamble, worker roster and the project state it noted (see
 * `types/project-state.ts`). Empty when the conversation has not compacted
 * since its last input.
 */
function buildCoordinatorRestoreBlock(
  conversationId: string,
  workingDirectory: string,
  events: readonly RawEvent[],
  opening: readonly string[] = [
    `${CONTEXT_RESTORE_PREFIX} Your context was just compacted, so what follows is your standing preamble and the state of your`,
    'workers, taken from the server\'s records rather than from the summary. The project record follows it. The message',
    'after the end marker is the one to act on.]',
  ],
  end: string = CONTEXT_RESTORE_END,
): string {
  const cli = latticeCli();
  const preamble = buildCoordinatorPreamble({ conversationId, workingDirectory, cli, installedProviders: installedProviders() });
  const roster = renderWorkerRoster(events, cli);

  // The project state is not here. It follows in its own block, written by
  // `project-orientation.ts`, which the compaction is one of the reasons for
  // — so it arrives once, in the same words, on the compacted turn and on
  // every other turn where the record has moved.
  return [
    ...opening,
    '',
    preamble.trimEnd(),
    '',
    roster,
    '',
    end,
    '',
  ].join('\n');
}


/**
 * The same for a worker, which used to get nothing at all: six worker
 * sessions had compacted with no restore block, so what carried a worker's
 * parent id and its brief across a compaction was the provider's own summary
 * — whether the protocol survived was luck. It gets back who dispatched it, the piece of work it
 * is on, the decisions that bind it, and where its colleagues' findings are;
 * not the whole project, which the pointers reach.
 */
function buildWorkerRestoreBlock(conversationId: string, conversation: {
  workingDirectory: string;
  pickedUpFrom: string;
  latestProvider: string | null;
}): string {
  const cli = latticeCli();
  const parent = conversation.pickedUpFrom;
  const parentConversation = ConversationService.getInstance().getConversation(parent);
  const parentEvents = getEvents(parent);
  const state = foldProjectState(parentEvents);
  const card = readWorkerStates(parent).find((worker) => worker.worker === conversationId) ?? null;
  const thread = card?.thread !== null && card?.thread !== undefined
    ? [...state.open, ...state.closed].find((candidate) => candidate.seq === card.thread) ?? null
    : null;

  const lines: string[] = [
    `${CONTEXT_RESTORE_PREFIX} Your context was just compacted. What follows is the server's record of who you are working for and`,
    'on what, rather than the summary\'s account of it. The message after the end marker is the one to act on.]',
    '',
    buildWorkerPreamble({
      conversationId,
      parentConversationId: parent,
      parentProvider: parentConversation?.latestProvider ?? null,
      parentModel: ConversationService.getInstance().getLatestSegment(parent)?.model ?? null,
      workingDirectory: conversation.workingDirectory,
      cli,
      thread: thread ? { seq: thread.seq, text: thread.text } : null,
    }).replace(/\n+---\s*$/, '').trimEnd(),
    '',
    card ? `What front dispatched you to do: ${card.task}` : 'Front\'s record of your dispatch is not in its log.',
  ];

  if (thread) lines.push('', ...renderThreadForWorker(thread, cli, parent));
  if (state.outcome) lines.push('', `What this project is for: ${state.outcome}`);
  if (state.decisions.length > 0) {
    lines.push('', 'Decisions that bind your work:');
    for (const decision of state.decisions) {
      lines.push(`- ${decision.text}${decision.by === 'user' ? ` (${userName()}'s call)` : ''}`);
    }
  }
  const siblings = renderSiblingReports(parentEvents, conversationId, thread, cli, parent);
  if (siblings.length > 0) lines.push('', ...siblings);

  lines.push('', CONTEXT_RESTORE_END, '');
  return lines.join('\n');
}

function renderThreadForWorker(thread: ProjectOpenThread, cli: string, parent: string): string[] {
  const lines = [`Your thread, as front has it: [${thread.seq}] ${thread.text}`];
  if (thread.nextAction) lines.push(`  next: ${thread.nextAction}`);
  if (thread.waitingOn) lines.push(`  waiting on ${thread.waitingOn.kind}: ${thread.waitingOn.text}`);
  if (thread.closedAt !== undefined) lines.push(`  front has closed it${thread.resolution ? `: ${thread.resolution}` : ''} — check with it before carrying on.`);
  if (thread.workers.length > 1) lines.push(`  also on it: ${thread.workers.join(', ')}`);
  lines.push(`  front's current record: \`${cli} session state ${parent}\``);
  return lines;
}

/**
 * What the project's other workers have already reported, by seq, so a
 * successor can read the finding itself rather than have front retell it.
 * The reports on this worker's own thread first; then the most recent few
 * from elsewhere, because a report is evidence whichever thread produced it.
 */
function renderSiblingReports(
  parentEvents: readonly RawEvent[],
  self: string,
  thread: ProjectOpenThread | null,
  cli: string,
  parent: string,
): string[] {
  const onThread = new Set(thread?.events.map((event) => event.seq) ?? []);
  const reports: Array<{ seq: number; worker: string; firstLine: string; own: boolean }> = [];
  for (const event of parentEvents) {
    if (event.type !== 'worker:reported') continue;
    const data = event.data as WorkerReportedData & { worker?: string };
    if (!data?.worker || data.worker === self) continue;
    reports.push({ seq: event.seq, worker: data.worker, firstLine: firstLine(data.text ?? ''), own: onThread.has(event.seq) });
  }
  if (reports.length === 0) return [];
  const chosen = [...reports.filter((report) => report.own), ...reports.filter((report) => !report.own).slice(-3)];
  return [
    'What your colleagues have reported (read one in full with `' + cli + ' session event ' + parent + ' <seq>`):',
    ...chosen.map((report) => `- [${report.seq}] ${report.worker}${report.own ? ' (your thread)' : ''}: ${report.firstLine}`),
  ];
}

/**
 * The coordinator's preamble and worker roster for a model taking the
 * conversation over from another provider, which holds none of it: the same
 * block a compaction restores, under the caller's opening lines.
 */
export function buildCoordinatorTakeoverBlock(conversationId: string, opening: readonly string[], end: string): string {
  const conversation = ConversationService.getInstance().getConversation(conversationId);
  if (!conversation?.coordinator) return '';
  return buildCoordinatorRestoreBlock(conversationId, conversation.workingDirectory, getEvents(conversationId), opening, end);
}

/**
 * The block to put in front of a conversation's next input after it
 * compacted: a coordinator gets its preamble, roster and project state; a
 * worker gets its parent, its assignment and where the shared record is.
 * Empty for anything else, or when nothing compacted since the last input.
 */
export function buildCoordinatorRestore(conversationId: string): string {
  const conversation = ConversationService.getInstance().getConversation(conversationId);
  if (!conversation) return '';
  const events = getEvents(conversationId);
  if (!compactedSinceLastInput(events)) return '';

  if (conversation.coordinator) {
    return buildCoordinatorRestoreBlock(conversationId, conversation.workingDirectory, events);
  }
  // Only a coordinator's worker: the block names front, its thread and its
  // project record, none of which exists for an ordinary pickup, and telling
  // one to run `session state` on a parent that is not a coordinator sends it
  // at a route that refuses it.
  if (conversation.pickedUpFrom
    && ConversationService.getInstance().getConversation(conversation.pickedUpFrom)?.coordinator) {
    return buildWorkerRestoreBlock(conversationId, {
      workingDirectory: conversation.workingDirectory,
      pickedUpFrom: conversation.pickedUpFrom,
      latestProvider: conversation.latestProvider,
    });
  }
  return '';
}
