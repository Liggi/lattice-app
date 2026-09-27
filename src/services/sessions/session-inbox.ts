/**
 * The session inbox: durable rows for what a session could not read when it
 * arrived, drained into one turn when it can.
 *
 * Two things land here. A user's message to a Codex process that is inside a
 * turn: the adapter would park it in memory until the turn ends, and a server
 * restart in that window dropped it silently while the thread showed it as
 * sent (observed 2026-09-20). And a worker's report or question for the
 * coordinator it was picked up from, which is only handed over between the
 * coordinator's turns (verified 2026-09-19: sending into a running
 * coordinator parked it the same way). Each used to have its own queue with
 * its own receipt states and its own duplicate check; the inbox is one table
 * with a `source` column, so attribution is a fact of the row rather than a
 * prefix on the text.
 *
 * A third thing lands here since 2026-09-20: any message another agent sends
 * (`session send --from`), whether or not the session is busy. Written
 * straight to the process, the text reached the model as if the user had typed
 * it, and a queued one was labelled as the user's because every send row was
 * `source: 'user'` (a worker's audit was read as the user's).
 * The row carries the declared sender and whether it relays the user's decision,
 * and the drain labels the text with exactly that — or with "unidentified"
 * when nothing was declared. Declared, not authenticated.
 *
 * Drain: when the session is idle and has unread rows, one send carries all
 * of them in arrival order, each labelled with who it is from and when. A
 * single user message goes as written, so an idle session getting one
 * message sees an ordinary turn. The send goes through
 * `/api/harness/:id/send` like anything else, so a process that has exited
 * is resumed the same way, and the route appends `input:read` after the
 * `input:sent` it produced. Rows are marked read when the route answers.
 *
 * Every drain holds the session's turn admission (`turn-admission.ts`) while
 * it composes and sends, and passes the admission id to the route so the
 * route runs inside it. An interrupting send takes the same admission before
 * it cancels the turn, so the drain that fires at the resulting turn end
 * waits, and the correction goes in the batch the interrupt itself sends.
 *
 * Restart: rows still unread are simply in the next drain. A row whose
 * `attempts` is above zero reached a send before (the previous server may
 * have died between the send and the mark), so the batch opens with a note
 * that the items may have been seen; the model checks its last turn rather
 * than repeating work. That is the whole of the recovery story: delivery is
 * idempotent at the prompt, which is what made the old
 * pending/supplying/supplied/failed/unknown machine unnecessary.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseJson } from '../../utils/json.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { ConfigService } from '../infrastructure/config-service.js';
import { createLogger } from '../infrastructure/logger.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import {
  SERVER_NOTE_END,
  SERVER_NOTE_PREFIX,
  WORKER_QUESTION_INPUT_PREFIX,
  WORKER_REPORT_INPUT_PREFIX,
} from '../../types/worker-events.js';
import {
  INBOX_QUEUED_EVENT,
  INBOX_UNDELIVERABLE_EVENT,
  INBOX_WITHDRAWN_EVENT,
  type InboxQueuedData,
  type InboxSource,
  type InboxUndeliverableData,
  type InboxWithdrawnData,
  type UnreadInboxSummary,
} from '../../types/inbox.js';
import { latticeCli } from './pickup-prompts.js';
import { withTurnAdmission, type TurnAdmission } from './turn-admission.js';
import { userName, UserName } from '../user-profile.js';
import { reportThreadPrompt } from './project-state.js';

const logger = createLogger('SessionInbox');

/**
 * How long a drain defers to a delivery that has not resolved.
 *
 * Long enough to cover a turn a steered message is waiting behind, short
 * enough that a delivery which never answers cannot stop the inbox for the
 * life of the process. Past it the rows of that delivery stay reserved — they
 * are never re-sent — but everything else moves again.
 */
const DELIVERY_IN_FLIGHT_GRACE_MS = 120_000;

export interface InboxRow {
  id: string;
  session_id: string;
  source: InboxSource;
  text: string;
  worker: string | null;
  worker_model: string | null;
  attachments_json: string | null;
  model: string | null;
  reasoning_effort: string | null;
  created_at: string;
  attempts: number;
  last_error: string | null;
  read_at: string | null;
  read_seq: number | null;
  /** For an `agent` item: the conversation that declared itself the sender; null when none did. */
  sender: string | null;
  /** 1 when the sender declared the text relays the user's decision (`--passed-on`). */
  passed_on: number;
  /** The event in the session's own log this item was made from; null for a message, or a row from before it was recorded. */
  source_seq: number | null;
  /** Caller-chosen key that makes enqueueing the same delivery twice a no-op; null for ordinary items. */
  delivery_id: string | null;
  /** Batch id of a delivery in flight or unresolved; a reserved row is not offered to a drain. */
  reserved_by: string | null;
  reserved_at: string | null;
  /** How far the delivery holding this row has got; see `ReservationState`. */
  reservation_state: ReservationState | null;
  /** 1 when the sender asked for it to wait for the turn to end (`send --after-turn`); a delivery into a running turn leaves it behind. */
  after_turn: number;
}

