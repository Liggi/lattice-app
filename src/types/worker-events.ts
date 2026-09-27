/**
 * Worker events — what a coordinator's transcript records about the workers
 * it dispatched. The server writes these into the coordinator's own event
 * log (see `appendCustomHarnessEvent`); nothing here is model output.
 *
 * A worker is one persistent object (a card in the coordinator's right
 * panel). The thread only logs its events: started, reported, and the
 * coordinator's messages to it. A question the worker asks is not a thread
 * item at all — the card shows it while it is open, and once the coordinator
 * answers, one quiet line carries the substance of the answer. A question
 * the coordinator decides is the user's never appears raw: the coordinator asks
 * in its own words (2026-09-19 flow agreement).
 *
 * Shared by the server (writer, `/workers` endpoint) and the web client
 * (thread rendering, Workers panel), so this module has no dependencies.
 */

import type { ProjectState } from './project-state.js';
import type { UnreadInboxSummary } from './inbox.js';

export const WORKER_EVENT_TYPES = [
  'worker:started',
  'worker:reassigned',
  'worker:asked',
  'worker:answered',
  'worker:reported',
  'worker:moved',
] as const;
export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

export function isWorkerEventType(type: string): type is WorkerEventType {
  return (WORKER_EVENT_TYPES as readonly string[]).includes(type);
}

export interface WorkerStartedData {
  worker: string;
  provider: string;
  model: string | null;
  /** One line saying what the worker is to find out or do. */
  task: string;
  /**
   * The open thread this worker was dispatched onto (`session new --thread`),
   * which is the seq of its `open` note. What the worker then reports or asks
   * is attributed to that thread, so closing it accounts for those events.
   */
  thread?: number;
  /**
   * Set when the worker was not dispatched here but moved in from another
   * project (`session move-worker`). It carries where the worker stood there,
   * so its card opens on that rather than on a fresh Working.
   */
  movedFrom?: { coordinator: string; project: string | null; phase: WorkerPhase };
}

/**
 * The worker left this project for another one (`session move-worker`).
 * Written in the log of the project it left. The worker's card goes, the way
 * an archived one does, and so does anything it reported here that nobody had
 * accounted for: that was copied to the new project, which answers for it now.
 */
export interface WorkerMovedData {
  worker: string;
  /** The coordinator it now reports to. */
  to: string;
  /** That project's name when it moved, for the thread line; null when it had none. */
  project: string | null;
  task: string;
}

/**
 * The coordinator gave a worker it is reusing a different assignment.
 *
 * A worker is named by the task it was dispatched on, and a coordinator that
 * sends an idle worker to do something else leaves that name describing work
 * that finished, which left reused workers under their old assignment name
 * and confused the project view. This is the coordinator
 * saying what the worker is on now, declared on the send (`--task`) rather
 * than guessed from the message, so an ordinary follow-up on the same task
 * says nothing and keeps the name it has.
 *
 * It renames; it does not redispatch. The `worker:started` that opened the
 * worker stays in the log exactly as written, and so does every report and
 * answer under the old name — the history is what those events are for. The
 * lifecycle is untouched too: `phase`, the open question and `startedAt` all
 * belong to events that actually moved them, and a rename that quietly
 * discharged a question the worker is still waiting on would be the same
 * loophole `--answers` exists to close.
 */
export interface WorkerReassignedData {
  worker: string;
  /** One line for what the worker is to find out or do now. */
  task: string;
  /** What it was called until this event, so the history row can read as a change. */
  previousTask: string;
}

/** The worker's turn ended on a question for the coordinator. */
export interface WorkerAskedData {
  worker: string;
  /** The question: the worker's final message of the turn, marker included. */
  text: string;
  /** Set on a copy carried over by a move; see `WorkerReportedData.movedFrom`. */
  movedFrom?: MovedEventOrigin;
  /** The thread it counts against here, when a move carried it with its thread. */
  thread?: number;
}

