/**
 * backfillMissing runs on every sidebar list fetch. Its only guard used to be
 * in-flight dedup, so a conversation that structurally never produces a
 * mission re-triggered a real LLM call on every single list request, with the
 * error swallowed by `.catch(() => {})`.
 *
 * The engine's constructor opens the real session DB, so these tests build an
 * instance off the prototype and inject only what backfillMissing touches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setGenerationOverridesForTests } from '@/services/infrastructure/generation-gates.js';
import { InsightsEngine } from '../../src/services/insights/insights-engine.js';
import type { SessionInsights } from '../../src/services/insights/insights-engine.js';

/** Let the fire-and-forget chain inside backfillMissing settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function insightsWithMission(sessionId: string): SessionInsights {
  return {
    sessionId,
    context: { mission: 'Fix the thing' },
    tags: null,
    theme: null,
  } as SessionInsights;
}

interface Harness {
  engine: InsightsEngine;
  recompute: ReturnType<typeof vi.fn>;
  getCached: ReturnType<typeof vi.fn>;
  warnings: Array<{ message: string; meta: unknown }>;
  cooldowns: Map<string, number>;
  /** What getCachedInsightsForSessions will report for each id. */
  cache: Map<string, SessionInsights>;
}

function buildHarness(): Harness {
  const engine = Object.create(InsightsEngine.prototype) as InsightsEngine;
  const warnings: Array<{ message: string; meta: unknown }> = [];
  const cache = new Map<string, SessionInsights>();
  const cooldowns = new Map<string, number>();

  const getCached = vi.fn(async (ids: string[]) => {
    const out = new Map<string, SessionInsights>();
    for (const id of ids) {
      const hit = cache.get(id);
      if (hit) out.set(id, hit);
    }
    return out;
  });
  const recompute = vi.fn(async () => 0);

  Object.assign(engine, {
    logger: {
      warn: (message: string, meta: unknown) => warnings.push({ message, meta }),
      info: () => {},
      debug: () => {},
      error: () => {},
    },
    backfillInFlight: new Set<string>(),
    backfillCooldownUntil: cooldowns,
    getCachedInsightsForSessions: getCached,
    recomputeStaleInsights: recompute,
  });

  return { engine, recompute, getCached, warnings, cooldowns, cache };
}

describe('InsightsEngine.backfillMissing failure memory', () => {
  let h: Harness;

  beforeEach(() => {
    // Insight generation is opt-in at runtime (config `generation.insights`,
    // off by default). This suite drives backfillMissing directly, so it opts
    // in explicitly rather than the gate being loosened for it.
    __setGenerationOverridesForTests({ insights: true });
    h = buildHarness();
  });

  afterEach(() => { __setGenerationOverridesForTests(null); });

  it('computes once for a conversation with no mission', async () => {
    await h.engine.backfillMissing(['conv-a']);
    await flush();

    expect(h.recompute).toHaveBeenCalledTimes(1);
    expect(h.recompute).toHaveBeenCalledWith(['conv-a'], 2);
  });

  it('does not recompute a conversation that produced no mission last time', async () => {
    await h.engine.backfillMissing(['conv-a']);
    await flush();
    expect(h.recompute).toHaveBeenCalledTimes(1);

    // Three more sidebar list fetches — the old code fired an LLM call on each.
    await h.engine.backfillMissing(['conv-a']);
    await flush();
    await h.engine.backfillMissing(['conv-a']);
    await flush();
    await h.engine.backfillMissing(['conv-a']);
    await flush();

    expect(h.recompute).toHaveBeenCalledTimes(1);
    expect(h.cooldowns.get('conv-a')).toBeGreaterThan(Date.now());
  });

  it('logs the empty compute at warn instead of swallowing it', async () => {
    await h.engine.backfillMissing(['conv-a']);
    await flush();

    const warning = h.warnings.find(w => w.message.includes('produced no mission'));
    expect(warning).toBeDefined();
    expect(warning?.meta).toMatchObject({ count: 1, conversationIds: ['conv-a'] });
  });

  it('backs off and warns when the recompute itself rejects', async () => {
    h.recompute.mockRejectedValueOnce(new Error('anthropic 529'));

    await h.engine.backfillMissing(['conv-a']);
    await flush();

    const warning = h.warnings.find(w => w.message === 'Mission backfill failed');
    expect(warning?.meta).toMatchObject({ count: 1, error: 'anthropic 529' });
    expect(h.cooldowns.get('conv-a')).toBeGreaterThan(Date.now());

    await h.engine.backfillMissing(['conv-a']);
    await flush();
    expect(h.recompute).toHaveBeenCalledTimes(1);
  });

  it('retries once the cooldown has expired', async () => {
    await h.engine.backfillMissing(['conv-a']);
    await flush();
    expect(h.recompute).toHaveBeenCalledTimes(1);

    h.cooldowns.set('conv-a', Date.now() - 1);

    await h.engine.backfillMissing(['conv-a']);
    await flush();
    expect(h.recompute).toHaveBeenCalledTimes(2);
  });

  it('sets no cooldown when the compute does produce a mission', async () => {
    h.recompute.mockImplementationOnce(async (ids: string[]) => {
      for (const id of ids) h.cache.set(id, insightsWithMission(id));
      return ids.length;
    });

    await h.engine.backfillMissing(['conv-a']);
    await flush();

    expect(h.cooldowns.has('conv-a')).toBe(false);
    expect(h.warnings).toEqual([]);

    // Next list fetch sees the mission and skips the conversation entirely.
    await h.engine.backfillMissing(['conv-a']);
    await flush();
    expect(h.recompute).toHaveBeenCalledTimes(1);
  });

  it('clears an existing cooldown as soon as a mission appears', async () => {
    await h.engine.backfillMissing(['conv-a']);
    await flush();
    expect(h.cooldowns.has('conv-a')).toBe(true);

    h.cache.set('conv-a', insightsWithMission('conv-a'));
    await h.engine.backfillMissing(['conv-a']);
    await flush();

    expect(h.cooldowns.has('conv-a')).toBe(false);
    expect(h.recompute).toHaveBeenCalledTimes(1);
  });

  it('backs off only the conversations that stayed missing', async () => {
    h.recompute.mockImplementationOnce(async () => {
      h.cache.set('conv-good', insightsWithMission('conv-good'));
      return 1;
    });

    await h.engine.backfillMissing(['conv-good', 'conv-bad']);
    await flush();

    expect(h.cooldowns.has('conv-good')).toBe(false);
    expect(h.cooldowns.has('conv-bad')).toBe(true);

    await h.engine.backfillMissing(['conv-good', 'conv-bad']);
    await flush();
    expect(h.recompute).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight key after the outcome is recorded', async () => {
    await h.engine.backfillMissing(['conv-a']);
    await flush();

    const inFlight = (h.engine as unknown as { backfillInFlight: Set<string> }).backfillInFlight;
    expect(inFlight.size).toBe(0);
  });
});
