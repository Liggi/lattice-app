/**
 * One-time migration: legacy `messages` rows → harness_events.
 *
 * The MessageStore removal (d1c99d32, Apr 2026) made harness_events the only
 * read path but left the `messages` table behind unread, so every conversation
 * that predates the cutover renders empty. The JSONL fallback that was meant to
 * cover them looks up `${conversationId}.jsonl`, and Claude Code names
 * transcripts by provider session UUID — so it can never hit.
 *
 * This migrates that history into harness_events under the conv-* key the read
 * path already uses, which lets the JSONL fallback be deleted rather than
 * repaired. Runs once, guarded by a metadata marker.
 *
 * Three sources, tried in order and only ever to fill a gap — a conversation
 * that already has events is never touched:
 *
 *   1. legacy rows keyed by conv-*                (the bulk of it)
 *   2. legacy rows keyed by a provider session ID (same history, older key)
 *   3. the Claude Code JSONL transcript           (when no legacy rows survive)
 *
 * Source 3 exists because transcript retention and legacy coverage differ per
 * machine: the machine this was built against had 1060 conversations in the
 * legacy table and zero surviving transcripts, while a colleague's had 19
 * conversations recoverable only from JSONL. Reading JSONL once here, rather
 * than on every request, keeps a single runtime read path without betting on
 * which source a given machine happens to have.
 *
 * Legacy rows are already UnifiedMessage-shaped, so that conversion is
 * UnifiedMessage → SessionEvent — the exact inverse of event-message-reader's
 * eventsToUnifiedMessages(). Keep the two in step.
 */

import type Database from 'better-sqlite3';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import type { UnifiedContentBlock, UnifiedMessage } from '../types/unified-messages.js';
import type { SqliteEventStorageAdapter } from './sqlite-event-storage.js';
import { ClaudeHistoryReader } from '../services/sessions/claude-history-reader.js';
import { createLogger } from '../services/infrastructure/logger.js';
import { parseJson } from '../utils/json.js';
import { convertMessagesToEvents } from './history-backfill.js';

const logger = createLogger('LegacyMessageMigration');

const MIGRATION_KEY = 'harness_events_backfilled_from_legacy_messages_v1';

/** JSON array of the conversation IDs this migration filled. See recordMigratedConversations. */
const MIGRATED_CONVERSATIONS_KEY = 'harness_events_backfill_v1_conversations';

/** Duplicate-input window inherited from the old dual-write pipeline. */
const DEDUP_WINDOW_MS = 5000;

interface LegacyRow {
  role: string;
  provider: string;
  timestamp: string;
  message_json: string;
  provider_message_id: string | null;
}

/**
 * Convert one conversation's legacy rows into harness SessionEvents.
 *
 * Block shapes deliberately differ from UnifiedContentBlock: the reader
 * normalizes `thinking.thinking` and snake_case tool_result fields, because
 * that is the shape the live harness emits. Matching it here means migrated
 * history and live history read back identically.
 */