/**
 * Where a report or question copied in by a move was first written. The
 * original stays in the other project's log; this is the same text, owed a
 * disposition here instead.
 */
export interface MovedEventOrigin {
  coordinator: string;
  project: string | null;
  seq: number;
}

/** The coordinator sent the worker a message (`lattice session send --from <coordinator>`). */
export interface WorkerAnsweredData {
  worker: string;
  text: string;
  /** One line the coordinator gave for the thread; null when it gave none. */
  summary: string | null;
  /** The worker's open question at the time, so the exchange can be read as a pair; null when there was none. */
  question: string | null;
  /** The coordinator declared (`--passed-on`) that this is the user's decision relayed, not its own. */
  passedOn: boolean;
  /**
   * The seq of the worker's question this message answers (`--answers`),
   * which is what discharges it. Absent on an ordinary message: a
   * coordinator also sends resource updates, corrections and pauses, and
   * treating any of those as the answer would let a pending question be
   * closed by saying anything at all.
   */
  answers?: number;
}

/**
 * The worker's turn ended with a report (anything that is not a question).
 * `text` is the worker's final message of the turn — the reply it ended on,
 * not the progress lines it wrote between tool calls. Events written before
 * 2026-09-20 hold the whole turn instead, progress lines first.
 */
export interface WorkerReportedData {
  worker: string;
  model: string | null;
  text: string;
  /** Set on a copy carried over by a move, still owed a disposition when it moved. */
  movedFrom?: MovedEventOrigin;
  /** The thread it counts against here, when a move carried it with its thread. */
  thread?: number;
}

/**
 * A short, readable account of a report, written for the user and shown at the
 * top of the report card with the report itself underneath it.
 *
 * Its own event type rather than a field on `WorkerReportedData`, because the
 * report has to reach the coordinator the moment it arrives and this is a
 * model call that happens afterwards. The log is append-only, so the summary
 * lands later and the card picks it up by `reportSeq`. A card with no summary
 * event shows the report as stored, which is what every report written before
 * 2026-09-21 does and what a closed `generation.workerReportSummary` leaves.
 *
 * Deliberately outside `WORKER_EVENT_TYPES`: it is not a move the coordinator
 * made, it does not belong in the history list or the phase fold, and it must
 * not become its own thread item.
 *
 * It is never delivered to the coordinator. The coordinator reads the report
 * as the worker wrote it (`session-inbox.ts`), and a condensed retelling in
 * its context would be a second, softer version of the same claim with no way
 * to tell them apart.
 */
export const WORKER_REPORT_SUMMARY_EVENT = 'worker:report-summary';

export interface WorkerReportSummaryData {
  worker: string;
  /** The seq of the `worker:reported` event this summarises. */
  reportSeq: number;
  /** The result in a few words, no full stop: "Header and sidebar simplified". */
  title: string;
  /**
   * The facts the card shows under the title, one per line: what changed,
   * what is running and what is not, what was checked, what remains. Lines
   * rather than a paragraph because the card is read at a glance and parallel
   * facts do not survive being run together.
   */
  text: string;
  model: string;
}

/** Longest title that still reads as a result line rather than a sentence. */
const MAX_SUMMARY_TITLE_CHARS = 80;
/**
 * More facts than this and the card has become a second report.
 *
 * The prompt asks for four at most; this tolerates one over. The bound exists
 * to keep the card short, and rejecting a fifth line does not shorten
 * anything — it drops the summary and puts the whole clipped report back on
 * the card, which is what the feature exists to avoid. The heaviest report of
 * the four checked on 2026-09-21 is the one that overshot, and it is also the
 * one least worth reading raw.
 */
const MAX_SUMMARY_POINTS = 5;
/** Longest single fact that is still taken in at a glance. */
const MAX_SUMMARY_POINT_CHARS = 180;

