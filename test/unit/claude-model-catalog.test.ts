import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { catalogFromCliModels, type ClaudeCliModel } from '../../src/constants/claude-model-catalog.js';

// Recorded from `initialize` on Claude Code 2.1.292, 2026-10-11: a Claude Max
// sign-in, and the same CLI given an API key.
const recorded = (name: string): ClaudeCliModel[] =>
  JSON.parse(readFileSync(new URL(`../fixtures/claude-initialize/${name}.json`, import.meta.url), 'utf8')) as ClaudeCliModel[];

describe('catalogFromCliModels', () => {
  it('offers each family\'s newest model, older ones under Other, and leaves out superseded ones', () => {
    const { models, defaultModel } = catalogFromCliModels(recorded('models-subscription'));
    expect(models.map((m) => [m.id, m.label, m.other])).toEqual([
      ['claude-opus-5-5', 'Opus 5.5', false],
      ['claude-fable-5-1', 'Fable 5.1', false],
      ['claude-sonnet-5-5', 'Sonnet 5.5', false],
      ['claude-haiku-4-5-20251001', 'Haiku 4.5', false],
      ['claude-sonnet-5', 'Sonnet 5', true],
      ['claude-sonnet-4-6', 'Sonnet 4.6', true],
    ]);
    expect(defaultModel).toBe('claude-opus-5-5');
  });

  it('follows what an API key can use, keeping the id the CLI gives', () => {
    const { models } = catalogFromCliModels(recorded('models-api-key'));
    expect(models.map((m) => [m.id, m.other])).toEqual([
      ['claude-opus-5-5', false],
      ['claude-fable-5-1[1m]', false],
      ['claude-sonnet-5-5', false],
      ['claude-haiku-4-5-20251001', false],
    ]);
  });
});
