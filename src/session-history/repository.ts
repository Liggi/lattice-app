/**
 * Read path over `~/.lattice/session-info.db` for the CLI + HTTP browsing surface.
 *
 * Direct SQLite reads via DatabaseProvider — does NOT go through the harness
 * SessionManager or EventLog. Safe to call when the server is offline.
 */

import type Database from 'better-sqlite3';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { SESSION_TYPE_INDEX } from '../harness/sqlite-event-storage.js';
import { DatabaseProvider } from '../services/infrastructure/database-provider.js';
import { parseJson } from '../utils/json.js';
import type {
  RawEvent,
  SessionCategories,
  SessionListItem,
  SessionMetadata,
  SessionSummaryRow,
} from './types.js';

function getDb(): Database.Database {
  return DatabaseProvider.getInstance().getDb();
}

function rowToEvent(row: Record<string, unknown>): RawEvent {
  return {
    conversationId: row.session_id as string,
    seq: row.seq as number,
    runId: row.run_id as string,
    timestamp: row.timestamp as number,
    type: row.type as RawEvent['type'],
    data: parseJson(row.data as string),
    meta: row.meta ? parseJson(row.meta as string) : null,
  };
}

function parseTagList(raw: string | null): string[] {
  if (!raw) return [];
  const parsed = parseJson(raw);
  if (Array.isArray(parsed)) {
    return parsed.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

function rowToSummary(row: Record<string, unknown> | undefined): SessionSummaryRow | null {
  if (!row) return null;
  return {
    conversationId: row.session_id as string,
    project: (row.project as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    notable: (row.notable as string | null) ?? null,
    tags: parseTagList((row.tags as string | null) ?? null),
    filesTouched: parseTagList((row.files_touched as string | null) ?? null),
    eventCount: (row.event_count as number | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
    status: (row.status as string) ?? 'unknown',
    generatorModel: (row.generator_model as string | null) ?? null,
    generatedAt: (row.generated_at as string | null) ?? null,
  };
}

/**
 * Real last-activity time for a conversation: the newest harness event.
 *
 * `conversations.updated_at` is a write clock that only moves on the legacy
 * /resume route and on segment changes, so on 1458 of 1997 conversations here
 * it still equals `created_at` — sorting or dating by it shows creation time
 * and buries sessions worked on today. Same call the conversation list
 * (conversation-service) and the auto-archive sweep already make.
 */
export function getLastActivityAt(conversationId: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT MAX(timestamp) AS ms FROM harness_events WHERE session_id = ?`)
    .get(conversationId) as { ms: number | null } | undefined;
  return row?.ms ? new Date(row.ms).toISOString() : null;
}

/**
 * Model this session last ran on. `run:ready` carries it for sessions launched
 * since the harness started recording it (902 of 1997 here); older ones only
 * have it on their content events, hence the fallback.
 */
export function getLatestModel(conversationId: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(
         (SELECT json_extract(e.data, '$.model') FROM harness_events e
           WHERE e.session_id = ? AND e.type = 'run:ready'
           ORDER BY e.seq DESC LIMIT 1),
         (SELECT json_extract(e.data, '$.model') FROM harness_events e
           WHERE e.session_id = ? AND e.type = 'content'
           ORDER BY e.seq DESC LIMIT 1)
       ) AS model`,
    )
    .get(conversationId, conversationId) as { model: string | null } | undefined;
  return row?.model ?? null;
}

/**
 * Whether we know anything at all about this id. Used to fail honestly instead
 * of printing an empty projection for a typo'd conversation id: an id with
 * events but no rows is still real (event-only imports), an id with neither is
 * not.
 */
export function conversationExists(conversationId: string): boolean {
  if (getSessionMetadata(conversationId) !== null) return true;
  return getEventCount(conversationId) > 0;
}

/** Insight categories for a session, when the insights engine has written them. */
export function getSessionCategories(conversationId: string): SessionCategories | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT categories, theme FROM session_insights WHERE session_id = ? LIMIT 1`)
    .get(conversationId) as { categories: string | null; theme: string | null } | undefined;
  if (!row) return null;
  const parsed = row.categories ? (parseJson(row.categories) as unknown) : null;
  const primary =
    parsed && typeof parsed === 'object' && 'primary' in parsed
      ? String((parsed as { primary: unknown }).primary)
      : null;
  const secondaryRaw =
    parsed && typeof parsed === 'object' && 'secondary' in parsed
      ? (parsed as { secondary: unknown }).secondary
      : null;
  const secondary = Array.isArray(secondaryRaw)
    ? secondaryRaw.filter((v): v is string => typeof v === 'string')
    : [];
  if (!primary && !row.theme) return null;
  return { primary, secondary, theme: row.theme ?? null };
}

export function getSessionMetadata(conversationId: string): SessionMetadata | null {
  const db = getDb();

  const sessionRow = db
    .prepare(
      `SELECT session_id, conversation_id, custom_name, workspace, archived, created_at, updated_at
       FROM sessions
       WHERE session_id = ? OR conversation_id = ?
       LIMIT 1`,
    )
    .get(conversationId, conversationId) as Record<string, unknown> | undefined;

  const convRow = db
    .prepare(
      `SELECT conversation_id, working_directory, latest_provider, created_at, updated_at, initial_prompt, picked_up_from
       FROM conversations
       WHERE conversation_id = ?
       LIMIT 1`,
    )
    .get(conversationId) as Record<string, unknown> | undefined;

  if (!sessionRow && !convRow) {
    return null;
  }

  return {
    conversationId,
    customName: (sessionRow?.custom_name as string | null) || null,
    workspace: (sessionRow?.workspace as string | null) || null,
    archived: ((sessionRow?.archived as number | undefined) ?? 0) === 1,
    createdAt:
      (sessionRow?.created_at as string | null) ||
      (convRow?.created_at as string | null) ||
      null,
    updatedAt:
      (sessionRow?.updated_at as string | null) ||
      (convRow?.updated_at as string | null) ||
      null,
    initialPrompt: (convRow?.initial_prompt as string | null) || null,
    workingDirectory: (convRow?.working_directory as string | null) || null,
    latestProvider: (convRow?.latest_provider as string | null) || null,
    pickedUpFrom: (convRow?.picked_up_from as string | null) || null,
    lastActivityAt: getLastActivityAt(conversationId),
    model: getLatestModel(conversationId),
  };
}

/**
 * The status-bearing tail of a session's log, in the same shape and window the
 * server's /api/sessions/status endpoint uses. Same events in, same
 * `deriveSessionStatusFromEvents` out — the CLI must not invent a second
 * opinion about whether a session is running.
 */
const STATUS_WINDOW_EVENT_TYPES = [
  'run:end',
  'run:error',
  'turn:end',
  'stop:requested',
  'content',
  'result',
  'input:sent',
  'run:ready',
  'run:start',
  'task:started',
  'task:updated',
  'task:notification',
  'input:incorporated',
] as const;

export function getStatusWindow(conversationId: string, limit = 200): SessionEvent[] {
  const db = getDb();
  const placeholders = STATUS_WINDOW_EVENT_TYPES.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM harness_events
        WHERE session_id = ? AND type IN (${placeholders})
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(conversationId, ...STATUS_WINDOW_EVENT_TYPES, limit) as Array<Record<string, unknown>>;
  rows.reverse();
  return rows.map((row) => {
    const event: SessionEvent = {
      sessionId: row.session_id as string,
      runId: row.run_id as string,
      seq: row.seq as number,
      timestamp: row.timestamp as number,
      type: row.type as SessionEvent['type'],
      data: parseJson(row.data as string) as SessionEvent['data'],
    };
    if (row.meta) event.meta = parseJson(row.meta as string) as SessionEvent['meta'];
    return event;
  });
}

export function getSessionSummary(conversationId: string): SessionSummaryRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM session_summaries WHERE session_id = ? LIMIT 1`)
    .get(conversationId) as Record<string, unknown> | undefined;
  return rowToSummary(row);
}

export interface ListOptions {
  limit?: number;
  includeArchived?: boolean;
  onlyArchived?: boolean;
  project?: string;
  tag?: string;
  /** Epoch ms floor on *last activity*, not on creation time. */
  sinceMs?: number;
  /** Restrict to these conversations, keeping the normal ordering. */
  conversationIds?: ReadonlyArray<string>;
}

/**
 * Builds the list query. Split out from `listSessions` because the ordering,
 * the activity date and the `--since` filter all hang on the same last-event
 * subquery, and keeping them in one place is what stops them disagreeing.
 */
function buildListQuery(opts: ListOptions = {}): { sql: string; params: unknown[] } {
  const limit = opts.limit ?? 30;

  // Conversations are the canonical browse axis. Left-join summaries + sessions
  // so unsummarized / pre-summary entries still appear.
  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (opts.onlyArchived) {
    whereClauses.push(`COALESCE(cs.archived, 0) = 1`);
  } else if (!opts.includeArchived) {
    whereClauses.push(`COALESCE(cs.archived, 0) = 0`);
  }

  if (opts.project) {
    whereClauses.push(`ss.project = ?`);
    params.push(opts.project);
  }

  if (opts.tag) {
    whereClauses.push(`ss.tags LIKE ?`);
    params.push(`%"${opts.tag}"%`);
  }

  if (opts.conversationIds) {
    if (opts.conversationIds.length === 0) return { sql: 'SELECT 1 WHERE 0', params: [] };
    whereClauses.push(`c.conversation_id IN (${opts.conversationIds.map(() => '?').join(', ')})`);
    params.push(...opts.conversationIds);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Filter on the same expression we sort by, and do it in SQL. Filtering in JS
  // after the LIMIT would answer "of the 30 newest, which are from today"
  // instead of "which sessions are from today".
  const outerClauses: string[] = [];
  const outerParams: unknown[] = [];
  if (opts.sinceMs !== undefined) {
    outerClauses.push(`activity_ms >= ?`);
    outerParams.push(opts.sinceMs);
  }
  const outerWhereSql = outerClauses.length > 0 ? `WHERE ${outerClauses.join(' AND ')}` : '';

  // A conversation can have multiple sessions rows (different runs, branches).
  // Pick the canonical one: prefer session_id = conv_id (legacy/simple case),
  // otherwise the most recently updated session for this conversation.
  const sql = `
    WITH canonical_session AS (
      SELECT s.*,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(s.conversation_id, s.session_id)
               ORDER BY (CASE WHEN s.session_id = COALESCE(s.conversation_id, s.session_id) THEN 0 ELSE 1 END),
                        s.updated_at DESC
             ) AS rn
      FROM sessions s
    ),
    base AS (
      SELECT c.conversation_id,
             cs.custom_name,
             COALESCE(cs.archived, 0) AS archived,
             c.created_at,
             c.updated_at,
             (SELECT COUNT(*) FROM harness_events he WHERE he.session_id = c.conversation_id) AS event_count,
             (SELECT MAX(he.timestamp) FROM harness_events he WHERE he.session_id = c.conversation_id) AS last_event_ms,
             COALESCE(
               (SELECT json_extract(e.data, '$.model') FROM harness_events e
                 WHERE e.session_id = c.conversation_id AND e.type = 'run:ready'
                 ORDER BY e.seq DESC LIMIT 1),
               (SELECT json_extract(e.data, '$.model') FROM harness_events e
                 WHERE e.session_id = c.conversation_id AND e.type = 'content'
                 ORDER BY e.seq DESC LIMIT 1)
             ) AS model,
             ss.session_id AS summary_session_id,
             ss.project, ss.title, ss.summary, ss.notable, ss.tags, ss.files_touched,
             ss.event_count AS summary_event_count, ss.started_at, ss.ended_at,
             ss.status, ss.generator_model, ss.generated_at
      FROM conversations c
      LEFT JOIN canonical_session cs
        ON (cs.conversation_id = c.conversation_id OR cs.session_id = c.conversation_id)
        AND cs.rn = 1
      LEFT JOIN session_summaries ss ON ss.session_id = c.conversation_id
      ${whereSql}
    )
    SELECT *,
           COALESCE(
             last_event_ms,
             CAST(strftime('%s', updated_at) AS INTEGER) * 1000,
             CAST(strftime('%s', created_at) AS INTEGER) * 1000
           ) AS activity_ms
    FROM base
    ${outerWhereSql}
    ORDER BY activity_ms DESC
    LIMIT ?
  `;

  return { sql, params: [...params, ...outerParams, limit] };
}

function rowToListItem(row: Record<string, unknown>): SessionListItem {
  const lastEventMs = row.last_event_ms as number | null;
  return {
    conversationId: row.conversation_id as string,
    customName: (row.custom_name as string | null) || null,
    archived: ((row.archived as number) ?? 0) === 1,
    createdAt: (row.created_at as string | null) || null,
    updatedAt: (row.updated_at as string | null) || null,
    lastActivityAt: lastEventMs ? new Date(lastEventMs).toISOString() : null,
    model: (row.model as string | null) || null,
    eventCount: (row.event_count as number) ?? 0,
    summary: row.summary_session_id
      ? rowToSummary({
          session_id: row.summary_session_id,
          project: row.project,
          title: row.title,
          summary: row.summary,
          notable: row.notable,
          tags: row.tags,
          files_touched: row.files_touched,
          event_count: row.summary_event_count,
          started_at: row.started_at,
          ended_at: row.ended_at,
          status: row.status,
          generator_model: row.generator_model,
          generated_at: row.generated_at,
        })
      : null,
  };
}

export function listSessions(opts: ListOptions = {}): SessionListItem[] {
  const { sql, params } = buildListQuery(opts);
  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToListItem);
}

export interface SearchOptions {
  limit?: number;
  project?: string;
}

export interface SessionSearchHit {
  item: SessionListItem;
  /** Which field matched (a summary field, or `prompt`: the session's first message), and the text around the match. */
  field: 'title' | 'summary' | 'notable' | 'tags' | 'project' | 'prompt';
  excerpt: string;
}

/**
 * Head room for the SQL prefilter: it matches `tags` as raw JSON, so it can
 * return rows the JS matcher then rejects (a query hitting only JSON syntax).
 */
const SEARCH_CANDIDATE_SLACK = 4;

/**
 * Case-insensitive substring search over each session's first message and its
 * written summary (title, summary, notable, tags, project), archived included.
 * The first message is what finds a session on installs that write no summaries.
 *
 * Shared with GET /api/sessions/history-search so the CLI and the HTTP surface
 * cannot drift on what "search" means.
 *
 * Two steps on purpose: SQL narrows to matching sessions and orders them by
 * last activity, and only the survivors get hydrated into list items. Filtering
 * hydrated rows instead meant computing an event count, a last-event time and a
 * model for all 1997 conversations on every search — 8.9s wall for three hits.
 */
export function searchSessions(query: string, opts: SearchOptions = {}): SessionSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? 30;

  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const projectClause = opts.project ? ' AND ss.project = ?' : '';
  const candidateRows = getDb()
    .prepare(
      `SELECT c.conversation_id AS id, c.initial_prompt AS prompt,
              (SELECT MAX(he.timestamp) FROM harness_events he WHERE he.session_id = c.conversation_id) AS last_event_ms
         FROM conversations c
         LEFT JOIN session_summaries ss ON ss.session_id = c.conversation_id
        WHERE (
              lower(COALESCE(ss.title, '')) LIKE ? ESCAPE '\\'
           OR lower(COALESCE(ss.summary, '')) LIKE ? ESCAPE '\\'
           OR lower(COALESCE(ss.notable, '')) LIKE ? ESCAPE '\\'
           OR lower(COALESCE(ss.project, '')) LIKE ? ESCAPE '\\'
           OR lower(COALESCE(ss.tags, '')) LIKE ? ESCAPE '\\'
           OR lower(COALESCE(c.initial_prompt, '')) LIKE ? ESCAPE '\\'
        )${projectClause}
        ORDER BY COALESCE(last_event_ms, CAST(strftime('%s', c.created_at) AS INTEGER) * 1000) DESC
        LIMIT ?`,
    )
    .all(
      like,
      like,
      like,
      like,
      like,
      like,
      ...(opts.project ? [opts.project] : []),
      limit * SEARCH_CANDIDATE_SLACK,
    ) as Array<{ id: string; prompt: string | null }>;

  if (candidateRows.length === 0) return [];

  const items = listSessions({
    limit: candidateRows.length,
    includeArchived: true,
    conversationIds: candidateRows.map((r) => r.id),
  });

  const prompts = new Map(candidateRows.map((r) => [r.id, r.prompt]));
  const hits: SessionSearchHit[] = [];
  for (const item of items) {
    const prompt = prompts.get(item.conversationId);
    const match = (item.summary && matchSummary(item.summary, q))
      || (prompt?.toLowerCase().includes(q) ? { field: 'prompt' as const, excerpt: excerptAround(prompt, q) } : null);
    if (!match) continue;
    hits.push({ item, ...match });
    if (hits.length >= limit) break;
  }
  return hits;
}