/**
 * How far a delivery has got, which is what a restart has to read to decide
 * whether sending the rows again would repeat something the model has
 * already been told.
 *
 * `reserved`  the rows are out of the drain and the provider has not been
 *             asked. Nothing was delivered, and a restart can say so.
 * `handed`    the input left for the provider and no answer has come back.
 *             Whether it arrived is not knowable from here.
 * `accepted`  the provider acknowledged it but no turn has taken it yet.
 * `uncertain` the process that was handed the rows is gone. Once none is
 *             running, Claude's own transcript says whether a turn took
 *             them (`held-delivery-settlement.ts`); otherwise they wait for
 *             `resolveUncertainReservation`.
 */
export type ReservationState = 'reserved' | 'handed' | 'accepted' | 'uncertain';

const COLUMNS = 'id, session_id, source, text, worker, worker_model, attachments_json, model, reasoning_effort, created_at, attempts, last_error, read_at, read_seq, sender, passed_on, source_seq, delivery_id, reserved_by, reserved_at, reservation_state, after_turn';

function db(): Database.Database {
  return DatabaseProvider.getInstance().getDb();
}

/**
 * Add an item and mark the thread. The queued event is what the thread shows
 * until a turn reads the item, so it carries the item as written.
 *
 * With a `deliveryId`, a second call for the same (session, deliveryId) adds
 * nothing and returns the existing row's id: the row is the record of the
 * delivery, so a caller that crashed between deciding to deliver and
 * recording that it did can simply call again.
 */
export function enqueueInboxItem(input: {
  sessionId: string;
  source: InboxSource;
  text: string;
  worker?: string | null;
  workerModel?: string | null;
  attachmentsJson?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  /** The conversation that declared itself the sender (`--from`). */
  sender?: string | null;
  /** The sender declared the text relays the user's decision (`--passed-on`). */
  passedOn?: boolean;
  /** The event in the session's log the item was made from. */
  sourceSeq?: number | null;
  /** Idempotency key, unique per session. */
  deliveryId?: string | null;
  /** The sender asked for this to wait for the turn to end rather than go into it. */
  afterTurn?: boolean;
}): string {
  const id = randomUUID();
  const inserted = db().prepare(
    `INSERT INTO session_inbox
       (id, session_id, source, text, worker, worker_model, attachments_json, model, reasoning_effort, created_at,
        sender, passed_on, source_seq, delivery_id, after_turn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, delivery_id) WHERE delivery_id IS NOT NULL DO NOTHING`,
  ).run(
    id,
    input.sessionId,
    input.source,
    input.text,
    input.worker ?? null,
    input.workerModel ?? null,
    input.attachmentsJson ?? null,
    input.model ?? null,
    input.reasoningEffort ?? null,
    new Date().toISOString(),
    input.sender ?? null,
    input.passedOn ? 1 : 0,
    input.sourceSeq ?? null,
    input.deliveryId ?? null,
    input.afterTurn ? 1 : 0,
  );
  if (inserted.changes === 0) {
    const existing = db().prepare(
      `SELECT id FROM session_inbox WHERE session_id = ? AND delivery_id = ?`,
    ).get(input.sessionId, input.deliveryId) as { id: string } | undefined;
    if (!existing) throw new Error(`inbox insert for delivery ${input.deliveryId} neither inserted nor found`);
    return existing.id;
  }
  const manager = getHarnessSessionManager();
  if (manager) {
    appendCustomHarnessEvent(manager, input.sessionId, INBOX_QUEUED_EVENT, {
      id,
      source: input.source,
      text: input.text,
      ...(input.worker ? { worker: input.worker } : {}),
      ...(input.sender ? { sender: input.sender } : {}),
      ...(input.passedOn ? { passedOn: true } : {}),
      ...(typeof input.sourceSeq === 'number' ? { sourceSeq: input.sourceSeq } : {}),
      ...(input.afterTurn ? { afterTurn: true } : {}),
    } satisfies InboxQueuedData);
  }
  return id;
}

