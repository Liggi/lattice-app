import { describe, expect, it } from 'vitest';
import { modelProviderMismatch, providerForModel } from '../../src/constants/model-provider.js';

describe('providerForModel', () => {
  it('sends a Claude model to Claude, including one not in the catalog', () => {
    expect(providerForModel('claude-sonnet-5-5')).toBe('claude');
    expect(providerForModel('claude-opus-5-5[1m]')).toBe('claude');
    expect(providerForModel('opus')).toBe('claude');
  });

  it('sends an OpenAI model to Codex', () => {
    expect(providerForModel('gpt-6-astra')).toBe('codex');
    expect(providerForModel('gpt-6.1-sol')).toBe('codex');
    expect(providerForModel('o3')).toBe('codex');
  });

  it('sends an opencode provider/model id to opencode, whatever model it names', () => {
    expect(providerForModel('openrouter/anthropic/claude-opus-5-5')).toBe('opencode');
  });

  it('leaves an id that does not say, or no model, to the caller', () => {
    expect(providerForModel('mystery-model')).toBeUndefined();
    expect(providerForModel(undefined)).toBeUndefined();
    expect(providerForModel('  ')).toBeUndefined();
  });
});

describe('modelProviderMismatch', () => {
  it('refuses a Claude model on Codex instead of switching quietly', () => {
    expect(modelProviderMismatch('codex', 'claude-sonnet-5-5')).toBe(
      'claude-sonnet-5-5 is a claude model, but the provider is codex: drop the provider or name a codex model.',
    );
    expect(modelProviderMismatch('claude', 'gpt-6-astra')).toMatch(/gpt-6-astra is a codex model/);
  });

  it('accepts a matching pair, a missing provider, and an id that does not say', () => {
    expect(modelProviderMismatch('claude', 'claude-sonnet-5-5')).toBeNull();
    expect(modelProviderMismatch(undefined, 'claude-sonnet-5-5')).toBeNull();
    expect(modelProviderMismatch('codex', 'mystery-model')).toBeNull();
  });
});