/**
 * The facts in a summary body: one per line, with whatever bullet marker the
 * writer used stripped. The card decides how a fact is marked, not the model,
 * so a body written with dashes and one written without render the same.
 */
export function reportSummaryPoints(text: string): string[] {
  return text
    .split('\n')
    // Backticks come off: the card renders these as plain text, so a path the
    // writer marked up as code would otherwise show its backticks.
    .map((line) => line.trim().replace(/^[-*\u2022]\s*/, '').replace(/`/g, '').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/**
 * The title and facts a writer produced, before any length bound is applied,
 * or null when there is no title or no fact to bound.
 */
export function reportSummaryDraft(raw: string): { title: string; points: string[] } | null {
  const lines = raw.split('\n');
  const titleIdx = lines.findIndex((line) => line.trim().length > 0);
  if (titleIdx < 0) return null;
  const title = lines[titleIdx].trim().replace(/^#+\s*/, '').replace(/[*_`]/g, '').replace(/[.:]+$/, '').trim();
  const points = reportSummaryPoints(lines.slice(titleIdx + 1).join('\n'));
  if (!title || points.length === 0) return null;
  return { title, points };
}

/**
 * What in a draft is over the card's bounds, each named in words the writer
 * can act on — "Line 2 is 214 characters; the most is 180" — so a draft that
 * is only too long can be sent back to be shortened rather than lost. Empty
 * when it fits.
 */
export function reportSummaryOverLimits(draft: { title: string; points: string[] }): string[] {
  const problems: string[] = [];
  if (draft.title.length > MAX_SUMMARY_TITLE_CHARS) {
    problems.push(`The first line is ${draft.title.length} characters; the most is ${MAX_SUMMARY_TITLE_CHARS}.`);
  }
  if (draft.points.length > MAX_SUMMARY_POINTS) {
    problems.push(`There are ${draft.points.length} lines under the first; the most is ${MAX_SUMMARY_POINTS}.`);
  }
  draft.points.forEach((point, i) => {
    if (point.length > MAX_SUMMARY_POINT_CHARS) {
      problems.push(`Line ${i + 1} under the first is ${point.length} characters; the most is ${MAX_SUMMARY_POINT_CHARS}.`);
    }
  });
  return problems;
}

/**
 * The title and body a writer produced, or null when what came back does not
 * fit the card. Null is not an error worth showing: the card falls back to
 * the report itself, which was always readable.
 *
 * The body is stored one fact per line, which is what the card renders. A
 * writer that answered in a paragraph produces one long line; the per-line
 * bound is what stops that reaching the card as a block of prose.
 */
export function usableReportSummary(raw: string): { title: string; text: string } | null {
  const draft = reportSummaryDraft(raw);
  if (!draft || reportSummaryOverLimits(draft).length > 0) return null;
  return { title: draft.title, text: draft.points.join('\n') };
}

/**
 * Marker line a worker puts first when its final message is a question the
 * coordinator must answer before it can continue. Matched case-insensitively
 * after stripping markdown emphasis and heading marks.
 */
export const WORKER_QUESTION_MARKER = 'Question for front';

