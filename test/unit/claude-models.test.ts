import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MODELS,
  getClaudeModel,
  formatClaudeModelLabel,
} from '../../src/constants/claude-models.js';
import { supersededModelRefusal } from '../../src/constants/superseded-models.js';

describe('claude-models registry', () => {
  it('holds the ten known model ids', () => {
    expect(CLAUDE_MODELS.map((m) => m.id)).toEqual([
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-5',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('marks legacy generations as not composer-selectable', () => {
    for (const id of [
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
    ]) {
      expect(getClaudeModel(id)?.composerSelectable).toBe(false);
    }
  });

  it('marks current models as composer-selectable', () => {
    for (const id of [
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5',
    ]) {
      expect(getClaudeModel(id)?.composerSelectable).toBe(true);
    }
  });

  it('uses version-explicit labels for models with siblings', () => {
    expect(formatClaudeModelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(formatClaudeModelLabel('claude-fable-5')).toBe('Fable 5');
    expect(formatClaudeModelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(formatClaudeModelLabel('claude-opus-5')).toBe('Opus 5');
    expect(formatClaudeModelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(formatClaudeModelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(formatClaudeModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('has an ellipsis-free description for every entry', () => {
    for (const model of CLAUDE_MODELS) {
      expect(model.description).not.toMatch(/[…]|\.\.\./);
    }
  });

  it('formats known ids to their label and falls back to the raw id', () => {
    expect(formatClaudeModelLabel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(formatClaudeModelLabel('claude-unknown-9')).toBe('claude-unknown-9');
  });

  it('points every superseded model at a current, selectable one', () => {
    for (const model of CLAUDE_MODELS.filter((entry) => entry.supersededBy)) {
      const replacement = getClaudeModel(model.supersededBy!);
      expect(replacement?.supersededBy).toBeUndefined();
      expect(replacement?.composerSelectable).toBe(true);
      expect(model.composerSelectable).toBe(false);
    }
  });
});

describe('supersededModelRefusal', () => {
  it('refuses superseded Claude and Codex ids, naming the replacement', () => {
    expect(supersededModelRefusal('claude-opus-5')).toBe('claude-opus-5 is superseded: use claude-opus-5-5 instead.');
    expect(supersededModelRefusal('claude-fable-5')).toContain('claude-fable-5-1');
    expect(supersededModelRefusal('claude-sonnet-4-5-20250929')).toContain('claude-sonnet-5');
    expect(supersededModelRefusal('gpt-5.4-mini')).toContain('gpt-5.6-luna');
  });

  it('refuses a superseded id carrying a context suffix', () => {
    expect(supersededModelRefusal('claude-opus-5[1m]')).toContain('use claude-opus-5-5');
  });

  it('allows current, unknown and absent models', () => {
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'gpt-6-astra', 'opus', '', undefined, null]) {
      expect(supersededModelRefusal(model)).toBeNull();
    }
  });
});
