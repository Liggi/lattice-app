import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigService } from '../../src/services/infrastructure/config-service.js';
import { CostTracker } from '../../src/services/infrastructure/cost-tracker.js';
import { DEFAULT_CONFIG } from '../../src/types/config.js';

describe('plan accounting and config preservation', () => {
  it('stores plan tokens separately and never runs the API-dollar fallback estimator for an unknown plan model', async () => {
    const tracker = new CostTracker(':memory:'); await tracker.initialize();
    tracker.log({ sessionId: 'synthetic-session', operation: 'WORKER_ACTIVITY', model: 'unknown-plan-model', provider: 'openai', billingKind: 'chatgpt-plan', inputTokens: 1000000, outputTokens: 1000000, durationMs: 10 });
    expect(tracker.getPlanUsage()).toEqual({ calls: 1, inputTokens: 1000000, outputTokens: 1000000 });
    expect(tracker.getSummary().allTime).toMatchObject({ calls: 0, estimatedCostUsd: 0 });
    tracker.log({ sessionId: 'synthetic-session', operation: 'WORKER_ACTIVITY', model: 'claude-sonnet-5', inputTokens: 1000000, outputTokens: 1000000, durationMs: 10 });
    expect(tracker.getSummary().allTime).toMatchObject({ calls: 1, estimatedCostUsd: 12 });
  });
  it('deep-merges partial generation/coordinator/provider settings without dropping credentials, unknown fields or dormant opt-ins', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-plan-config-'));
    const current = { ...DEFAULT_CONFIG, generation: { insights: false, workerReportSummary: true, projectName: false }, coordinator: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' }, anthropic: { apiKey: 'fixture-key', models: { generation: 'sonnet', quickCheck: 'quick' } }, arbitraryExtension: { retained: true } };
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(current));
    const service = Object.create(ConfigService.prototype) as ConfigService;
    Object.assign(service, { config: current, configDir: directory, configPath: path.join(directory, 'config.json'), lastLoadedRaw: JSON.stringify(current), runtimeOverrides: {}, emitter: { emit: vi.fn() }, logger: { info: vi.fn(), debug: vi.fn() } });
    try {
      await service.updateConfig({ backgroundInference: { provider: 'chatgpt-plan', model: 'gpt-6.1-sol' }, generation: { workerActivity: true }, coordinator: { reasoningEffort: 'high' }, anthropic: { models: { generation: 'new-generation' } } });
      const saved = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
      expect(saved.generation).toEqual({ insights: false, workerReportSummary: true, projectName: false, workerActivity: true });
      expect(saved.coordinator).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' });
      expect(saved.anthropic).toEqual({ apiKey: 'fixture-key', models: { generation: 'new-generation', quickCheck: 'quick' } });
      expect(saved.arbitraryExtension).toEqual({ retained: true });
      expect(saved.backgroundInference).toEqual({ provider: 'chatgpt-plan', model: 'gpt-6.1-sol' });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