/** Unread rows of one source, oldest first: how many deliveries of a kind are still waiting on a turn. */
export function unreadInboxItemsOfSource(sessionId: string, source: InboxSource): InboxRow[] {
  return db().prepare(
    `SELECT ${COLUMNS} FROM session_inbox WHERE session_id = ? AND source = ? AND read_at IS NULL ORDER BY created_at ASC, rowid ASC`,
  ).all(sessionId, source) as InboxRow[];
}

export function getInboxItem(id: string): InboxRow | undefined {
  return db().prepare(`SELECT ${COLUMNS} FROM session_inbox WHERE id = ?`).get(id) as InboxRow | undefined;
}

/**
 * Unread rows in arrival order, and the definition of "ready": not reserved
 * by a delivery someone else is in the middle of.
 *
 * That exclusion is what keeps two senders off the same row: a batch being
 * delivered into a running turn can see that turn end at any moment, and the
 * drain that fires when it does must not find the same rows sitting there
 * unread.
 *
 * `runningTurn` narrows it to what may go into a turn already running: an
 * item its sender asked to wait for the turn to end stays behind for the
 * drain at that boundary, however many immediate deliveries pass it.
 */
export function unreadInboxItems(sessionId: string, options: { runningTurn?: boolean } = {}): InboxRow[] {
  return db().prepare(
    `SELECT ${COLUMNS} FROM session_inbox
     WHERE session_id = ? AND read_at IS NULL AND reserved_by IS NULL
       ${options.runningTurn ? 'AND after_turn = 0' : ''}
     ORDER BY created_at ASC, rowid ASC`,
  ).all(sessionId) as InboxRow[];
}

/**
 * Take these rows out of the drain for the duration of one delivery.
 *
 * The reservation is a row in the database rather than a flag in memory
 * because the race it exists for is a process that stops existing: the
 * provider acknowledges, the server dies before it records that, and the next
 * server has to be able to tell "nobody has sent this" from "somebody may
 * already have".
 */
export function reserveInboxItems(ids: readonly string[], reservationId: string): void {
  if (ids.length === 0) return;
  const stmt = db().prepare(
    `UPDATE session_inbox SET reserved_by = ?, reserved_at = ?, reservation_state = 'reserved'
     WHERE id = ? AND read_at IS NULL AND reserved_by IS NULL`,
  );
  const now = new Date().toISOString();
  db().transaction(() => {
    for (const id of ids) stmt.run(reservationId, now, id);
  })();
}

/**
 * Move a reservation on as the provider answers. Rows a turn has already
 * taken are left alone: Codex acknowledges and incorporates in one call, so
 * the incorporation can land before the acceptance is recorded, and the read
 * state is the later of the two.
 */
export function markInboxReservation(reservationId: string, state: ReservationState): number {
  return db().prepare(
    `UPDATE session_inbox SET reservation_state = ? WHERE reserved_by = ? AND read_at IS NULL`,
  ).run(state, reservationId).changes;
}

/** The delivery definitively did not happen: the rows go back to the drain. */
export function releaseInboxReservation(reservationId: string): number {
  return db().prepare(
    `UPDATE session_inbox SET reserved_by = NULL, reserved_at = NULL, reservation_state = NULL WHERE reserved_by = ?`,
  ).run(reservationId).changes;
}

/**
 * Server start. The only reservation a new process can safely free is one its
 * predecessor had not yet handed to a provider: for that one, and only that
 * one, "nothing was delivered" is a fact rather than a hope.
 *
 * Everything further along becomes `uncertain`. A message that was handed
 * over, or acknowledged, may have reached the model before the process died —
 * the transcript a resumed session carries would already hold it — and
 * sending it again would repeat a correction the model has acted on. Rows
 * from before these states existed are treated the same way, since the older
 * `pending` covered both cases.
 */
export function resolveReservationsAtStartup(): { released: number; unresolved: number } {
  const released = db().prepare(
    `UPDATE session_inbox SET reserved_by = NULL, reserved_at = NULL, reservation_state = NULL
     WHERE reservation_state = 'reserved'`,
  ).run().changes;
  const unresolved = db().prepare(
    `UPDATE session_inbox SET reservation_state = 'uncertain'
     WHERE read_at IS NULL AND reservation_state IN ('handed', 'accepted', 'pending')`,
  ).run().changes;
  return { released, unresolved };
}

