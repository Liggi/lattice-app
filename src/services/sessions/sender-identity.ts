/**
 * What to call the sessions that have written to a conversation. The id stays
 * the identity; this is only what it can be called on screen.
 *
 * Resolved from the data that already names a session, at read time rather
 * than stamped onto the message when it is sent: a name written at send time
 * would leave the messages already in the log unnamed, and would keep a name
 * the dispatch has since moved on from. A worker is named by the task its
 * coordinator dispatched it on, a coordinator by the outcome it is running,
 * and a session that neither describes keeps its id.
 */

import type Database from 'better-sqlite3';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { PROJECT_NOTED_EVENT } from '../../types/project-state.js';
import { getEventsVersion } from '../../session-history/repository.js';

export type SenderRole = 'worker' | 'coordinator';

export interface SenderIdentity {
  /** The task or outcome that names this session. Never a person's name. */
  name: string;
  role: SenderRole;
}

function db(): Database.Database {
  return DatabaseProvider.getInstance().getDb();
}

/**
 * The sessions that have sent an agent message to this conversation. Only the
 * distinct senders, so the lookups below run once each per request and not
 * once per message; no conversation in the log has had more than four.
 */
function sendersTo(conversationId: string): string[] {
  const rows = db().prepare(
    `SELECT DISTINCT sender FROM session_inbox
      WHERE session_id = ? AND source = 'agent' AND sender IS NOT NULL AND sender != ''`,
  ).all(conversationId) as Array<{ sender: string }>;
  return rows.map(row => row.sender);
}

/**
 * The task a session is on, from the `worker:started` its coordinator wrote
 * and any `worker:reassigned` after it. Scans the dispatch events rather than
 * one session's log, because the sender's own log is not where its task is
 * recorded. Both types carry `$.task` and the latest seq wins, so a reused
 * worker is attributed by what it is doing now rather than by the assignment
 * it finished. No index serves `$.worker`, and reading every dispatch's JSON
 * cost 2.5s a boot from a cold cache (2026-09-30), so the map is built once
 * and rebuilt only when the index count of dispatch events changes.
 */
let dispatchCache: { db: Database.Database; count: number; tasks: Map<string, string> } | null = null;

function dispatchedTasks(senders: readonly string[]): Map<string, string> {
  if (senders.length === 0) return new Map();
  const database = db();
  const { count } = database.prepare(
    `SELECT COUNT(*) AS count FROM harness_events WHERE type IN ('worker:started', 'worker:reassigned')`,
  ).get() as { count: number };
  if (dispatchCache?.db !== database || dispatchCache.count !== count) {
    const rows = database.prepare(
      `SELECT json_extract(data, '$.worker') AS worker, json_extract(data, '$.task') AS task FROM harness_events
        WHERE type IN ('worker:started', 'worker:reassigned')
        ORDER BY seq ASC`,
    ).all() as Array<{ worker: string | null; task: string | null }>;
    const latest = new Map<string, string | null>();
    for (const row of rows) if (row.worker) latest.set(row.worker, row.task);
    const tasks = new Map<string, string>();
    for (const [worker, task] of latest) {
      const trimmed = task?.trim();
      if (trimmed) tasks.set(worker, trimmed);
    }
    dispatchCache = { db: database, count, tasks };
  }
  const tasks = new Map<string, string>();
  for (const sender of senders) {
    const task = dispatchCache.tasks.get(sender);
    if (task) tasks.set(sender, task);
  }
  return tasks;
}

/**
 * The outcome a coordinator is running, which is how a coordinator is named:
 * its latest outcome note, as the project fold takes it. Read directly rather
 * than by folding the coordinator's whole log, which is a thousand events for
 * a busy one and runs on every /workers request. Kept until the sender writes
 * another note: finding the newest outcome among a thousand notes read their
 * JSON on every conversation-details request, 9s in ten minutes on 3045
 * (2026-09-30).
 */
const outcomes = new Map<string, { db: Database.Database; maxSeq: number; count: number; outcome: string | null }>();

function coordinatorOutcome(sender: string): string | null {
  const database = db();
  const version = getEventsVersion(sender, [PROJECT_NOTED_EVENT]);
  const held = outcomes.get(sender);
  if (held?.db === database && held.maxSeq === version.maxSeq && held.count === version.count) return held.outcome;
  const outcome = readCoordinatorOutcome(database, sender);
  outcomes.set(sender, { db: database, ...version, outcome });
  return outcome;
}

function readCoordinatorOutcome(database: Database.Database, sender: string): string | null {
  const row = database.prepare(
    `SELECT json_extract(data, '$.text') AS text FROM harness_events
      WHERE session_id = ? AND type = ?
        AND json_extract(data, '$.kind') = 'outcome' AND json_type(data, '$.text') = 'text'
      ORDER BY seq DESC LIMIT 1`,
  ).get(sender, PROJECT_NOTED_EVENT) as { text: string } | undefined;
  const outcome = row?.text.trim();
  return outcome ? outcome : null;
}

/**
 * Names for every session that has written to this conversation. A sender
 * that resolves to nothing — deleted, or never described — is left out, and
 * the thread shows the id it declared.
 */
export function senderIdentities(conversationId: string): Record<string, SenderIdentity> {
  const identities: Record<string, SenderIdentity> = {};
  const senders = sendersTo(conversationId);
  const tasks = dispatchedTasks(senders);
  for (const sender of senders) {
    const task = tasks.get(sender);
    if (task) {
      identities[sender] = { name: task, role: 'worker' };
      continue;
    }
    const outcome = coordinatorOutcome(sender);
    if (outcome) identities[sender] = { name: outcome, role: 'coordinator' };
  }
  return identities;
}
