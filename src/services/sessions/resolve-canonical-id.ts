/**
 * Resolve any session/conversation ID to the canonical conv-* form.
 *
 * Legacy sessions (pre-conversation model) stored a CLI session UUID as the
 * primary key. The sessions table has a `conversation_id` column that links
 * those UUIDs to their canonical conv-* ID. This function performs that lookup.
 *
 * Pure lookup — no side effects, no domain logic.
 */

import type Database from 'better-sqlite3';

/**
 * Compiled lookup, cached per database handle.
 *
 * better-sqlite3 statements are bound to the connection that prepared them, so
 * the cache is keyed by handle and does not outlive it. Without this every
 * call re-compiled the same SQL, and this runs on hot list and insight paths.
 *
 * A prepare failure is deliberately not cached: the sessions table can be
 * absent during early init, and the next call should retry.
 */
const lookupStatements = new WeakMap<Database.Database, Database.Statement>();

function getLookupStatement(db: Database.Database): Database.Statement {
  const cached = lookupStatements.get(db);
  if (cached) return cached;

  const stmt = db.prepare(`
    SELECT conversation_id
    FROM sessions
    WHERE session_id = ?
    LIMIT 1
  `);
  lookupStatements.set(db, stmt);
  return stmt;
}

/**
 * Resolve an ID to its canonical conversation ID (conv-*).
 *
 * 1. If already conv-*, return as-is.
 * 2. Look up sessions.conversation_id for the given session_id (legacy link).
 * 3. Return the input unchanged if no mapping exists.
 */
export function resolveCanonicalId(db: Database.Database, id: string): string {
  if (!id || id.startsWith('conv-')) return id;

  try {
    const direct = getLookupStatement(db).get(id) as { conversation_id?: string | null } | undefined;
    const linkedConversationId = direct?.conversation_id?.trim();
    if (linkedConversationId) {
      return linkedConversationId;
    }
  } catch {
    // sessions table may be unavailable during early init.
  }

  return id;
}
