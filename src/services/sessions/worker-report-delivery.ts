/**
 * Worker report delivery — when a conversation picked up from a coordinator
 * ends a turn, the reply it ended on goes to the coordinator two ways:
 *
 * 1. A worker event in the coordinator's own event log (`worker:reported` or
 *    `worker:asked`), which is what the coordinator's thread and Workers
 *    panel render. See `src/types/worker-events.ts` for the shapes.
 * 2. An item in the coordinator's inbox (`session-inbox.ts`), read by its
 *    next turn: now if it is idle, otherwise with whatever else arrives
 *    before its current turn ends. The drain goes through the same
 *    `/api/harness/:id/send` path the composer and `lattice session send`
 *    use, so a coordinator whose process has exited is resumed the same way
 *    a user's message would resume it. The web client hides the input in
 *    the coordinator's thread (`isWorkerInput`) because the event above
 *    already shows it in the worker's own shape rather than as if the user
 *    typed it.
 *
 * A turn is several assistant messages with tool calls between them: progress
 * lines while the worker works ("Now the composer CSS."), then the reply it
 * ends on. Only that reply is delivered, exactly as written. Before
 * 2026-09-20 the whole turn went, progress lines first, and the thread showed
 * those lines as the report.
 *
 * The side effect fires on every `turn:end`, and not every one concludes a
 * turn. The event log tells them apart without guessing at the text:
 *
 * - The server opens its own turn to run a control operation on the session.
 *   `SessionManager.compact` writes `input:sent` with `source: 'command'`
 *   before the provider's compaction, for the composer's control and for the
 *   200K auto-compaction alike. Nothing between that input and its `turn:end`
 *   is the worker's word on anything.
 * - A compaction the provider runs inside a turn of its own accord ends in a
 *   `turn:end` with `compact: true`, and the worker carries on with no new
 *   `input:sent`; the events after the last input then hold only progress
 *   lines and tool calls. Nothing is delivered until the real `turn:end`,
 *   whose reply arrives whole.
 * - A turn cut short by `stop:requested` never reached its reply.
 * - A turn whose last content is a tool call has no reply either.
 *
 * A reply that opens with the question marker is a question: the coordinator
 * is told to answer it itself unless it is the user's call. Anything else is a
 * report.
 */

import { createLogger } from '../infrastructure/logger.js';
import { ConversationService } from './conversation-service.js';
import { getEvents } from '../../session-history/repository.js';
import { projectTranscript } from '../../session-history/renderer.js';
import type { RawEvent } from '../../session-history/types.js';
import { appendWorkerEvent } from './worker-events.js';
import { drainInbox, enqueueInboxItem } from './session-inbox.js';
import { noteWorkerReport } from './worker-report-summary.js';
import { handOverNow } from './immediate-delivery.js';
import { UserName } from '../user-profile.js';
import { checkWaitingWorkers } from './wait-watch.js';
import {
  isWorkerQuestion,
  workerWaitPhrase,
  type WorkerAskedData,
  type WorkerReportedData,
} from '../../types/worker-events.js';

const logger = createLogger('WorkerReportDelivery');

/** How long after a waiting report its wait is checked. */
const WAIT_CHECK_DELAY_MS = 15_000;

export type LastTurn =
  /** The turn ended on an assistant reply, given exactly as written. */
  | { reply: string }
  /**
   * The turn has no reply to deliver: it was the server's own control
   * operation, it was stopped, the `turn:end` was a compaction's and the
   * worker is still going, or its last content was a tool call.
   */
  | { reply: null; reason: 'control-operation' | 'interrupted' | 'compacting' | 'no-reply' };

/**
 * Whether the turn's content ends on a text block rather than a tool call.
 * Walks blocks in order within each event: the Claude adapter writes an
 * assistant message's blocks into one content event (`normalize-claude.js`),
 * so text and the tool call that follows it can share a seq.
 */
