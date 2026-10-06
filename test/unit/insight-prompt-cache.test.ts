import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicService } from '../../src/services/insights/anthropic-service.js';
import { anthropicClientFactory } from '../../src/services/infrastructure/anthropic-client-factory.js';
import { getCostTracker } from '../../src/services/infrastructure/cost-tracker.js';
import { ConfigService } from '../../src/services/infrastructure/config-service.js';

afterEach(() => vi.restoreAllMocks());

describe('insight prompt caching', () => {
  it('reuses the instructions on a fit request, keeps the conversation whole, and records cache usage', async () => {
    const firstReply = JSON.stringify({
      context: { project: 'Lattice', area: null, mission: 'Review the session list and fix its refresh while preserving all of the sessions in the list', scope: 'minor' },
      theme: 'reviewing', tags: { complexity: 'routine' },
    });
    const create = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: firstReply }], usage: { input_tokens: 60, output_tokens: 100, cache_creation_input_tokens: 1672 } })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"mission":"Fix session list refresh"}' }], usage: { input_tokens: 200, output_tokens: 15, cache_read_input_tokens: 1672 } });
    vi.spyOn(anthropicClientFactory, 'getClient').mockReturnValue({ messages: { create } } as never);
    vi.spyOn(ConfigService.getInstance(), 'getConfig').mockReturnValue({ anthropic: {} } as never);
    const costs = vi.spyOn(getCostTracker(), 'log').mockImplementation(() => {});
    const conversation = 'Review the session list and fix its refresh while keeping every session visible.';

    const result = await new AnthropicService().extractSessionInsights(conversation, 'conv-test');

    expect(result.context?.mission).toBe('Fix session list refresh');
    expect(create).toHaveBeenCalledTimes(2);
    const [first, fit] = create.mock.calls.map(([request]) => request);
    expect(first.system).toEqual([{ type: 'text', text: expect.any(String), cache_control: { type: 'ephemeral' } }]);
    expect(fit.system).toEqual(first.system);
    expect(first.messages[0].content).toContain(conversation);
    expect(fit.messages[0]).toEqual(first.messages[0]);
    expect(fit.messages[1]).toEqual({ role: 'assistant', content: firstReply });
    expect(costs.mock.calls[0][0]).toMatchObject({ operation: 'GENERATE', cacheCreationInputTokens: 1672 });
    expect(costs.mock.calls[1][0]).toMatchObject({ operation: 'MISSION_FIT', cacheReadInputTokens: 1672 });
  });
});
