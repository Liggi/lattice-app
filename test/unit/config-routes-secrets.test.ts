/**
 * API keys go into the config through the settings page and never come back
 * out of it. GET says whether a key is set; PUT keeps a key the page did not
 * mention, replaces one it did, and removes one sent as null.
 */

import { describe, expect, it } from 'vitest';
import { normalizeSecretUpdates, publicConfig } from '../../src/routes/system/config.routes.js';
import type { LatticeConfig } from '../../src/types/config.js';

const SAVED_KEY = 'sk-ant-MARKER-saved-key';

const current = {
  server: { host: '127.0.0.1', port: 3001, authToken: 'MARKER-bearer', claudeAuthMode: 'cli' },
  interface: { colorScheme: 'dark', language: 'en' },
  anthropic: { apiKey: SAVED_KEY, models: { generation: 'claude-sonnet-5' } },
  gemini: { apiKey: 'MARKER-gemini' },
  typesafe: { apiKey: 'MARKER-typesafe', apiKeyFile: '/keys/typesafe' },
  claudeEndpoints: [{ id: 'ep-a', baseUrl: 'http://127.0.0.1:8080', model: 'qwen3-coder', apiKey: 'MARKER-endpoint' }],
} as unknown as LatticeConfig;

describe('config secrets', () => {
  it('reads back whether a key is set, never the key or the bearer token', () => {
    const shown = JSON.stringify(publicConfig(current));
    expect(shown).not.toContain('MARKER');
    const parsed = JSON.parse(shown) as { anthropic: Record<string, unknown>; gemini: Record<string, unknown>; server: Record<string, unknown> };
    expect(parsed.anthropic).toEqual({ apiKeyConfigured: true, models: { generation: 'claude-sonnet-5' } });
    expect(parsed.gemini).toEqual({ apiKeyConfigured: true });
    expect((parsed as unknown as { typesafe: unknown }).typesafe).toEqual({ apiKeyConfigured: true, apiKeyFile: '/keys/typesafe' });
    expect(parsed.server.claudeAuthMode).toBe('cli');
    expect('authToken' in parsed.server).toBe(false);
    expect(publicConfig({ ...current, anthropic: {} } as LatticeConfig).anthropic).toEqual({ apiKeyConfigured: false });
  });

  it('keeps a saved key the page did not mention, replaces one it did, removes one sent as null', () => {
    expect(normalizeSecretUpdates({ anthropic: { models: { generation: 'x' } } } as Partial<LatticeConfig>, current).anthropic)
      .toEqual({ apiKey: SAVED_KEY, models: { generation: 'x' } });
    expect(normalizeSecretUpdates({ anthropic: { apiKey: '  sk-ant-new  ' } }, current).anthropic)
      .toEqual({ apiKey: 'sk-ant-new' });
    expect(normalizeSecretUpdates({ anthropic: { apiKey: null } } as unknown as Partial<LatticeConfig>, current).anthropic)
      .toEqual({ apiKey: undefined });
    expect(normalizeSecretUpdates({ anthropic: { apiKey: '' } }, current).anthropic)
      .toEqual({ apiKey: undefined });
    // The readback flag is not a setting; sending it back must not persist it.
    expect(normalizeSecretUpdates({ anthropic: { apiKeyConfigured: true } } as unknown as Partial<LatticeConfig>, current).anthropic)
      .toEqual({ apiKey: SAVED_KEY });
    expect(normalizeSecretUpdates({ typesafe: { apiKey: null } } as unknown as Partial<LatticeConfig>, current).typesafe)
      .toEqual({ apiKey: undefined });
  });

  it('never lets the page set the bearer token', () => {
    const next = normalizeSecretUpdates({ server: { authToken: 'MARKER-new', claudeAuthMode: 'api-key' } } as Partial<LatticeConfig>, current);
    expect(next.server).toEqual({ claudeAuthMode: 'api-key' });
  });

  it('treats each endpoint key the same way, matched to the saved endpoint by id', () => {
    expect(publicConfig(current).claudeEndpoints).toEqual([
      { id: 'ep-a', baseUrl: 'http://127.0.0.1:8080', model: 'qwen3-coder', apiKeyConfigured: true },
    ]);
    const edit = (endpoint: Record<string, unknown>) =>
      normalizeSecretUpdates({ claudeEndpoints: [endpoint] } as unknown as Partial<LatticeConfig>, current).claudeEndpoints;
    const base = { id: 'ep-a', baseUrl: 'http://127.0.0.1:9090', model: 'qwen3-coder' };
    expect(edit({ ...base, apiKeyConfigured: true })).toEqual([{ ...base, apiKey: 'MARKER-endpoint' }]);
    expect(edit({ ...base, apiKey: ' new-key ' })).toEqual([{ ...base, apiKey: 'new-key' }]);
    expect(edit({ ...base, apiKey: null })).toEqual([base]);
    expect(edit({ ...base, id: 'ep-b' })).toEqual([{ ...base, id: 'ep-b' }]);
  });
});