/** Rows held by an unresolved delivery, for the diagnostics that have to show a stuck one. */
export function uncertainInboxReservations(sessionId?: string): InboxRow[] {
  return sessionId
    ? db().prepare(
        `SELECT ${COLUMNS} FROM session_inbox WHERE reservation_state = 'uncertain' AND read_at IS NULL AND session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      ).all(sessionId) as InboxRow[]
    : db().prepare(
        `SELECT ${COLUMNS} FROM session_inbox WHERE reservation_state = 'uncertain' AND read_at IS NULL
         ORDER BY created_at ASC, rowid ASC`,
      ).all() as InboxRow[];
}

/** Rows a delivery handed to a provider and never saw taken into a turn, whatever state it reached. */
export function heldInboxReservations(sessionId?: string): InboxRow[] {
  const where = `read_at IS NULL AND reserved_by IS NOT NULL AND reservation_state IN ('handed', 'accepted', 'uncertain', 'pending')`;
  return (sessionId
    ? db().prepare(`SELECT ${COLUMNS} FROM session_inbox WHERE ${where} AND session_id = ? ORDER BY created_at ASC, rowid ASC`).all(sessionId)
    : db().prepare(`SELECT ${COLUMNS} FROM session_inbox WHERE ${where} ORDER BY created_at ASC, rowid ASC`).all()) as InboxRow[];
}

/**
 * Whether a delivery to this session is in flight or acknowledged but not yet
 * taken into a turn.
 *
 * A Claude message accepted as `priority: "next"` can land after the running
 * turn ends, which leaves a window where the session looks idle and its input
 * is sitting in the provider's queue. A drain firing there would send a
 * second, competing input, so it waits. `graceMs` bounds the wait: a delivery
 * that never resolves must not stop the inbox moving forever.
 */
export function sessionHasDeliveryInFlight(sessionId: string, graceMs: number): boolean {
  const since = new Date(Date.now() - graceMs).toISOString();
  return Boolean(db().prepare(
    `SELECT 1 FROM session_inbox
     WHERE session_id = ? AND read_at IS NULL AND reservation_state IN ('handed', 'accepted')
       AND reserved_at > ? LIMIT 1`,
  ).get(sessionId, since));
}

/**
 * Settle an unresolved delivery by hand, which is the only way one is ever
 * settled. `release` says the input never reached the model and puts the rows
 * back in the drain; `delivered` says it did and marks them read. Both are
 * claims about a transcript someone has looked at, which is why nothing here
 * guesses between them.
 */
export function resolveUncertainReservation(reservationId: string, as: 'release' | 'delivered'): number {
  const rows = db().prepare(
    `SELECT id FROM session_inbox WHERE reserved_by = ? AND reservation_state = 'uncertain' AND read_at IS NULL`,
  ).all(reservationId) as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  if (as === 'release') return releaseInboxReservation(reservationId);
  markInboxItemsRead(rows.map((row) => row.id));
  return rows.length;
}

export function hasUnreadInboxItems(sessionId: string): boolean {
  return Boolean(db().prepare(`SELECT 1 FROM session_inbox WHERE session_id = ? AND read_at IS NULL LIMIT 1`).get(sessionId));
}

/**
 * Take an item back before any turn has read it, as if it was never sent.
 * Only an unread row that no delivery holds can go: once a delivery has it,
 * the model may already have it, so the caller has to say so instead.
 * Returns whether the row was withdrawn.
 */
export function withdrawInboxItem(id: string): boolean {
  const row = getInboxItem(id);
  if (!row) return false;
  const removed = db().prepare(
    `DELETE FROM session_inbox WHERE id = ? AND read_at IS NULL AND reserved_by IS NULL`,
  ).run(id);
  if (removed.changes === 0) return false;
  const manager = getHarnessSessionManager();
  if (manager) {
    appendCustomHarnessEvent(manager, row.session_id, INBOX_WITHDRAWN_EVENT, { ids: [id] } satisfies InboxWithdrawnData);
  }
  return true;
}

/** A turn took these items; `readSeq` is the `input:read` the route appended after the send, when known. */
export function markInboxItemsRead(ids: readonly string[], readSeq: number | null = null): void {
  const stmt = db().prepare(
    `UPDATE session_inbox SET read_at = ?, read_seq = ?, last_error = NULL,
       reserved_by = NULL, reserved_at = NULL, reservation_state = NULL
     WHERE id = ? AND read_at IS NULL`,
  );
  const now = new Date().toISOString();
  db().transaction(() => {
    for (const id of ids) stmt.run(now, readSeq, id);
  })();
}

/** Whether each worker's latest report or question has been read by its coordinator's turn yet. */
export function latestWorkerItemReached(coordinator: string): Map<string, boolean> {
  const rows = db().prepare(
    `SELECT worker, read_at FROM session_inbox
     WHERE session_id = ? AND source IN ('worker-report', 'worker-question')
     ORDER BY created_at ASC, rowid ASC`,
  ).all(coordinator) as Array<{ worker: string; read_at: string | null }>;
  const reached = new Map<string, boolean>();
  for (const row of rows) reached.set(row.worker, row.read_at !== null);
  return reached;
}

/**
 * Unread counts for several sessions at once: what each has been sent and has
 * not taken into a turn yet, in one grouped query rather than a lookup per
 * message. `asker` is the conversation doing the reading, so a coordinator can
 * tell its own instructions from the user's or a peer's before it sends another.
 *
 * Read means a turn was handed the item, not that the session acted on it.
 * Sessions with nothing unread are absent from the map.
 */
export function unreadInboxSummaries(sessionIds: readonly string[], asker: string): Map<string, UnreadInboxSummary> {
  const summaries = new Map<string, UnreadInboxSummary>();
  if (sessionIds.length === 0) return summaries;
  const placeholders = sessionIds.map(() => '?').join(', ');
  const rows = db().prepare(
    `SELECT session_id, COUNT(*) AS count, MIN(created_at) AS oldest,
            SUM(CASE WHEN sender = ? THEN 1 ELSE 0 END) AS from_you
     FROM session_inbox
     WHERE read_at IS NULL AND session_id IN (${placeholders})
     GROUP BY session_id`,
  ).all(asker, ...sessionIds) as Array<{ session_id: string; count: number; oldest: string; from_you: number }>;
  for (const row of rows) {
    summaries.set(row.session_id, {
      count: row.count,
      oldestAt: Date.parse(row.oldest),
      fromYou: row.from_you,
    });
  }
  return summaries;
}

/** Sessions with anything unread. */
export function sessionsWithUnreadInbox(): string[] {
  const rows = db().prepare(`SELECT DISTINCT session_id FROM session_inbox WHERE read_at IS NULL`).all() as Array<{ session_id: string }>;
  return rows.map((row) => row.session_id);
}

/** True while the session is inside a turn and its process is alive: sending now would only park the input. */
function sessionBusy(sessionId: string): boolean {
  const diagnostics = getHarnessSessionManager()?.inspect(sessionId);
  if (!diagnostics || !diagnostics.processAlive) return false;
  return diagnostics.status === 'streaming' || diagnostics.status === 'starting' || diagnostics.status === 'stopping';
}

/**
 * How a worker's report reads to its coordinator. The header names the
 * worker, says the user has not read it, and points at the transcript; the
 * coordinator's thread hides inputs with this prefix because the
 * `worker:reported` event already shows the report in its own shape.
 */
export function formatWorkerReport(input: {
  workerConversationId: string;
  model: string | null;
  text: string;
  cli: string;
  /** Arrival clock, when the report is one of several in a batch. */
  at?: string | null;
  /** Seq of the `worker:reported` event in the coordinator's log; what `--addresses` names. Unknown for rows from before it was recorded. */
  seq?: number | null;
  /** The thread-outcome question for the open thread this report is on (`reportThreadPrompt`), when it is on one. */
  threadPrompt?: string;
}): string {
  const who = [input.workerConversationId, input.model, typeof input.seq === 'number' ? `[${input.seq}]` : null].filter(Boolean).join(' · ');
  return (
    `${WORKER_REPORT_INPUT_PREFIX}${who}${input.at ? ` · ${input.at}` : ''}. ${UserName()} has not read this; anything in it they need, say in your own words. ` +
    `Full transcript: ${input.cli} session transcript ${input.workerConversationId}]\n` +
    (input.threadPrompt ? `${input.threadPrompt}\n` : '') +
    '\n' +
    input.text
  );
}

/**
 * How a worker's question reads: it is waiting, and the coordinator is told
 * how to answer and when to bring it to the user instead. The header carries the
 * seq of the `worker:asked` event so the answer can name it (`--answers`)
 * without a lookup; the question stays pending until something does.
 */
export function formatWorkerQuestion(input: {
  workerConversationId: string;
  model: string | null;
  text: string;
  cli: string;
  coordinatorConversationId: string;
  at?: string | null;
  seq?: number | null;
}): string {
  const seq = typeof input.seq === 'number' ? input.seq : null;
  const who = [input.workerConversationId, input.model, seq !== null ? `[${seq}]` : null].filter(Boolean).join(' · ');
  const answers = seq !== null ? ` --answers ${seq}` : '';
  return (
    `${WORKER_QUESTION_INPUT_PREFIX}${who}${input.at ? ` · ${input.at}` : ''}. It has stopped and is waiting on you. ${UserName()} has not read this. ` +
    `Answer it yourself if the answer is in the brief, the plan, or what ${userName()} has said; ` +
    `reply with \`${input.cli} session send ${input.workerConversationId} --from ${input.coordinatorConversationId}${answers} --summary "<one line, the substance of your answer>" --message "…"\`. ` +
    `If it is genuinely ${userName()}'s call, do not send anything to the worker: ask ${userName()} directly in your own words, with the context and your recommendation, ` +
    'and once they have decided send that with the same command plus `--passed-on`.' +
    (seq !== null ? ` A send without \`--answers ${seq}\` (an update, a pause, a correction) leaves the question pending.` : '') +
    ']\n\n' +
    input.text
  );
}

