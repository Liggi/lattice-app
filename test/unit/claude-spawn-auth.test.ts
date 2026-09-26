/**
 * A key saved for summaries reaches a Claude conversation only when the
 * conversation billing setting says so.
 */

import { describe, expect, it } from 'vitest';
import { claudeSpawnEnv } from '../../src/process-daemon/claude-spawn-auth.js';

const KEY = 'sk-ant-MARKER';

describe('claudeSpawnEnv', () => {
  it('hands the key to the child only in api-key mode', () => {
    expect(claudeSpawnEnv(() => JSON.stringify({ anthropic: { apiKey: KEY } }))).toEqual({});
    expect(claudeSpawnEnv(() => JSON.stringify({ server: { claudeAuthMode: 'cli' }, anthropic: { apiKey: KEY } }))).toEqual({});
    expect(claudeSpawnEnv(() => JSON.stringify({ server: { claudeAuthMode: 'api-key' }, anthropic: { apiKey: ` ${KEY} ` } }))).toEqual({ ANTHROPIC_API_KEY: KEY });
  });

  it('falls back to the CLI sign-in when api-key mode has no key, or the file is missing or broken', () => {
    expect(claudeSpawnEnv(() => JSON.stringify({ server: { claudeAuthMode: 'api-key' } }))).toEqual({});
    expect(claudeSpawnEnv(() => null)).toEqual({});
    expect(claudeSpawnEnv(() => '{not json')).toEqual({});
  });
});
