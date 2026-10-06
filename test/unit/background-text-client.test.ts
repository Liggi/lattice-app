import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LatticeConfig } from '../../src/types/config.js';

const state = vi.hoisted(() => ({ config: {} as Partial<LatticeConfig>, api: vi.fn(), plan: vi.fn(), key: false, configFailure: false }));
vi.mock('../../src/services/infrastructure/config-service.js', () => ({ ConfigService: { getInstance: () => ({ getConfig: () => { if (state.configFailure) throw new Error('config unavailable'); return state.config; } }) } }));
vi.mock('../../src/services/infrastructure/anthropic-client-factory.js', () => ({ anthropicClientFactory: { getClient: () => state.key ? { messages: { create: state.api } } : null, isConfigured: () => state.key } }));
vi.mock('../../src/services/infrastructure/chatgpt-plan-client.js', () => ({ chatgptPlanClient: { complete: state.plan } }));

const { backgroundTextClient, backgroundProvenance, planStandInStatus, __resetPlanStandInForTests } = await import('../../src/services/infrastructure/background-text-client.js');
const { PlanError } = await import('../../src/services/infrastructure/chatgpt-plan-auth.js');
const { isGenerationEnabled } = await import('../../src/services/infrastructure/generation-gates.js');

beforeEach(() => { __resetPlanStandInForTests(); vi.unstubAllGlobals(); state.config = {}; state.key = false; state.configFailure = false; state.api.mockReset(); state.plan.mockReset(); });

describe('explicit plan routing', () => {
  it('runs the whole repair conversation without an Anthropic key, discards API-only parameters, and records actual provenance', async () => {
    state.config = { backgroundInference: { provider: 'chatgpt-plan', model: 'gpt-6.1-sol' } };
    state.plan.mockResolvedValue({ text: 'Faithful repair.', model: 'actual-sol', inputTokens: 123, outputTokens: 10, cachedTokens: 22 });
    const fullContext = 'Complete input\n'.repeat(2000);
    const client = backgroundTextClient.getClient()!;
    const result = await client.messages.create({ model: 'anthropic-requested-model', max_tokens: 400, temperature: 0,
      system: [{ type: 'text', text: 'Whole instructions', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: fullContext }, { role: 'assistant', content: 'First reply' }, { role: 'user', content: 'Repair bounds, preserving uncertainty' }] });
    expect(state.plan).toHaveBeenCalledWith('gpt-6.1-sol', 'Whole instructions', [
      { role: 'user', content: fullContext }, { role: 'assistant', content: 'First reply' }, { role: 'user', content: 'Repair bounds, preserving uncertainty' },
    ], true);
    expect(backgroundProvenance(result, 'anthropic-requested-model')).toEqual({ model: 'actual-sol', provider: 'openai', billingKind: 'chatgpt-plan' });
    expect(state.api).not.toHaveBeenCalled();
  });
  it('never falls back to a paid API key on plan errors', async () => {
    state.key = true; state.config = { backgroundInference: { provider: 'chatgpt-plan', model: 'sol' } };
    state.plan.mockRejectedValue(new Error('usage limit'));
    await expect(backgroundTextClient.getClient()!.messages.create({ model: 'api', max_tokens: 100, messages: [{ role: 'user', content: 'whole' }] })).rejects.toThrow('usage limit');
    expect(state.api).not.toHaveBeenCalled();
  });
  it('honors the current route even for a client captured before activation and refuses config failures', async () => {
    state.key = true;
    const captured = backgroundTextClient.getClient()!;
    state.config = { backgroundInference: { provider: 'chatgpt-plan', model: 'sol' } };
    state.plan.mockRejectedValue(new Error('plan blocked'));
    const request = { model: 'api', max_tokens: 100, messages: [{ role: 'user' as const, content: 'complete' }] };
    await expect(captured.messages.create(request)).rejects.toThrow('plan blocked');
    state.configFailure = true;
    await expect(captured.messages.create(request)).rejects.toThrow('config unavailable');
    expect(state.api).not.toHaveBeenCalled();
  });
  it('does not enable dormant features or keyed-default generators when plan routing changes', () => {
    state.key = true; state.config = { backgroundInference: { provider: 'chatgpt-plan', model: 'sol' }, generation: { workerReportSummary: true, insights: false } };
    expect(isGenerationEnabled('workerReportSummary')).toBe(true);
    expect(isGenerationEnabled('workerActivity')).toBe(false);
    expect(isGenerationEnabled('projectName')).toBe(false);
    expect(isGenerationEnabled('insights')).toBe(false);
    expect(isGenerationEnabled('sessionSummary')).toBe(false);
  });
});