/**
 * How another agent's message reads. Always labelled, batched or not: the
 * point of the label is that the model does not take the text for the user's.
 * The sender is whatever the sender declared; none declared is said plainly.
 */
export function formatAgentMessage(input: {
  sender: string | null;
  passedOn: boolean;
  text: string;
  at: string;
}): string {
  const who = input.sender ?? 'an unidentified sender (a `session send` with no --from)';
  const relay = input.passedOn ? `, relaying ${userName()}'s decision` : '';
  return `[From ${who}${relay} · ${input.at}]\n${input.text}`;
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toTimeString().slice(0, 5);
}

/** Who an item is from, as the compaction note names it. */
function senderOf(row: InboxRow | undefined): string {
  switch (row?.source) {
    case 'worker-report':
    case 'worker-question':
    case 'worker-permission':
      return `your worker ${row.worker ?? 'unknown'}`;
    case 'agent':
      return row.sender ?? 'an unidentified sender (a `session send` with no --from)';
    case 'coordination-review':
      return 'the server\'s orientation review';
    default:
      return `${userName()}`;
  }
}

/**
 * The report's thread question. Built from the live project record, so a
 * failure to read it costs the prompt, not the delivery.
 */
function threadPromptFor(row: InboxRow, cli: string): string {
  try {
    return reportThreadPrompt(row.session_id, row.source_seq, cli);
  } catch (err) {
    logger.warn('Report thread prompt skipped', { sessionId: row.session_id, error: err instanceof Error ? err.message : String(err) });
    return '';
  }
}

