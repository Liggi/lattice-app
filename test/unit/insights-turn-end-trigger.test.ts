/**
 * When a turn end names a session. It used to re-run on every new user
 * message, which in long sessions cycled the title through synonyms (107 calls
 * in a day for one coordinator), and to retry at once on every turn end after
 * a failure (589 attempts while the ChatGPT plan was paused, 2026-10-01).
 *
 * As in insights-backfill-backoff.test.ts, the engine is built off the
 * prototype with only what the turn-end path touches injected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setGenerationOverridesForTests } from '@/services/infrastructure/generation-gates.js';
import { anthropicService, isRetryableError } from '../../src/services/insights/anthropic-service.js';
import { InsightsEngine, namingDue } from '../../src/services/insights/insights-engine.js';
import { PlanError } from '../../src/services/infrastructure/chatgpt-plan-auth.js';

describe('namingDue', () => {
  it('waits for the second user message, or a worker brief', () => {
    expect(namingDue(null, 1, false)).toBe(false);
    expect(namingDue(null, 2, false)).toBe(true);
    expect(namingDue(null, 0, true)).toBe(true);
  });

  it('runs again only on reaching 4, 8, 16 and so on', () => {
    const due = [3, 4, 5, 7, 8, 9, 16].filter((count) => namingDue(2, count, false));
    expect(due).toEqual([4, 5, 7, 8, 9, 16]);
    expect([5, 6, 7, 8].filter((count) => namingDue(4, count, false))).toEqual([8]);
    // A long session named at 211 messages waits for 256.
    expect(namingDue(211, 255, false)).toBe(false);
    expect(namingDue(211, 256, false)).toBe(true);
  });

  it('treats a brief-only run as no milestone reached', () => {
    expect(namingDue(0, 1, true)).toBe(false);
    expect(namingDue(0, 2, true)).toBe(true);
  });
});

describe('isRetryableError', () => {
  it('does not retry a ChatGPT plan at its usage limit', () => {
    expect(isRetryableError(new PlanError('subscription_sharing_usage_limit_exceeded', 429))).toBe(false);
    expect(isRetryableError(new Error('rate_limit_error'))).toBe(true);
  });
});

describe('InsightsEngine.onTurnEnd', () => {
  const row = { archived: 0, custom_name: null as string | null };
  const prompts = { count: 2 };
  let stored: { message_count: number } | null;
  let extract: ReturnType<typeof vi.spyOn>;
  let engine: InsightsEngine;

  beforeEach(() => {
    __setGenerationOverridesForTests({ insights: true });
    row.archived = 0;
    row.custom_name = null;
    prompts.count = 2;
    stored = null;
    vi.spyOn(anthropicService, 'isConfigured').mockReturnValue(true);
    extract = vi.spyOn(anthropicService, 'extractSessionInsights').mockResolvedValue({} as never);
    engine = Object.create(InsightsEngine.prototype) as InsightsEngine;
    Object.assign(engine, {
      logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
      db: { prepare: () => ({ get: () => row }) },
      turnEndInFlight: new Set<string>(),
      failedUntil: new Map<string, number>(),
      lastComputedAt: new Map<string, number>(),
      readUserInputs: () => ({ userPrompts: Array.from({ length: prompts.count }, (_, i) => `message ${i}`), inputCount: prompts.count, brief: null }),
      readAssistantContent: () => ({ assistantTexts: [], todoState: null, contentCount: 0 }),
      buildInsightsConversationText: () => 'conversation',
      getInsightsRecord: async () => stored,
      setInsightsRecord: async (record: { message_count: number }) => { stored = record; },
    });
  });
  afterEach(() => {
    __setGenerationOverridesForTests(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('skips a session named by hand', async () => {
    row.custom_name = 'Canary reports';
    await engine.onTurnEnd('conv-a');
    expect(extract).not.toHaveBeenCalled();
  });

  it('names at 2 messages and not again until 4', async () => {
    vi.useFakeTimers();
    await engine.onTurnEnd('conv-a');
    expect(extract).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    prompts.count = 3;
    await engine.onTurnEnd('conv-a');
    expect(extract).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    prompts.count = 4;
    await engine.onTurnEnd('conv-a');
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('waits ten minutes after a failure instead of retrying on the next turn end', async () => {
    vi.useFakeTimers();
    extract.mockRejectedValue(new PlanError('subscription_sharing_usage_limit_exceeded', 429));
    await engine.onTurnEnd('conv-a');
    await engine.onTurnEnd('conv-a');
    vi.advanceTimersByTime(9 * 60_000);
    await engine.onTurnEnd('conv-a');
    expect(extract).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * 60_000);
    await engine.onTurnEnd('conv-a');
    expect(extract).toHaveBeenCalledTimes(2);
  });
});