function endsOnText(events: readonly RawEvent[]): boolean {
  let last: 'text' | 'tool_use' | null = null;
  for (const event of events) {
    if (event.type !== 'content') continue;
    const blocks = (event.data as { blocks?: Array<{ type?: string; text?: unknown }> })?.blocks;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'tool_use') last = 'tool_use';
      else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) last = 'text';
    }
  }
  return last === 'text';
}

const isCompactEnd = (event: RawEvent) =>
  event.type === 'turn:end' && (event.data as { compact?: boolean } | undefined)?.compact === true;

/**
 * Where the turn that just ended begins: its input, or the previous turn's
 * `turn:end` when it had none. Claude opens a turn of its own when a Monitor
 * or background task it started reports back, and that turn writes no
 * `input:sent`. Looking back only for an input took such a turn for part of an
 * older one; after a compaction the server ran, that older input was the
 * command, and every report the worker made until its next input was dropped
 * (38 turns of one worker on 2026-09-26). A compaction's `turn:end` is not a
 * boundary: the turn it interrupted carries on.
 */
function turnStart(events: readonly RawEvent[]): number {
  let end = events.length;
  while (end > 0 && events[end - 1].type !== 'turn:end') end -= 1;
  for (let i = end - 2; i >= 0; i--) {
    if (events[i].type === 'input:sent') return i;
    if (events[i].type === 'turn:end' && !isCompactEnd(events[i])) return i;
  }
  return -1;
}

/** The turn that just ended, read back from the event log. Exported for tests. */
export function readLastTurn(events: readonly RawEvent[]): LastTurn {
  const startIdx = turnStart(events);
  const turnEvents = events.slice(startIdx + 1);

  // A control operation's turn, whatever it ends on. A compaction that fails
  // ends on synthetic assistant text carrying the provider's error, and an
  // ordinary `turn:end` with no `compact` flag: "Not enough messages to
  // compact." reached the coordinator as a report twice.
  const lastInput = startIdx >= 0 && events[startIdx].type === 'input:sent' ? events[startIdx] : undefined;
  if ((lastInput?.data as { source?: string } | undefined)?.source === 'command') {
    return { reply: null, reason: 'control-operation' };
  }

  if (turnEvents.some((event) => event.type === 'stop:requested')) return { reply: null, reason: 'interrupted' };

  const lastEnd = [...turnEvents].reverse().find((event) => event.type === 'turn:end');
  if (lastEnd && isCompactEnd(lastEnd)) return { reply: null, reason: 'compacting' };

  // A turn that ended on a tool call has no reply, whatever text came before.
  if (!endsOnText(turnEvents)) return { reply: null, reason: 'no-reply' };

  // One line per assistant message: the transcript closes a line at every
  // tool call, so the last line is the message the worker ended on.
  const lines = projectTranscript(turnEvents)
    .filter((line) => line.role === 'assistant' && line.text.trim().length > 0);
  return { reply: lines[lines.length - 1].text.trim() };
}

/** The newest compaction's error, when the newest one failed; null otherwise. */
function lastCompactionFailure(events: readonly RawEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'context:compaction') continue;
    const data = events[i].data as { phase?: string; error?: string } | undefined;
    if (data?.phase !== 'failed') return null;
    return data.error ?? 'no error given';
  }
  return null;
}