/** One item as the model reads it: the worker headers are the same ones a single delivery gets. */
function renderItem(row: InboxRow, cli: string, batched: boolean): string {
  switch (row.source) {
    case 'worker-report':
      return formatWorkerReport({
        workerConversationId: row.worker ?? 'unknown',
        model: row.worker_model,
        text: row.text,
        cli,
        at: batched ? clock(row.created_at) : null,
        seq: row.source_seq,
        threadPrompt: threadPromptFor(row, cli),
      });
    case 'worker-question':
      return formatWorkerQuestion({
        workerConversationId: row.worker ?? 'unknown',
        model: row.worker_model,
        text: row.text,
        cli,
        coordinatorConversationId: row.session_id,
        at: batched ? clock(row.created_at) : null,
        seq: row.source_seq,
      });
    case 'agent':
      return formatAgentMessage({ sender: row.sender, passedOn: row.passed_on === 1, text: row.text, at: clock(row.created_at) });
    // The review writes its own header (coordination-review.ts); the clock is the only thing the drain adds.
    case 'coordination-review':
      return batched ? `[Orientation review · ${clock(row.created_at)}]\n${row.text}` : row.text;
    // The line names the emoji, the message and who reacted; it needs no header.
    // A manual stop's line names who stopped which worker, likewise.
    // A permission request carries its own header, likewise.
    case 'reaction':
    case 'worker-stopped':
    case 'worker-permission':
      return batched ? `${row.text} · ${clock(row.created_at)}` : row.text;
    case 'user':
    default:
      return batched ? `[From ${userName()} · ${clock(row.created_at)}]\n${row.text}` : row.text;
  }
}

/**
 * The input a drain sends: every unread item, in arrival order. Exported for tests.
 *
 * `midTurn` changes only the opening note. The batch is composed the same way
 * whatever route carries it — same order, same per-item provenance — because
 * a message that arrives mid-turn alongside three older ones has to read as
 * those four things in the order they were said, not as one message with some
 * history attached. What the note adds is the one thing the model cannot
 * infer: that this arrived in the middle of its turn rather than at the start
 * of a new one, so it should not read it as a fresh instruction to drop what
 * it is doing for.
 *
 * `compacting` replaces that note when the turn is a context compaction. The
 * provider holds the message until the compaction ends and then shows it
 * inside the compaction's output, where "the turn you are running" and "the
 * tool call you are in" describe nothing the model can see; on 2026-09-23 a
 * Sonnet session read that wording as text injected into a command result
 * and refused the message. So the note says what happened and who sent it.
 */
