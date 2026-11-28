import type Database from 'better-sqlite3';
import { DatabaseProvider } from './database-provider.js';
import { parseJson } from '../../utils/json.js';

/** Gemini 4 Neon standard API list price in USD per million tokens, as published November 2026. */
export const GEMINI_NEON_PRICE = { input: 3, cachedInput: 0.15, output: 15 } as const;

/**
 * Antigravity turns finished before this hold agy's running session total,
 * not the turn's own calls: the per-turn sum went live with the 17:10 UTC
 * restart on 22 Nov 2026. Earlier turns are reported as not counted.
 */
const ANTIGRAVITY_PER_TURN_SINCE = Date.parse('2026-11-22T17:10:51Z');

/** The estimated API spend the header ring fills towards, and the period it is measured over. */
export const GEMINI_BUDGET = { usd: 500, days: 30 } as const;

export interface GeminiSpendWindow {
  /** Estimated USD for the turns that could be priced. */
  usd: number;
  countedTurns: number;
  /** Gemini turns in the window with no usable token counts; the estimate leaves them out. */
  uncountedTurns: number;
}

export interface GeminiSpend {
  today: GeminiSpendWindow;
  last7Days: GeminiSpendWindow;
  /** Spend over the budget period, with the budget it is measured against. */
  budget: GeminiSpendWindow & { limitUsd: number; days: number };
  checkedAt: number;
}

interface Segment { conversation_id: string; provider: string; model: string | null; created_at: string }
interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

const isGemini = (model: string | null): boolean => Boolean(model && /gemini/i.test(model));
const isNeon = (model: string | null): boolean => Boolean(model && /gemini-4-neon/i.test(model));

/** Estimated USD for one turn's tokens at Neon's list price. */
export function neonTurnUsd(usage: Usage): number {
  const fullInput = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return (fullInput * GEMINI_NEON_PRICE.input
    + (usage.cache_read_input_tokens ?? 0) * GEMINI_NEON_PRICE.cachedInput
    + (usage.output_tokens ?? 0) * GEMINI_NEON_PRICE.output) / 1_000_000;
}

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Estimates Gemini spend from the token counts Lattice stores on each turn,
 * for Antigravity sessions and Claude Code sessions pointed at a Gemini
 * endpoint. Turns without usable counts are counted, not guessed.
 */
export function estimateGeminiSpend(db: Database.Database, now: number = Date.now()): GeminiSpend {
  const todayStart = startOfToday(now);
  const DAY = 24 * 60 * 60 * 1000;
  const weekStart = now - 7 * DAY;
  const budgetStart = now - GEMINI_BUDGET.days * DAY;
  const scanStart = Math.min(weekStart, budgetStart);
  const empty = (): GeminiSpendWindow => ({ usd: 0, countedTurns: 0, uncountedTurns: 0 });
  const today = empty();
  const last7Days = empty();
  const budget = empty();

  const segments = db.prepare(
    `SELECT conversation_id, provider, model, created_at FROM conversation_segments
     WHERE conversation_id IN (SELECT conversation_id FROM conversation_segments WHERE model LIKE '%gemini%')
     ORDER BY conversation_id, created_at`,
  ).all() as Segment[];
  const byConversation = new Map<string, Segment[]>();
  for (const s of segments) byConversation.set(s.conversation_id, [...(byConversation.get(s.conversation_id) ?? []), s]);

  const turns = db.prepare(
    `SELECT timestamp, data FROM harness_events WHERE session_id = ? AND type = 'turn:end' AND timestamp >= ?`,
  );
  for (const [conversationId, convSegments] of byConversation) {
    for (const row of turns.all(conversationId, scanStart) as Array<{ timestamp: number; data: string }>) {
      const segment = [...convSegments].reverse().find((s) => Date.parse(s.created_at) <= row.timestamp) ?? convSegments[0];
      if (!isGemini(segment.model)) continue;
      const usage = (parseJson(row.data) as { usage?: Usage } | null)?.usage;
      const hasCounts = Boolean(usage && ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)) > 0);
      const reliable = hasCounts && isNeon(segment.model)
        && !(segment.provider === 'antigravity' && row.timestamp < ANTIGRAVITY_PER_TURN_SINCE);
      const windows = [
        ...(row.timestamp >= todayStart ? [today] : []),
        ...(row.timestamp >= weekStart ? [last7Days] : []),
        ...(row.timestamp >= budgetStart ? [budget] : []),
      ];
      for (const window of windows) {
        if (reliable) { window.usd += neonTurnUsd(usage!); window.countedTurns += 1; } else window.uncountedTurns += 1;
      }
    }
  }
  return { today, last7Days, budget: { ...budget, limitUsd: GEMINI_BUDGET.usd, days: GEMINI_BUDGET.days }, checkedAt: now };
}

const FRESH_MS = 2 * 60_000;
let cached: GeminiSpend | null = null;

/** The estimate, recomputed at most every two minutes. */
export function geminiSpend(now: number = Date.now()): GeminiSpend {
  if (!cached || now - cached.checkedAt >= FRESH_MS) cached = estimateGeminiSpend(DatabaseProvider.getInstance().getDb(), now);
  return cached;
}
