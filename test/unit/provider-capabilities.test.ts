import { describe, expect, it } from 'vitest';
import {
  getProviderCapabilities,
  supportsAttachments,
} from '../../src/types/provider-capabilities.js';

describe('provider capability contract', () => {
  it('describes the wired Claude surface', () => {
    expect(getProviderCapabilities('claude')).toEqual({
      attachments: { image: true, text: true, pdf: true },
      interactiveQuestions: true,
      approvals: 'interactive',
      goals: false,
      branching: 'history-copy',
      modelSwitching: { model: true, reasoningEffort: false },
    });
  });

  it('keeps Codex protocol potential separate from wired product support', () => {
    expect(getProviderCapabilities('codex')).toEqual({
      attachments: { image: true, text: true, pdf: false },
      interactiveQuestions: true,
      approvals: 'fixed-never',
      goals: true,
      branching: 'unsupported',
      modelSwitching: { model: true, reasoningEffort: true },
    });
    expect(supportsAttachments('codex')).toBe(true);
  });
});
