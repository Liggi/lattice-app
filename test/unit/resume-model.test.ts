import { describe, expect, it } from 'vitest';
import { DEFAULT_CODEX_MODEL_ID } from '../../src/constants/codex-models.js';
import { resolveResumeModel } from '../../src/services/sessions/resume-model.js';

describe('resolveResumeModel', () => {
  it('preserves the stored Claude model when resume omits a model', () => {
    expect(resolveResumeModel({
      provider: 'claude',
      storedModel: 'claude-opus-5',
    })).toBe('claude-opus-5');
  });

  it('allows an explicit model switch', () => {
    expect(resolveResumeModel({
      provider: 'claude',
      requestedModel: 'claude-sonnet-5',
      storedModel: 'claude-opus-5',
    })).toBe('claude-sonnet-5');
  });

  it('uses the Codex default when a legacy segment has no stored model', () => {
    expect(resolveResumeModel({
      provider: 'codex',
      storedModel: null,
    })).toBe(DEFAULT_CODEX_MODEL_ID);
  });

  it('lets legacy unknown Claude segments use the configured Claude default', () => {
    expect(resolveResumeModel({
      provider: 'claude',
      storedModel: 'unknown',
    })).toBeUndefined();
  });
});
