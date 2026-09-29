/**
 * A key saved for summaries reaches a Claude conversation only when the
 * conversation billing setting says so. A model served by a saved endpoint
 * points only that conversation at the endpoint.
 */

import { describe, expect, it } from 'vitest';
import { claudeSpawnEnv, ENDPOINT_PLACEHOLDER_KEY } from '../../src/process-daemon/claude-spawn-auth.js';

const KEY = 'sk-ant-MARKER';
const env = (config: unknown, model?: string) => claudeSpawnEnv(model, () => JSON.stringify(config));
const ENDPOINTS = { claudeEndpoints: [{ id: 'a', baseUrl: 'http://127.0.0.1:8080', model: 'qwen3-coder' }] };

describe('claudeSpawnEnv', () => {
  it('hands the key to the child only in api-key mode', () => {
    expect(env({ anthropic: { apiKey: KEY } })).toEqual({});
    expect(env({ server: { claudeAuthMode: 'cli' }, anthropic: { apiKey: KEY } })).toEqual({});
    expect(env({ server: { claudeAuthMode: 'api-key' }, anthropic: { apiKey: ` ${KEY} ` } })).toEqual({ ANTHROPIC_API_KEY: KEY });
  });

  it('falls back to the CLI sign-in when api-key mode has no key, or the file is missing or broken', () => {
    expect(env({ server: { claudeAuthMode: 'api-key' } })).toEqual({});
    expect(claudeSpawnEnv(undefined, () => null)).toEqual({});
    expect(claudeSpawnEnv(undefined, () => '{not json')).toEqual({});
  });

  it("points only the endpoint's model at the endpoint, never with the claude.ai login or the summaries key", () => {
    const config = { ...ENDPOINTS, server: { claudeAuthMode: 'api-key' }, anthropic: { apiKey: KEY } };
    const endpointEnv = env(config, 'qwen3-coder');
    expect(endpointEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080',
      ANTHROPIC_AUTH_TOKEN: ENDPOINT_PLACEHOLDER_KEY,
      ANTHROPIC_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder',
      CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3-coder',
    });
    expect('ANTHROPIC_API_KEY' in endpointEnv && endpointEnv.ANTHROPIC_API_KEY === undefined).toBe(true);
    expect(env(config, 'claude-opus-5-5')).toEqual({ ANTHROPIC_API_KEY: KEY });
    expect(env(ENDPOINTS, 'claude-opus-5-5')).toEqual({});
    expect(env(ENDPOINTS)).toEqual({});
  });

  it("sends the endpoint's own key when one is saved", () => {
    const config = { claudeEndpoints: [{ id: 'a', baseUrl: 'http://h', model: 'm', apiKey: 'local-secret' }] };
    expect(env(config, 'm').ANTHROPIC_AUTH_TOKEN).toBe('local-secret');
  });

  it("gives only that endpoint's sessions its context window", () => {
    const config = { claudeEndpoints: [
      { id: 'a', baseUrl: 'http://h', model: 'small', contextWindow: 32768 },
      { id: 'b', baseUrl: 'http://h', model: 'unsized' },
    ] };
    expect(env(config, 'small').CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('32768');
    const unsized = env(config, 'unsized');
    expect('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in unsized && unsized.CLAUDE_CODE_MAX_CONTEXT_TOKENS === undefined).toBe(true);
    expect(env(config, 'claude-opus-5-5')).toEqual({});
  });
});
