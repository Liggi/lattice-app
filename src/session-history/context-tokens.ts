/**
 * A session's current context size, from the newest authoritative
 * measurement in its event log. Pure: shared by the server's compaction
 * policy and the CLI, which reads SQLite directly.
 *
 * Claude reports per-call usage on every assistant message; Codex reports
 * only per-turn usage on turn:end. Either way the context is input + cache
 * creation + cache read (input being the uncached remainder; the Codex
 * adapter splits it that way since 2026-09-19, before which its turn:end
 * input_tokens held the whole prompt and this sum over-counts old events).
 * A compaction boundary carries the post-compaction size for Claude and
 * nothing for Codex, so after a Codex compaction the size is unknown until
 * its next turn.
 */

interface UsageFields {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function sumUsage(usage: UsageFields): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

export interface UsageEventLike {
  type: string;
  data: unknown;
}

export function contextTokensOf(events: readonly UsageEventLike[], provider: string | null): number | null {
  return contextTokensNewestFirst([...events].reverse(), provider);
}

/** The same, walking events already ordered newest first; stops reading at the first measurement. */
export function contextTokensNewestFirst(events: Iterable<UsageEventLike>, provider: string | null): number | null {
  for (const event of events) {
    if (event.type === 'turn:end') {
      const data = event.data as { compact?: boolean; postTokens?: number; usage?: UsageFields } | undefined;
      if (data?.compact) return typeof data.postTokens === 'number' ? data.postTokens : null;
      // Codex reports zero usage for a turn with no completion (its own
      // compaction turn, an interrupted turn, a safety-blocked turn); that
      // is not a measurement, so keep walking to the last real one.
      if (provider === 'codex' && data?.usage && sumUsage(data.usage) > 0) return sumUsage(data.usage);
      continue;
    }
    if (event.type === 'content') {
      const usage = (event.data as { apiUsage?: UsageFields } | undefined)?.apiUsage;
      if (usage) return sumUsage(usage);
    }
  }
  return null;
}

/** "132K" / "1.2M" / "850" for display. */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