describe('per-job routes and the paused-plan stand-in', () => {
  const ollama = { id: 'ep-local', baseUrl: 'http://127.0.0.1:11434/v1/', model: 'qwen3:4b', protocol: 'openai' as const };
  const request = { model: 'claude-default', max_tokens: 60, system: 'Name it.', messages: [{ role: 'user' as const, content: 'the work' }] };
  const chatCompletion = () => vi.fn(async () => new Response(JSON.stringify({ model: 'qwen3:4b', choices: [{ message: { content: '<think>x</think>Short name' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } })));

  it('sends one job to an OpenAI-compatible endpoint while the others keep the default', async () => {
    state.key = true;
    state.config = { claudeEndpoints: [ollama], backgroundInference: { provider: 'anthropic-api', jobs: { insights: { provider: 'endpoint', endpointId: 'ep-local' } } } };
    const fetch = chatCompletion(); vi.stubGlobal('fetch', fetch);
    const result = await backgroundTextClient.getClient('insights')!.messages.create(request);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:11434/v1/chat/completions', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ model: 'qwen3:4b', messages: [{ role: 'system', content: 'Name it.' }, { role: 'user', content: 'the work' }], max_tokens: 60 });
    expect(result.content).toEqual([{ type: 'text', text: 'Short name', citations: null }]);
    expect(backgroundProvenance(result, 'claude-default')).toEqual({ model: 'qwen3:4b', billingKind: 'endpoint', provider: 'openai' });
    state.api.mockResolvedValue({ model: 'claude-default', content: [] });
    await backgroundTextClient.getClient('workerActivity')!.messages.create(request);
    expect(state.api).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-default' }));
  });

  it('runs on the chosen stand-in only when the plan refuses as paused, and says so', async () => {
    state.config = { claudeEndpoints: [ollama], backgroundInference: { provider: 'chatgpt-plan', model: 'sol', whenPlanPaused: { provider: 'endpoint', endpointId: 'ep-local' } } };
    vi.stubGlobal('fetch', chatCompletion());
    state.plan.mockRejectedValue(new PlanError('subscription_sharing_usage_limit_exceeded', 429));
    await backgroundTextClient.getClient('insights')!.messages.create(request);
    expect(planStandInStatus()?.jobs).toEqual(['insights']);
    state.plan.mockRejectedValue(new PlanError('sign_in_required', 401));
    await expect(backgroundTextClient.getClient('insights')!.messages.create(request)).rejects.toThrow('sign_in_required');
    state.plan.mockResolvedValue({ text: 'ok', model: 'sol', inputTokens: 1, outputTokens: 1, cachedTokens: 0 });
    await backgroundTextClient.getClient('insights')!.messages.create(request);
    expect(planStandInStatus()).toBeNull();
  });

  it('waits rather than standing in when no stand-in was chosen', async () => {
    state.key = true; state.config = { backgroundInference: { provider: 'chatgpt-plan', model: 'sol' } };
    state.plan.mockRejectedValue(new PlanError('subscription_sharing_usage_limit_exceeded', 429));
    await expect(backgroundTextClient.getClient('insights')!.messages.create(request)).rejects.toThrow();
    expect(state.api).not.toHaveBeenCalled();
    expect(planStandInStatus()).toBeNull();
  });
});
