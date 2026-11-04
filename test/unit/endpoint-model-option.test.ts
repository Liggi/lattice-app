import { describe, expect, it } from 'vitest';
import { endpointModelOption, modelEndpoints } from '../../src/constants/claude-endpoint';

describe('endpoint names in the model picker', () => {
  const saved = { claudeEndpoints: [
    { id: 'a', baseUrl: 'https://api.moonshot.ai/anthropic', model: 'moonshotai/kimi-k3.1-pro', name: '  Kimi (Moonshot) ' },
    { id: 'b', baseUrl: 'https://api.kimi.com/coding', model: 'k3.1-pro', name: '' },
  ] };

  it('uses the saved name, trimmed, when there is one', () => {
    const [named] = modelEndpoints(saved);
    expect(named.name).toBe('Kimi (Moonshot)');
    expect(endpointModelOption(named)).toMatchObject({ id: 'moonshotai/kimi-k3.1-pro', label: 'Kimi (Moonshot)', detail: 'moonshot.ai' });
  });

  it('makes a name from the model id when the name is empty', () => {
    const [, unnamed] = modelEndpoints(saved);
    expect(unnamed.name).toBeUndefined();
    expect(endpointModelOption(unnamed).label).not.toBe('');
    expect(endpointModelOption(unnamed).label).not.toBe('k3.1-pro');
  });
});