function matchSummary(
  s: SessionSummaryRow,
  q: string,
): { field: SessionSearchHit['field']; excerpt: string } | null {
  const fields: Array<[SessionSearchHit['field'], string | null]> = [
    ['title', s.title],
    ['summary', s.summary],
    ['notable', s.notable],
    ['project', s.project],
  ];
  for (const [field, value] of fields) {
    if (value && value.toLowerCase().includes(q)) {
      return { field, excerpt: excerptAround(value, q) };
    }
  }
  const tag = s.tags.find((t) => t.toLowerCase().includes(q));
  if (tag) return { field: 'tags', excerpt: s.tags.join(', ') };
  return null;
}

function excerptAround(text: string, q: string, around = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const idx = flat.toLowerCase().indexOf(q);
  if (idx < 0) return flat.slice(0, around * 2);
  const start = Math.max(0, idx - around);
  const end = Math.min(flat.length, idx + q.length + around);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/**
 * The seqs of a session's events of these types, for `seq IN (...)`. The
 * covering type index finds them without reading `data`, and the primary key
 * then reads just those rows, in seq order. Left to the planner, a filter on
 * several types walks the whole session instead: its statistics average ~200
 * events a session, and a coordinator has 30,000, so the decision read took
 * 8-10s from a cold cache (2026-09-30).
 */
export function seqsOfTypes(where: string, types: ReadonlyArray<string>): string {
  return `SELECT seq FROM harness_events INDEXED BY ${SESSION_TYPE_INDEX} WHERE ${where} AND type IN (${types.map(() => '?').join(',')})`;
}

export interface EventQueryOptions {
  fromSeq?: number;
  toSeq?: number;
  types?: ReadonlyArray<string>;
}

export function getEvents(conversationId: string, opts: EventQueryOptions = {}): RawEvent[] {
  const db = getDb();

  const clauses: string[] = ['session_id = ?'];
  const params: unknown[] = [conversationId];

  if (opts.fromSeq !== undefined) {
    clauses.push('seq >= ?');
    params.push(opts.fromSeq);
  }
  if (opts.toSeq !== undefined) {
    clauses.push('seq <= ?');
    params.push(opts.toSeq);
  }

  const sql = opts.types && opts.types.length > 0
    ? `SELECT * FROM harness_events WHERE session_id = ? AND seq IN (${seqsOfTypes(clauses.join(' AND '), opts.types)}) ORDER BY seq ASC`
    : `SELECT * FROM harness_events WHERE ${clauses.join(' AND ')} ORDER BY seq ASC`;
  const args = opts.types && opts.types.length > 0 ? [conversationId, ...params, ...opts.types] : params;
  const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  return rows.map(rowToEvent);
}

/** The newest seq and the number of events of these types: what a fold over them depends on. */
export function getEventsVersion(conversationId: string, types: ReadonlyArray<string>): { maxSeq: number; count: number } {
  const row = getDb().prepare(
    `SELECT MAX(seq) AS maxSeq, COUNT(*) AS count FROM harness_events
      WHERE session_id = ? AND type IN (${types.map(() => '?').join(',')})`,
  ).get(conversationId, ...types) as { maxSeq: number | null; count: number };
  return { maxSeq: row.maxSeq ?? 0, count: row.count };
}

/** Events of the given types, newest first, read lazily so a caller that stops early parses only what it read. */
export function* iterateEventsNewestFirst(conversationId: string, types: readonly string[]): Generator<RawEvent> {
  const rows = getDb()
    .prepare(`SELECT * FROM harness_events WHERE session_id = ? AND seq IN (${seqsOfTypes('session_id = ?', types)}) ORDER BY seq DESC`)
    .iterate(conversationId, conversationId, ...types) as IterableIterator<Record<string, unknown>>;
  for (const row of rows) yield rowToEvent(row);
}

export function getEvent(conversationId: string, seq: number): RawEvent | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM harness_events WHERE session_id = ? AND seq = ? LIMIT 1`)
    .get(conversationId, seq) as Record<string, unknown> | undefined;
  return row ? rowToEvent(row) : null;
}

export function getEventCount(conversationId: string): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM harness_events WHERE session_id = ?`)
    .get(conversationId) as { n: number };
  return row.n;
}

