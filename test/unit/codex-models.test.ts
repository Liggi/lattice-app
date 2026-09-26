import { describe, expect, it } from 'vitest';
import {
  CODEX_MODELS,
  CODEX_EFFORTS,
  DEFAULT_CODEX_MODEL_ID,
  DEFAULT_CODEX_EFFORT,
  getCodexModel,
  formatCodexModelLabel,
  effortsForCodexModel,
} from '../../src/constants/codex-models.js';

describe('codex-models registry', () => {
  it('holds the known model ids in order', () => {
    expect(CODEX_MODELS.map((m) => m.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
  });

  it('marks astra and the 5.6 line as composer-selectable', () => {
    for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(getCodexModel(id)?.composerSelectable).toBe(true);
    }
  });

  it('never surfaces gpt-5.4-mini as selectable', () => {
    expect(getCodexModel('gpt-5.4-mini')?.composerSelectable).toBe(false);
  });

  it('marks legacy models as not composer-selectable', () => {
    for (const id of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']) {
      expect(getCodexModel(id)?.composerSelectable).toBe(false);
    }
  });

  it('stores per-model supported efforts from the cache', () => {
    expect(getCodexModel('gpt-6-astra')?.efforts).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    expect(getCodexModel('gpt-5.6-sol')?.efforts).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    expect(getCodexModel('gpt-5.6-terra')?.efforts).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    expect(getCodexModel('gpt-5.6-luna')?.efforts).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    expect(getCodexModel('gpt-5.4')?.efforts).toEqual([
      'low', 'medium', 'high', 'xhigh',
    ]);
  });

  it('every model effort is present in the effort superset', () => {
    const known = new Set(CODEX_EFFORTS.map((e) => e.id));
    for (const model of CODEX_MODELS) {
      for (const effort of model.efforts) {
        expect(known.has(effort)).toBe(true);
      }
    }
  });

  it('exposes the full effort superset in escalating order', () => {
    expect(CODEX_EFFORTS.map((e) => e.id)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
  });

  it('has an ellipsis-free description for every model and effort', () => {
    for (const model of CODEX_MODELS) {
      expect(model.description).not.toMatch(/[…]|\.\.\./);
    }
    for (const effort of CODEX_EFFORTS) {
      expect(effort.description).not.toMatch(/[…]|\.\.\./);
    }
  });

  it('defaults to gpt-6-astra at xhigh effort', () => {
    expect(DEFAULT_CODEX_MODEL_ID).toBe('gpt-6-astra');
    expect(DEFAULT_CODEX_EFFORT).toBe('xhigh');
    expect(getCodexModel(DEFAULT_CODEX_MODEL_ID)).toBeDefined();
    expect(getCodexModel(DEFAULT_CODEX_MODEL_ID)?.efforts).toContain(DEFAULT_CODEX_EFFORT);
  });

  it('formats known ids to their label and falls back to the raw id', () => {
    expect(formatCodexModelLabel('gpt-6-astra')).toBe('Astra 6');
    expect(formatCodexModelLabel('gpt-5.6-sol')).toBe('Sol 5.6');
    expect(formatCodexModelLabel('gpt-5.4')).toBe('GPT-5.4');
    expect(formatCodexModelLabel('gpt-unknown-9')).toBe('gpt-unknown-9');
  });

  it('returns per-model efforts and falls back to the default model set for unknown ids', () => {
    expect(effortsForCodexModel('gpt-5.6-luna')).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    expect(effortsForCodexModel('gpt-unknown-9')).toEqual(
      getCodexModel(DEFAULT_CODEX_MODEL_ID)!.efforts,
    );
  });
});