export function composeInboxInput(
  rows: readonly InboxRow[],
  cli: string,
  options: { midTurn?: boolean; compacting?: boolean } = {},
): string {
  const possiblySeen = rows.some((row) => row.attempts > 0);
  const batched = rows.length > 1;
  const body = rows.map((row) => renderItem(row, cli, batched)).join('\n\n');
  const restarted = ' Some of it may have reached you before the server restarted; check your last turn before repeating work.';
  if (options.midTurn && options.compacting) {
    const what = rows.length > 1
      ? `${rows.length} items arrived while this session was compacting its context, oldest first; each is labelled with who sent it.`
      : `This message arrived while this session was compacting its context; it is from ${senderOf(rows[0])}.`;
    return (
      `${SERVER_NOTE_PREFIX} ${what} It is addressed to you, not part of the compaction. Read it and act on it ` +
      'as you would any message.' +
      (possiblySeen ? restarted : '') +
      `]\n${SERVER_NOTE_END}\n` + body
    );
  }
  if (options.midTurn) {
    const what = rows.length > 1 ? `${rows.length} items, oldest first` : 'One message';
    return (
      `${SERVER_NOTE_PREFIX} ${what}, delivered into the turn you are running rather than held until it ends. ` +
      'Finish the tool call you are in the middle of, then take this into what you are doing rather than ' +
      'starting again. It may be a correction, or it may be something that can wait until you surface — read ' +
      'it and decide.' +
      (possiblySeen ? restarted : '') +
      `]\n${SERVER_NOTE_END}\n` + body
    );
  }
  const header = rows.length > 1
    ? `${SERVER_NOTE_PREFIX} ${rows.length} items arrived while you were busy, oldest first.` +
      (possiblySeen ? ' Some may have reached you before the server restarted; check your last turn before repeating work.' : '') +
      `]\n${SERVER_NOTE_END}\n`
    : possiblySeen
      ? `${SERVER_NOTE_PREFIX} this message may have reached you before the server restarted; check your last turn before repeating work.]\n${SERVER_NOTE_END}\n`
      : '';
  return header + body;
}

/** Attachment blocks of a batch, in row order. Exported for the mid-turn path, which composes the same batch. */
export function readAttachments(rows: readonly InboxRow[]): unknown[] {
  const blocks: unknown[] = [];
  for (const row of rows) {
    if (!row.attachments_json) continue;
    // A corrupt payload is not quietly dropped to text: the image was the message.
    const parsed = parseJson(row.attachments_json);
    if (!Array.isArray(parsed)) throw new Error(`attachments of inbox item ${row.id} are not an array`);
    blocks.push(...(parsed as unknown[]));
  }
  return blocks;
}

/** What one drain did, for the caller that needs to say so in a receipt. */
export type DrainResult =
  | { outcome: 'delivered'; items: number; readSeq: number | null }
  /** Nothing unread. */
  | { outcome: 'nothing' }
  /** The session is inside a turn; the rows wait for its end. */
  | { outcome: 'busy'; unread: number }
  /** The send did not reach the process; the rows stay unread and the thread says so. */
  | { outcome: 'failed'; items: number; error: string };

/**
 * Send the session everything unread if it is between turns, holding its turn
 * admission. Never rejects; a failure leaves the rows unread for the next
 * turn boundary or restart. Concurrent callers queue on the admission and
 * find nothing left to send.
 */