/** Called from the turn:end side effect for every conversation; a no-op unless it has a parent. Never rejects. */
export async function deliverWorkerReport(workerConversationId: string): Promise<void> {
  try {
    await deliverIfWorker(workerConversationId);
  } catch (err) {
    logger.error('Worker report delivery threw', {
      worker: workerConversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function deliverIfWorker(workerConversationId: string): Promise<void> {
  const conversationService = ConversationService.getInstance();
  const worker = conversationService.getConversation(workerConversationId);
  if (!worker?.pickedUpFrom) return;
  const parent = worker.pickedUpFrom;

  const events = getEvents(workerConversationId);
  const turn = readLastTurn(events);
  // A turn cut short by a stop request is not the worker's word on anything:
  // whoever stopped it (the coordinator's `session send`, or the user) sent the
  // input that follows, and the worker's answer to that is the report.
  // Delivering the fragment too put two "Reported" blocks in the thread for
  // one exchange. A compaction's turn:end did the same with the progress
  // lines so far.
  if (turn.reply === null) {
    // A control operation that failed still has to be seen. The worker's own
    // thread renders the `context:compaction` as an error; this keeps it in
    // the server log too, so suppressing the delivery does not also hide it.
    const failure = turn.reason === 'control-operation' ? lastCompactionFailure(events) : null;
    if (failure !== null) {
      logger.warn('Compaction failed; its error is not a worker report', {
        worker: workerConversationId,
        parent,
        error: failure,
      });
      return;
    }
    logger.info('Worker turn ended without a reply; nothing to deliver', {
      worker: workerConversationId,
      parent,
      reason: turn.reason,
    });
    return;
  }
  const { reply } = turn;

  const model = conversationService.getLatestSegment(workerConversationId)?.model ?? null;
  // A worker that narrates its way to a question still asked one. Checking
  // the whole turn missed those and stored them as reports.
  const question = isWorkerQuestion(reply);

  // The event is the record; the inbox row carries its seq so the header the
  // coordinator reads names the exact question or report (`--answers <seq>`,
  // `--addresses <seq>`), and the row can be traced back to it. A row with no
  // seq means the event was not written, which the log above already says.
  const sourceEvent = question
    ? appendWorkerEvent(parent, 'worker:asked', { worker: workerConversationId, text: reply } satisfies WorkerAskedData)
    : appendWorkerEvent(parent, 'worker:reported', { worker: workerConversationId, model, text: reply } satisfies WorkerReportedData);

  enqueueInboxItem({
    sessionId: parent,
    source: question ? 'worker-question' : 'worker-report',
    text: reply,
    worker: workerConversationId,
    workerModel: model,
    sourceSeq: sourceEvent?.seq ?? null,
  });
  // The card's readable summary, written afterwards and only for the card —
  // see `worker-report-summary.ts`. Deliberately after the enqueue and not
  // awaited: the coordinator must get the report as fast as it ever did, and a
  // model call that is slow, failing or switched off must not hold it up or
  // change what arrives. A question is not summarised; it goes to the
  // coordinator whole, in the worker's own words, and it is short already.
  if (!question && sourceEvent) {
    noteWorkerReport({ coordinator: parent, worker: workerConversationId, reportSeq: sourceEvent.seq, report: reply });
  }
  await drainInbox(parent);
  // A report that says it is waiting is checked for having something set up
  // to wake it. Shortly after rather than now, so a task the turn started has
  // settled into the log; the periodic pass catches a process that dies later.
  if (!question && workerWaitPhrase(reply)) {
    setTimeout(() => { void checkWaitingWorkers(parent); }, WAIT_CHECK_DELAY_MS).unref?.();
  }
}

/** The line a coordinator reads when the user stops one of its workers. Exported for tests. */
export function userStoppedWorkerLine(workerConversationId: string): string {
  return `${UserName()} stopped your worker ${workerConversationId} manually. They may be steering that session directly.`;
}

/**
 * The user pressed Stop on a worker. The stopped turn delivers no report (see
 * `readLastTurn`), so the coordinator gets this one attributed line instead,
 * handed over like a reaction: into a running turn, or a turn of its own on
 * an idle coordinator. Never rejects.
 */
export async function noteUserStoppedWorker(workerConversationId: string): Promise<void> {
  try {
    const parent = ConversationService.getInstance().getConversation(workerConversationId)?.pickedUpFrom;
    if (!parent) return;
    const inboxId = enqueueInboxItem({
      sessionId: parent,
      source: 'worker-stopped',
      text: userStoppedWorkerLine(workerConversationId),
      worker: workerConversationId,
    });
    await handOverNow(parent, inboxId);
  } catch (err) {
    logger.error('Telling the coordinator about a manual stop threw', {
      worker: workerConversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
