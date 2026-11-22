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
    expect(providerForModel('moonshotai/kimi-k3.1-pro', ['qwen3-coder'])).toBe('opencode');
  });

  it('sends an agy: id to Antigravity, even when it names a Claude model', () => {
    expect(providerForModel('agy:gemini-3.8-flash-high')).toBe('antigravity');
    expect(providerForModel('agy:claude-sonnet-4-6')).toBe('antigravity'); // stale-model-ok: Antigravity's own id
  });

  it("sends a saved Anthropic endpoint's model to Claude, slash and all", () => {
    expect(providerForModel('moonshotai/kimi-k3.1-pro', ['moonshotai/kimi-k3.1-pro'])).toBe('claude');
    expect(providerForModel(' moonshotai/kimi-k3.1-pro[1m] ', ['moonshotai/kimi-k3.1-pro'])).toBe('claude');
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

  it("accepts a provider/model id on Claude when a saved endpoint serves it, and only then", () => {
    expect(modelProviderMismatch('claude', 'moonshotai/kimi-k3.1-pro', ['moonshotai/kimi-k3.1-pro'])).toBeNull();
    expect(modelProviderMismatch('claude', 'moonshotai/kimi-k3.1-pro')).toMatch(/is a opencode model, but the provider is claude/);
    expect(modelProviderMismatch('codex', 'moonshotai/kimi-k3.1-pro', ['moonshotai/kimi-k3.1-pro'])).toMatch(/is a claude model, but the provider is codex/);
  });
});