export async function drainInbox(sessionId: string): Promise<void> {
  try {
    await withTurnAdmission(sessionId, 'drain', (admission) => drainHeld(sessionId, admission));
  } catch (err) {
    logger.error('Inbox drain threw', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One drain by a caller that already holds the session's turn admission (the
 * interrupting send, after the turn it cancelled has ended). Rejects only on
 * a programming error; delivery failures are in the result.
 */
export async function drainHeld(sessionId: string, admission: TurnAdmission): Promise<DrainResult> {
  if (admission.sessionId !== sessionId) throw new Error(`admission for ${admission.sessionId} used to drain ${sessionId}`);
  return drainOnce(sessionId, admission);
}

/** Server start: everything a previous process left unread. */
export async function drainAllInboxes(): Promise<void> {
  const reservations = resolveReservationsAtStartup();
  if (reservations.released > 0) {
    logger.info('Released inbox items a previous run had reserved but never sent', { items: reservations.released });
  }
  if (reservations.unresolved > 0) {
    logger.warn('Inbox items were mid-delivery when the previous run ended; they are held rather than re-sent', {
      items: reservations.unresolved,
    });
  }
  const stuck = uncertainInboxReservations();
  if (stuck.length > 0) {
    // Not drained and not marked read: neither the transcript nor anything
    // else here could say which. Visible in the log so it is a question
    // someone can answer rather than rows that quietly stopped moving.
    logger.warn('Inbox items are held by a delivery that was never resolved', {
      items: stuck.length,
      sessions: [...new Set(stuck.map((row) => row.session_id))],
      reservations: [...new Set(stuck.map((row) => row.reserved_by))],
    });
  }
  const sessions = sessionsWithUnreadInbox();
  if (sessions.length === 0) return;
  logger.info('Draining inboxes left from a previous run', { sessions: sessions.length });
  await Promise.all(sessions.map((sessionId) => drainInbox(sessionId)));
}

async function drainOnce(sessionId: string, admission: TurnAdmission): Promise<DrainResult> {
  const rows = unreadInboxItems(sessionId);
  if (rows.length === 0) return { outcome: 'nothing' };
  if (sessionBusy(sessionId)) {
    logger.info('Session mid-turn; inbox waits for turn end', { sessionId, unread: rows.length });
    return { outcome: 'busy', unread: rows.length };
  }
  // A message accepted as Claude's `priority: "next"` can be taken into a
  // turn after the running one ends, so the session reads idle while its
  // input is still in the provider's queue. Sending a second batch into that
  // gap would race it; this drain waits for the next turn boundary instead,
  // or for the incorporation itself, which drains again.
  if (sessionHasDeliveryInFlight(sessionId, DELIVERY_IN_FLIGHT_GRACE_MS)) {
    logger.info('A delivery to this session is still unresolved; inbox waits', { sessionId, unread: rows.length });
    return { outcome: 'busy', unread: rows.length };
  }

  const ids = rows.map((row) => row.id);
  const input = composeInboxInput(rows, latticeCli());
  let attachments: unknown[];
  try {
    attachments = readAttachments(rows);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    surfaceUndeliverable(sessionId, ids, error);
    return { outcome: 'failed', items: ids.length, error };
  }
  // The latest choice wins, as it would have if each message had been sent on its own.
  const model = [...rows].reverse().find((row) => row.model)?.model ?? undefined;
  const reasoningEffort = [...rows].reverse().find((row) => row.reasoning_effort)?.reasoning_effort ?? undefined;

  const { host, port } = ConfigService.getInstance().getConfig().server;
  const dialHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${dialHost}:${port}/api/harness/${sessionId}/send`;

  db().prepare(`UPDATE session_inbox SET attempts = attempts + 1 WHERE id IN (${ids.map(() => '?').join(', ')})`).run(...ids);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input,
        inboxIds: ids,
        admission: admission.id,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
    });
  } catch (err) {
    // The request may have reached the route: leave the attempt counted.
    const message = err instanceof Error ? err.message : String(err);
    surfaceUndeliverable(sessionId, ids, message);
    return { outcome: 'failed', items: ids.length, error: message };
  }
  const body = await res.text();
  if (!res.ok) {
    // The route answered, so nothing reached the process: the attempt does not count.
    db().prepare(`UPDATE session_inbox SET attempts = attempts - 1 WHERE id IN (${ids.map(() => '?').join(', ')})`).run(...ids);
    const error = `${res.status} ${body}`;
    surfaceUndeliverable(sessionId, ids, error);
    return { outcome: 'failed', items: ids.length, error };
  }
  const parsed = parseJson(body) as { readSeq?: number } | null;
  const readSeq = typeof parsed?.readSeq === 'number' ? parsed.readSeq : null;
  markInboxItemsRead(ids, readSeq);
  logger.info('Inbox drained into a turn', {
    sessionId,
    items: rows.length,
    sources: rows.map((row) => row.source),
    chars: input.length,
  });
  return { outcome: 'delivered', items: rows.length, readSeq };
}

function surfaceUndeliverable(sessionId: string, ids: string[], error: string): void {
  db().prepare(`UPDATE session_inbox SET last_error = ? WHERE id IN (${ids.map(() => '?').join(', ')})`).run(error, ...ids);
  logger.error('Inbox drain failed; items stay unread', { sessionId, items: ids.length, error });
  const manager = getHarnessSessionManager();
  if (manager) appendCustomHarnessEvent(manager, sessionId, INBOX_UNDELIVERABLE_EVENT, { ids, error } satisfies InboxUndeliverableData);
}