export function isWorkerQuestion(text: string): boolean {
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  const bare = firstLine.replace(/^[#*_\s]+/, '').replace(/[*_]+/g, '');
  return bare.toLowerCase().startsWith(WORKER_QUESTION_MARKER.toLowerCase());
}

/** The question without its marker line, for display. Text that has no marker is returned as is. */
export function stripWorkerQuestionMarker(text: string): string {
  if (!isWorkerQuestion(text)) return text;
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.trim().length > 0);
  const rest = lines[index].replace(/^[#*_\s]*question for front\s*[:—-]?\s*[*_]*/i, '').trim();
  const remaining = [...(rest ? [rest] : []), ...lines.slice(index + 1)].join('\n').trim();
  return remaining || text;
}

/**
 * Marker line a worker puts first when its report ends a turn it has stopped
 * to wait on something other than the coordinator: "Waiting on: the next
 * quiet restart". Without it a waiting worker's card read Reported for hours,
 * which looks finished.
 */
export const WORKER_WAIT_MARKER = 'Waiting on';

/**
 * What a report says the worker is waiting on, or null when it is not a wait.
 * The phrase is the rest of the marker line, or the next line when the marker
 * stands alone. Same leniency about markdown as `isWorkerQuestion`.
 */
export function workerWaitPhrase(text: string): string | null {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const bare = (line: string) => line.replace(/^[#*_\s]+/, '').replace(/[*_]+/g, '').trim();
  const match = /^waiting on\s*:\s*(.*)$/i.exec(bare(lines[0] ?? ''));
  if (!match) return null;
  const phrase = (match[1] || bare(lines[1] ?? '')).replace(/\.$/, '').trim();
  // "Waiting on: nothing." is a worker saying it is not waiting; the card
  // read "Waiting on nothing" for it.
  if (/^(nothing|none|n\/a)\s*($|[—–:;,.(]|\s-)/i.test(phrase)) return null;
  return phrase || null;
}

/**
 * Prefixes of the messages the server delivers into a coordinator on a
 * worker's behalf. The coordinator's thread hides these inputs — the worker
 * event carries the same content in its own shape — while agents reading
 * the transcript still see them.
 */
export const WORKER_REPORT_INPUT_PREFIX = '[Report from worker ';
export const WORKER_QUESTION_INPUT_PREFIX = '[Question from worker ';

export function isWorkerInput(text: string): boolean {
  return text.startsWith(WORKER_REPORT_INPUT_PREFIX) || text.startsWith(WORKER_QUESTION_INPUT_PREFIX);
}

/**
 * After a coordinator's context is compacted, the server prepends its
 * standing preamble and worker roster to the next input (see
 * `context-compaction.ts`). The block is bounded by these two lines so the
 * thread can show the message the way it was written, and so the delivery
 * queue can still recognise a worker report underneath it.
 */
export const CONTEXT_RESTORE_PREFIX = '[Context restored after compaction.';
export const CONTEXT_RESTORE_END = '[End of restored context]';

/**
 * A shorter server-written block for one-line notices (the project-state
 * nudge, see `project-state.ts`), bounded the same way. Either block can
 * precede an input, in any order; both are stripped for display.
 */
export const SERVER_NOTE_PREFIX = '[From the server:';
export const SERVER_NOTE_END = '[End of server note]';

/** The input without any restored-context or server-note blocks in front of it. */
export function stripContextRestore(text: string): string {
  let rest = text;
  for (;;) {
    const marker = rest.startsWith(CONTEXT_RESTORE_PREFIX)
      ? CONTEXT_RESTORE_END
      : rest.startsWith(SERVER_NOTE_PREFIX) ? SERVER_NOTE_END : null;
    if (!marker) return rest;
    const end = rest.indexOf(marker);
    if (end < 0) return rest;
    rest = rest.slice(end + marker.length).replace(/^\n+/, '');
  }
}

/**
 * A coordinator's or worker's first input carries the server-written
 * preamble from `pickup-prompts.ts` ahead of the caller's own text, ending in
 * a `---` line the preamble itself never contains. The thread shows only the
 * text the caller wrote; `conversations.initial_prompt` already does.
 */
export const PREAMBLE_OPENINGS = ['You are `front`:', 'Picked up from '] as const;
export const PREAMBLE_END = '\n---\n';

/** The input without a coordinator or worker preamble in front of it. */
export function stripPreamble(text: string): string {
  if (!PREAMBLE_OPENINGS.some((opening) => text.startsWith(opening))) return text;
  const end = text.indexOf(PREAMBLE_END);
  if (end < 0) return text;
  return text.slice(end + PREAMBLE_END.length).replace(/^\n+/, '');
}

// ---------------------------------------------------------------------------
// Worker state, folded from a coordinator's events

export type WorkerPhase = 'working' | 'asked' | 'reported';

export interface WorkerState {
  worker: string;
  provider: string;
  model: string | null;
  task: string;
  /** The open thread it was dispatched onto; null when it was dispatched without one. */
  thread: number | null;
  startedAt: number;
  phase: WorkerPhase;
  /** Open question text while phase is 'asked'. */
  question: string | null;
  /** Timestamp of the event that set the current phase. */
  since: number;
  /** What the latest report says the worker stopped to wait on; null when it did not. See `workerWaitPhrase`. */
  waitingOn?: string | null;
  /**
   * The worker has produced output since its latest report, so that report no
   * longer says where it stands. Read from the worker's own log by the server
   * (`readWorkerStates`); the fold cannot see it. Absent means not checked.
   */
  workedSinceReport?: boolean;
}

export interface WorkerEventLike {
  type: string;
  timestamp: number;
  data: unknown;
}

/** Fold worker events (oldest first) into one state per worker, in dispatch order. */
export function foldWorkerStates(events: readonly WorkerEventLike[]): WorkerState[] {
  const byWorker = new Map<string, WorkerState>();
  for (const event of events) {
    if (!isWorkerEventType(event.type)) continue;
    const data = event.data as { worker?: string };
    if (!data?.worker) continue;
    switch (event.type) {
      case 'worker:started': {
        const started = event.data as WorkerStartedData;
        byWorker.set(started.worker, {
          worker: started.worker,
          provider: started.provider,
          model: started.model ?? null,
          task: started.task,
          thread: typeof started.thread === 'number' ? started.thread : null,
          startedAt: event.timestamp,
          // A worker moved in is wherever it stood in the project it left. An
          // open question comes over as its own copied event right after this.
          phase: started.movedFrom?.phase === 'reported' ? 'reported' : 'working',
          question: null,
          since: event.timestamp,
        });
        break;
      }
      case 'worker:moved':
        // Not this project's any more. Its events here stay in the history.
        byWorker.delete(data.worker);
        break;
      case 'worker:reassigned': {
        const state = byWorker.get(data.worker);
        if (!state) break;
        // Only the name. Everything else about where the worker stands was
        // put there by an event that meant it.
        state.task = (event.data as WorkerReassignedData).task;
        break;
      }
      case 'worker:asked': {
        const state = byWorker.get(data.worker);
        if (!state) break;
        state.phase = 'asked';
        state.waitingOn = null;
        state.question = (event.data as WorkerAskedData).text;
        state.since = event.timestamp;
        break;
      }
      case 'worker:answered': {
        const state = byWorker.get(data.worker);
        if (!state) break;
        state.phase = 'working';
        state.question = null;
        state.waitingOn = null;
        state.since = event.timestamp;
        break;
      }
      case 'worker:reported': {
        const state = byWorker.get(data.worker);
        if (!state) break;
        state.phase = 'reported';
        state.question = null;
        state.since = event.timestamp;
        state.waitingOn = workerWaitPhrase((event.data as WorkerReportedData).text ?? '');
        if ((event.data as WorkerReportedData).model) state.model = (event.data as WorkerReportedData).model;
        break;
      }
    }
  }
  return [...byWorker.values()];
}

/**
 * What `GET /api/conv/:id/workers` returns per worker: the folded state plus
 * what lives outside the coordinator's log. `archived` is the coordinator's
 * call that the worker is done (it archives the session); `reportReached`
 * says whether the worker's latest report or question has been sent into the
 * coordinator's session yet (see `worker-delivery-queue.ts`).
 */
/**
 * What a worker's process is doing now. Derived in
 * `services/sessions/worker-runtime.ts`; kept here because the card renders
 * it. `unknown` means the harness could not be asked — it is not a stopped
 * worker, and must never be shown as one.
 */
export type WorkerRuntime =
  | 'working'
  | 'starting'
  | 'stopping'
  | 'idle'
  | 'exited'
  | 'unknown';

export interface WorkerCardState extends WorkerState {
  contextTokens: number | null;
  archived: boolean;
  reportReached: boolean;
  /**
   * What the worker's process is doing now, from the harness — see
   * `services/sessions/worker-runtime.ts` for how it is derived and why
   * liveness alone is not enough to answer it.
   *
   * Separate from `phase` on purpose. `phase` is the assignment lifecycle
   * folded from the coordinator's log, and nothing in that fold represents a
   * process ending: a worker stopped or exited without reporting leaves no
   * event, so its phase stays wherever it was. A worker can be `working` and
   * `exited`, which is unfinished work, not finished work.
   *
   * Optional because a client can be newer than the server it is talking to,
   * and absent must not be read as stopped.
   */
  runtime?: WorkerRuntime;
  /**
   * Whether anything is waiting in the worker's inbox that it has not taken
   * into a turn yet. An idle worker with a message queued is about to run
   * again, which is not the same as one that has stopped.
   */
  queued?: boolean;
  /**
   * One short phrase for what the worker is doing now ("Testing the
   * composer"), written from its own work evidence — see
   * `services/sessions/worker-activity.ts`. Null whenever there is none to
   * show, which is ordinary: the card falls back to its lifecycle line and
   * never says the activity is missing.
   */
  activity: string | null;
}

/**
 * Whether a worker that has reported is working again. It reported, and then
 * something started it up once more — the user typing into its own session, or
 * an input arriving that was not a coordinator `session send`. None of that
 * writes to the coordinator's log, so the fold leaves the phase on
 * `reported` while a turn is in progress (phase `reported`, runtime `working`,
 * card reading Reported).
 *
 * Only positive evidence of activity counts. `unknown` is an unavailable
 * harness and an absent field is a server older than it, and reading either
 * as a running worker would flip every reported card to Working the moment
 * the runtime could not be asked.
 */
export function workerResumedAfterReport(worker: Pick<WorkerCardState, 'phase' | 'runtime' | 'queued'>): boolean {
  if (worker.phase !== 'reported') return false;
  return worker.runtime === 'working' || worker.runtime === 'starting' || worker.runtime === 'stopping'
    || worker.queued === true;
}

/**
 * What a reported worker is waiting on, while it still is. Resuming clears it
 * without a new report — a turn in progress, or any output since the report,
 * which stays true after that turn ends — and the next report replaces it. Shared by the panel and the CLI
 * roster for the same reason as `workerRuntimeWord`.
 */
export function workerWaitingOn(worker: Pick<WorkerCardState, 'phase' | 'runtime' | 'queued' | 'waitingOn' | 'workedSinceReport'>): string | null {
  if (worker.phase !== 'reported' || workerResumedAfterReport(worker) || worker.workedSinceReport) return null;
  return worker.waitingOn ?? null;
}

/**
 * What to call a worker whose assignment is unfinished, from what its process
 * is actually doing.
 *
 * Shared because it was not, and that is how the bug half-survived its own
 * fix. The panel and the CLI roster render the same worker from the same
 * endpoint through two separate pieces of code; correcting only the panel left
 * `lattice session workers` printing the literal word "working" for a process
 * that had exited, which is the same false claim in the other window.
 *
 * Callers own their own casing and their own handling of archived, asked and
 * reported — this answers only the unfinished case.
 */
export function workerRuntimeWord(worker: Pick<WorkerCardState, 'runtime' | 'queued'>): string {
  switch (worker.runtime) {
    case 'working':
    case 'starting':
      return 'Working';
    case 'stopping':
      return 'Stopping';
    case 'idle':
    case 'exited':
      // Both mean no turn is in progress. Unless something is waiting in its
      // inbox, in which case it is about to pick the work up again.
      return worker.queued ? 'Queued' : 'Stopped';
    default:
      // 'unknown', or absent from a server older than the field. Neither is
      // evidence of a stopped worker, so keep the lifecycle word rather than
      // inventing a runtime claim.
      return 'Working';
  }
}

/** `GET /project`: the written state, plus what is queued at the workers carrying its open threads. */
export type ProjectStateResponse = ProjectState & {
  unread?: Record<string, UnreadInboxSummary>;
};

export interface WorkersResponse {
  workers: WorkerCardState[];
  history: WorkerHistoryRow[];
  /** The coordinator's written project state (see `project-state.ts`); null when the conversation is not a coordinator. */
  project: ProjectState | null;
  /**
   * What to call each session that has written to this conversation, keyed by
   * its id. A sender missing here is shown as the id it declared.
   */
  senders: Record<string, { name: string; role: 'worker' | 'coordinator' }>;
  /**
   * What each worker has been sent and has not taken into a turn yet, keyed
   * by its id. A worker with nothing waiting is absent. Absent altogether
   * from a server that predates it, which the CLI renders as saying nothing
   * rather than as nothing waiting.
   */
  unread?: Record<string, UnreadInboxSummary>;
}

// ---------------------------------------------------------------------------
// History, folded from the same events

export type WorkerHistoryTag = 'dispatch' | 'reassign' | 'question' | 'answer' | 'relay' | 'report' | 'move';

/**
 * One coordinator move for the panel's History list: what happened, in one
 * line, and when. Built from the worker events alone, so it is the same
 * every time it is read and no model is involved. Oldest first.
 */
export interface WorkerHistoryRow {
  tag: WorkerHistoryTag;
  worker: string;
  text: string;
  at: number;
}

/** The first non-blank line of a message: the line it leads with, unshortened. */
export function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
}

function providerName(provider: string): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return provider;
}

export function foldWorkerHistory(events: readonly WorkerEventLike[]): WorkerHistoryRow[] {
  const rows: WorkerHistoryRow[] = [];
  for (const event of events) {
    if (!isWorkerEventType(event.type)) continue;
    const data = event.data as { worker?: string };
    if (!data?.worker) continue;
    const at = event.timestamp;
    switch (event.type) {
      case 'worker:started': {
        const { provider, task, movedFrom } = event.data as WorkerStartedData;
        rows.push(movedFrom
          ? { tag: 'move', worker: data.worker, text: `Took over a ${providerName(provider)} worker from ${movedFrom.project ?? movedFrom.coordinator}: ${task}`, at }
          : { tag: 'dispatch', worker: data.worker, text: `Started a ${providerName(provider)} worker: ${task}`, at });
        break;
      }
      case 'worker:moved': {
        const { to, project, task } = event.data as WorkerMovedData;
        rows.push({ tag: 'move', worker: data.worker, text: `Moved the worker to ${project ?? to}: ${task}`, at });
        break;
      }
      case 'worker:reassigned': {
        const { task } = event.data as WorkerReassignedData;
        rows.push({ tag: 'reassign', worker: data.worker, text: `Moved the worker on to: ${task}`, at });
        break;
      }
      case 'worker:asked': {
        const { text } = event.data as WorkerAskedData;
        rows.push({ tag: 'question', worker: data.worker, text: `Worker asked: ${firstLine(stripWorkerQuestionMarker(text))}`, at });
        break;
      }
      case 'worker:answered': {
        const { summary, text, passedOn } = event.data as WorkerAnsweredData;
        const line = summary?.trim() || firstLine(text);
        rows.push({
          tag: passedOn ? 'relay' : 'answer',
          worker: data.worker,
          text: passedOn ? `Passed on to the worker: ${line}` : `Told the worker: ${line}`,
          at,
        });
        break;
      }
      case 'worker:reported': {
        const { text } = event.data as WorkerReportedData;
        rows.push({ tag: 'report', worker: data.worker, text: `Worker reported: ${firstLine(text)}`, at });
        break;
      }
    }
  }
  return rows;
}