export function legacyRowsToEvents(sessionId: string, rows: LegacyRow[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  const runId = `backfill-${sessionId}`;
  let seq = 1;
  let codexRunStartEmitted = false;

  const recentInputs: Array<{ text: string; timestamp: number }> = [];
  const isDuplicateInput = (text: string, ts: number): boolean => {
    for (const recent of recentInputs) {
      if (recent.text === text && Math.abs(ts - recent.timestamp) < DEDUP_WINDOW_MS) return true;
    }
    recentInputs.push({ text, timestamp: ts });
    return false;
  };

  for (const row of rows) {
    // parseJson throws on malformed input. One bad row must not abort the
    // transaction and roll back every other conversation's history.
    let message: UnifiedMessage | null;
    try {
      message = parseJson(row.message_json) as UnifiedMessage | null;
    } catch {
      continue;
    }
    if (!message || typeof message !== 'object') continue;

    const timestamp = new Date(row.timestamp).getTime();
    if (!Number.isFinite(timestamp)) continue;

    const content: UnifiedContentBlock[] = Array.isArray(message.content) ? message.content : [];

    // Provider survives only via run:start — providerFromEvent() reads nothing else.
    if (row.provider === 'codex' && !codexRunStartEmitted) {
      events.push({
        sessionId, runId, seq: seq++, timestamp,
        type: 'run:start',
        data: { config: { extra: { provider: 'codex' } } },
      } as SessionEvent);
      codexRunStartEmitted = true;
    }

    if (row.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      for (const block of content) {
        if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
        else if (block.type === 'thinking') blocks.push({ type: 'thinking', thinking: block.text });
        else if (block.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
        }
      }
      if (blocks.length === 0) continue;

      events.push({
        sessionId, runId, seq: seq++, timestamp,
        type: 'content',
        data: { blocks, messageId: row.provider_message_id ?? undefined },
      } as SessionEvent);
      continue;
    }

    if (row.role === 'user') {
      const toolResults = content
        .filter((block) => block.type === 'tool_result')
        .map((block) => ({
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: typeof block.output === 'string' ? block.output : JSON.stringify(block.output ?? ''),
          is_error: block.isError ?? false,
        }));

      if (toolResults.length > 0) {
        events.push({
          sessionId, runId, seq: seq++, timestamp,
          type: 'result',
          data: { blocks: toolResults },
        } as SessionEvent);
      }

      const attachments = content.filter((block) => block.type === 'image' || block.type === 'document');
      const text = content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      if (!text && attachments.length === 0) continue;
      if (text && isDuplicateInput(text, timestamp)) continue;

      events.push({
        sessionId, runId, seq: seq++, timestamp,
        type: 'input:sent',
        data: { text: text || undefined, blocks: attachments.length > 0 ? attachments : undefined },
      } as SessionEvent);
      continue;
    }

    // system rows have no harness event equivalent
  }

  return events;
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name)
  );
}