export function getEventTypeCounts(conversationId: string): Record<string, number> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM harness_events WHERE session_id = ? GROUP BY type`,
    )
    .all(conversationId) as Array<{ type: string; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.type] = row.n;
  return out;
}

/**
 * Returns whether the row was changed. Unarchiving also records the session as
 * an ordinary one if nobody had recorded what it was: asking to see a session
 * is the statement that it was not meant to stay hidden, and it is the only
 * thing that resolves an unknown. Archiving leaves that record alone.
 */
export function setArchived(conversationId: string, archived: boolean): boolean {
  const db = getDb();
  // Sessions table may key by session_id (legacy) or conversation_id (newer).
  // Update wherever it's found.
  const result = db
    .prepare(
      `UPDATE sessions
          SET archived = ?,
              created_hidden = CASE WHEN ? = 0 AND created_hidden IS NULL THEN 0 ELSE created_hidden END,
              updated_at = datetime('now')
       WHERE session_id = ? OR conversation_id = ?`,
    )
    .run(archived ? 1 : 0, archived ? 1 : 0, conversationId, conversationId);
  return result.changes > 0;
}

/**
 * Clear the archive flag on a worker whose coordinator has just sent it more
 * work, so its card is in front of the user again while it runs. Only a session
 * recorded as created in the open is reopened: a fixture stays hidden, and so
 * does a session nobody recorded, which an unarchive resolves. Returns whether
 * it changed.
 */
export function reopenArchivedWorker(conversationId: string): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE sessions SET archived = 0, updated_at = datetime('now')
       WHERE (session_id = ? OR conversation_id = ?) AND archived = 1 AND created_hidden = 0`,
    )
    .run(conversationId, conversationId);
  return result.changes > 0;
}
