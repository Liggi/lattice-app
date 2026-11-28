import { describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { GeminiPlanUsageService, parseAgyUsage } from '../../src/services/infrastructure/gemini-plan-usage.js';
import { ClaudePlanUsageService } from '../../src/services/infrastructure/claude-plan-usage.js';
import { createPlanUsageRoutes } from '../../src/routes/integrations/plan-usage.routes.js';
import type { GeminiSpend } from '../../src/services/infrastructure/gemini-spend.js';

// What `agy -p /usage --output-format json` printed on 25 Nov 2026 (descriptions shortened).
const AGY_USAGE = {
  conversation_id: '',
  status: 'SUCCESS',
  response: 'Gemini Models\tWeekly Limit Remaining\t97%\t2026-12-02T18:53:04Z\n',
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Neon, …',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9679015278816223, reset_time: '2026-12-02T18:53:04Z' },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.8740634918212891, reset_time: '2026-11-25T23:53:04Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
            { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
          ],
        },
      ],
    },
  },
};

describe('Gemini plan usage', () => {
  it('reads every bucket, with no reset for the epoch-0 time agy gives an unused group', () => {
    expect(parseAgyUsage(AGY_USAGE)).toEqual([
      { id: 'gemini-weekly', group: 'Gemini Models', window: 'week', percentUsed: 3, resetAt: Date.parse('2026-12-02T18:53:04Z') },
      { id: 'gemini-5h', group: 'Gemini Models', window: '5h', percentUsed: 13, resetAt: Date.parse('2026-11-25T23:53:04Z') },
      { id: '3p-weekly', group: 'Claude and GPT models', window: 'week', percentUsed: 0, resetAt: null },
      { id: '3p-5h', group: 'Claude and GPT models', window: '5h', percentUsed: 0, resetAt: null },
    ]);
  });

  it('reports a failed run or a reply with no limits as unavailable', async () => {
    const failed = new GeminiPlanUsageService(async () => { throw new Error('spawn agy ENOENT'); });
    expect(await failed.get()).toMatchObject({ state: 'unavailable', reason: 'spawn agy ENOENT' });
    const signedOut = new GeminiPlanUsageService(async () => JSON.stringify({ status: 'ERROR', response: 'Not signed in\nRun agy login' }));
    expect(await signedOut.get()).toMatchObject({ state: 'unavailable', reason: 'Not signed in' });
  });

  it('runs agy once per ten minutes and answers from the stale reading while it refreshes', async () => {
    let now = 0;
    let runs = 0;
    const outputs = [JSON.stringify(AGY_USAGE), JSON.stringify({ status: 'ERROR', response: 'Quota service down' })];
    const service = new GeminiPlanUsageService(async () => outputs[runs++], () => now);
    expect((await service.get()).state).toBe('ok');
    now = 5 * 60_000;
    await service.get();
    expect(runs).toBe(1);
    now = 11 * 60_000;
    expect((await service.get()).state).toBe('ok');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
    expect(await service.get()).toMatchObject({ state: 'unavailable', reason: 'Quota service down' });
  });
});

describe('plan usage route', () => {
  const spend = (() => ({ budget: { usd: 1402 } })) as unknown as () => GeminiSpend;
  const claude = { get: async () => ({ state: 'ok', limits: [], checkedAt: 1 }) } as unknown as ClaudePlanUsageService;

  function route(mode: 'plan' | 'api', plan: () => Promise<unknown>) {
    const server = express();
    server.use('/api/plan-usage', createPlanUsageRoutes(claude, spend, { get: plan } as unknown as GeminiPlanUsageService, () => mode));
    return supertest(server).get('/api/plan-usage');
  }

  it('sends the Gemini plan in plan mode, read alongside Claude', async () => {
    const response = await route('plan', async () => ({ state: 'ok', limits: [], checkedAt: 2 }));
    expect(response.body).toMatchObject({ geminiMode: 'plan', geminiPlan: { state: 'ok' }, gemini: { budget: { usd: 1402 } }, claude: { state: 'ok' } });
  });

  it('does not run agy when a Cloud project is billed', async () => {
    let read = false;
    const response = await route('api', async () => { read = true; return {}; });
    expect(read).toBe(false);
    expect(response.body.geminiMode).toBe('api');
    expect(response.body.geminiPlan).toBeUndefined();
  });
});