/** Conversations the UI would render empty: no events in storage. */
function conversationsWithoutEvents(db: Database.Database): string[] {
  if (!tableExists(db, 'conversations')) return [];
  const rows = db.prepare(`
    SELECT c.conversation_id AS id FROM conversations c
    WHERE NOT EXISTS (SELECT 1 FROM harness_events e WHERE e.session_id = c.conversation_id)
  `).all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Provider session IDs for a conversation, oldest segment first. */
function providerSessionIds(db: Database.Database, conversationId: string): string[] {
  if (!tableExists(db, 'conversation_segments')) return [];
  const rows = db.prepare(`
    SELECT provider_session_id AS id FROM conversation_segments
    WHERE conversation_id = ? AND provider_session_id IS NOT NULL AND provider_session_id != ''
    ORDER BY sequence_number ASC
  `).all(conversationId) as Array<{ id: string }>;
  // 'imported-*' segments never had a provider session and so never had a transcript.
  return rows.map((r) => r.id).filter((id) => !id.startsWith('imported-'));
}

interface MigrationStats {
  fromLegacyConversationKey: number;
  fromLegacyProviderKey: number;
  fromJsonlTranscript: number;
  eventsWritten: number;
}

/**
 * Record exactly which conversations this filled, so it can be undone.
 *
 * Deleting by run_id is not safe: the old lazy backfill used the same
 * `backfill-<sessionId>` prefix, so databases predating this migration already
 * contain such events and the prefix cannot tell them apart. An explicit list
 * can, and it is small — a few tens of KB for a thousand conversations, far
 * cheaper than copying a multi-gigabyte database to get a rollback.
 *
 * To undo: delete harness_events for these session_ids, then delete both
 * metadata keys.
 */
function recordMigratedConversations(db: Database.Database, conversationIds: string[]): void {
  db.prepare(
    'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(MIGRATED_CONVERSATIONS_KEY, JSON.stringify(conversationIds));
}

/**
 * Fill every conversation that has no events, from whichever source still has
 * its history. Safe to re-run: it only ever considers conversations with zero
 * events, so it cannot double-write or renumber an existing seq.
 */
export async function migrateLegacyHistoryToEvents(
  db: Database.Database,
  storage: SqliteEventStorageAdapter,
): Promise<void> {
  try {
    const marker = db.prepare('SELECT value FROM metadata WHERE key = ?').get(MIGRATION_KEY) as
      | { value?: string }
      | undefined;
    if (marker?.value === 'true') return;

    const stats: MigrationStats = {
      fromLegacyConversationKey: 0,
      fromLegacyProviderKey: 0,
      fromJsonlTranscript: 0,
      eventsWritten: 0,
    };

    const startedAt = Date.now();
    const hasLegacy = tableExists(db, 'messages');
    // Exactly which conversations this filled, so the migration can be undone.
    const filled: string[] = [];

    if (hasLegacy) {
      const pending = db.prepare(`
        SELECT DISTINCT m.session_id AS sessionId FROM messages m
        WHERE m.session_id LIKE 'conv-%'
          AND NOT EXISTS (SELECT 1 FROM harness_events e WHERE e.session_id = m.session_id)
      `).all() as Array<{ sessionId: string }>;

      if (pending.length > 0) {
        const pendingRows = db.prepare(`
          SELECT COUNT(*) AS count FROM messages m
          WHERE m.session_id LIKE 'conv-%'
            AND NOT EXISTS (SELECT 1 FROM harness_events e WHERE e.session_id = m.session_id)
        `).get() as { count: number };

        // Blocking, and seconds-to-tens-of-seconds on a large history. Say so,
        // or the pause reads as a hung startup.
        logger.info('Migrating pre-cutover history into harness events — startup will pause', {
          conversations: pending.length,
          legacyRows: pendingRows.count,
        });
      }

      const readByKey = db.prepare(`
        SELECT role, provider, timestamp, message_json, provider_message_id
        FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC
      `);

      // Sources 1 and 2 are pure SQLite, so they run as one transaction.
      db.transaction(() => {
        for (const { sessionId } of pending) {
          const events = legacyRowsToEvents(sessionId, readByKey.all(sessionId) as LegacyRow[]);
          if (events.length === 0) continue;
          for (const event of events) storage.write(event);
          filled.push(sessionId);
          stats.fromLegacyConversationKey++;
          stats.eventsWritten += events.length;
        }

        // Source 2: history stored under an older provider-session key. Only
        // for conversations still empty, so this cannot duplicate source 1.
        for (const conversationId of conversationsWithoutEvents(db)) {
          const rows: LegacyRow[] = [];
          for (const providerId of providerSessionIds(db, conversationId)) {
            rows.push(...(readByKey.all(providerId) as LegacyRow[]));
          }
          if (rows.length === 0) continue;

          rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          const events = legacyRowsToEvents(conversationId, rows);
          if (events.length === 0) continue;
          for (const event of events) storage.write(event);
          filled.push(conversationId);
          stats.fromLegacyProviderKey++;
          stats.eventsWritten += events.length;
        }
      })();
    }

    // Source 3: the JSONL transcript. File IO, so it runs outside the
    // transaction — each conversation is written as it is read.
    const stillEmpty = conversationsWithoutEvents(db);
    if (stillEmpty.length > 0) {
      const historyReader = new ClaudeHistoryReader();

      for (const conversationId of stillEmpty) {
        for (const providerId of providerSessionIds(db, conversationId)) {
          try {
            const { messages } = await historyReader.fetchConversationDirect(providerId);
            if (messages.length === 0) continue;

            // Keyed by conv-*, which is what the read path looks up.
            const events = convertMessagesToEvents(conversationId, messages);
            if (events.length === 0) continue;

            for (const event of events) storage.write(event);
            filled.push(conversationId);
            stats.fromJsonlTranscript++;
            stats.eventsWritten += events.length;
            break;
          } catch {
            // No transcript for this provider session — try the next segment.
          }
        }
      }
    }

    // Anything left has no history in any store. Report it rather than
    // rendering a silent empty chat.
    const residual = conversationsWithoutEvents(db).length;
    if (residual > 0) {
      logger.warn('Conversations still have no history after migration', {
        conversations: residual,
        detail: 'no legacy rows and no transcript — nothing left to recover from',
      });
    }

    recordMigratedConversations(db, filled);
    setMarker(db);

    if (stats.eventsWritten > 0 || residual > 0) {
      logger.info('Migrated pre-cutover history into harness events', {
        ...stats,
        conversationsStillEmpty: residual,
        elapsedMs: Date.now() - startedAt,
      });
    }
  } catch (err) {
    // A failed migration must not block startup. The marker stays unset so the
    // next boot retries; conversations render empty until it succeeds.
    logger.error('History migration failed — pre-cutover history will not render', err);
  }
}

function setMarker(db: Database.Database): void {
  db.prepare(
    'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(MIGRATION_KEY, 'true');
}
