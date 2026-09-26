/**
 * What reasoning effort a Codex conversation is running at.
 *
 * Codex applies effort per turn and remembers it inside the live thread, so a
 * conversation that stayed up kept whatever it was last given. Nothing wrote it
 * down, so every path that replaces the process — a cold `/send`, a lifecycle
 * resume, a compaction recovery — had to supply something, and supplied a
 * default. The user's choice then disappeared on exactly the restart that was
 * meant to carry it.
 *
 * The segment now holds the answer, and this module is the one place that
 * decides what it should be. Two kinds of knowledge are kept apart:
 *
 * - `segment` — an effort a Codex thread or turn was ACTUALLY started with,
 *   written by the applied-setting callback (see codex-process-adapter.ts).
 *   This is the conversation's current setting.
 * - `history` — evidence INFERRED from what somebody explicitly asked for
 *   before the column existed. It stands in for a legacy conversation that has
 *   no recorded setting, and it is never written to the segment on its own:
 *   only actually applying it makes it the current setting.
 *
 * A creation default (the coordinator's medium) belongs to new conversations
 * only. Applying one to an existing conversation cannot tell a session left on
 * its default from one the user moved by hand, which is the overwrite this module
 * exists to prevent.
 */

import { DEFAULT_CODEX_EFFORT } from '@/constants/codex-models.js';
import { DatabaseProvider } from '@/services/infrastructure/database-provider.js';
import { ConversationService } from '@/services/sessions/conversation-service.js';

/** Where a resolved effort came from, in precedence order. */
export type CodexEffortSource = 'request' | 'segment' | 'history' | 'default';

export interface ResolvedCodexEffort {
  effort: string;
  source: CodexEffortSource;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The precedence every start/resume/send/compaction path shares: what this
 * request explicitly asks for, then the setting the conversation is actually
 * running at, then legacy evidence of a choice, then the fallback.
 */
export function resolveCodexReasoningEffort(params: {
  /** An effort named by this request. Always wins — it is a fresh choice. */
  requested?: string | null;
  /** The segment's recorded current setting. */
  stored?: string | null;
  /** Legacy evidence, for a conversation that has no recorded setting. */
  inferred?: string | null;
  /** Creation default for a new conversation; the general default otherwise. */
  fallback?: string | null;
}): ResolvedCodexEffort {
  const requested = clean(params.requested);
  if (requested) return { effort: requested, source: 'request' };

  const stored = clean(params.stored);
  if (stored) return { effort: stored, source: 'segment' };

  const inferred = clean(params.inferred);
  if (inferred) return { effort: inferred, source: 'history' };

  return { effort: clean(params.fallback) ?? DEFAULT_CODEX_EFFORT, source: 'default' };
}

/**
 * The effort to put on a spawn or a send, or undefined when nothing is known.
 *
 * A bare default is not a decision. A live Codex thread keeps whatever it was
 * last given, and a send that names no effort leaves it alone — so attaching a
 * default here would move a conversation whose setting simply predates the
 * column. Leaving it off keeps the thread, or the config the harness
 * remembers, on whatever it already had.
 *
 * Creation is the exception and does not use this: for a new conversation the
 * default IS the choice, which is how a coordinator starts on medium.
 */
export function knownCodexReasoningEffort(resolved: ResolvedCodexEffort | null): string | undefined {
  return resolved && resolved.source !== 'default' ? resolved.effort : undefined;
}

/**
 * The last effort this conversation was actually DELIVERED, from the inbox
 * rows that carry a composer choice. Read directly rather than through
 * session-inbox.ts because this is a one-column historical lookup, not part of
 * inbox delivery.
 *
 * Unread rows are excluded because a parked message is a choice for a turn
 * that has not happened. Every effort-bearing row is written unread, at the
 * moment the message is parked, so without this filter a process replacement
 * in that window starts on a setting the conversation was never given — and
 * the applied-setting callback then records that as a fact. `read_at` is set
 * only after the drain's send returns, which is also when the effort is
 * applied, so a delivered row and the setting it produced agree.
 *
 * `created_at` is a whole-millisecond timestamp, so two messages sent in the
 * same tick tie; `rowid` breaks that tie toward the later insert, which is the
 * later choice.
 *
 * Only explicit choices land in these rows — `/send` stores what the body
 * carried and never substitutes a default — so this cannot resurrect a default
 * as if it were a decision. Nothing else in the old data can say what a live
 * process was moved to, which is why it is evidence and not a current setting.
 */
export function inferredCodexReasoningEffort(conversationId: string): string | null {
  const row = DatabaseProvider.getInstance().getDb().prepare(
    `SELECT reasoning_effort FROM session_inbox
     WHERE session_id = ? AND reasoning_effort IS NOT NULL AND read_at IS NOT NULL
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`
  ).get(conversationId) as { reasoning_effort?: string } | undefined;
  return clean(row?.reasoning_effort) ?? null;
}

/**
 * What an existing Codex conversation should run at now. Returns null for a
 * conversation whose latest segment is not Codex, so callers leave other
 * providers' spawn config untouched.
 *
 * Database failures are not caught here. Every caller resolves the provider
 * first, which reads the same conversation and its segments on the same
 * connection, so a read that could fail here has already failed the request —
 * catching it would only let a genuine fault look like "nothing recorded" and
 * silently move the conversation back to a remembered default, which is the
 * bug this module exists to fix.
 */
export function currentCodexReasoningEffort(
  conversationId: string,
  requested?: string | null,
): ResolvedCodexEffort | null {
  const segment = ConversationService.getInstance().getLatestSegment(conversationId);
  if (segment && segment.provider !== 'codex') return null;

  return resolveCodexReasoningEffort({
    requested,
    stored: segment?.reasoningEffort,
    inferred: segment?.reasoningEffort ? null : inferredCodexReasoningEffort(conversationId),
  });
}
