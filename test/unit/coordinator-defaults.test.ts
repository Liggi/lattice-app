import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CODEX_MODEL_ID } from '../../src/constants/codex-models.js';

const config: {
  coordinator?: { provider?: "claude" | "codex"; claudeModel?: string; model?: string; reasoningEffort?: string };
  server?: { defaultModel?: string };
} = {};
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: { getInstance: () => ({ getConfig: () => config }) },
}));
// Both signed in unless a test says otherwise, so the configured choice stands.
const auth = { claudeLoggedIn: true, codexLoggedIn: true };
vi.mock('../../src/services/provider-auth-service.js', () => ({
  getProviderAuthService: () => ({
    getClaudeAuthStatus: async () => ({ available: true, installed: true, status: { loggedIn: auth.claudeLoggedIn } }),
    getCodexAuthStatus: async () => ({ available: true, installed: true, loggedIn: auth.codexLoggedIn, detail: '' }),
  }),
}));

const { coordinatorClaudeModel, coordinatorCodexDefaults, coordinatorProvider } = await import('../../src/services/sessions/coordinator-defaults.js');

describe('coordinatorCodexDefaults', () => {
  it('runs a coordinator on Astra at medium, not the deepest tier', () => {
    delete config.coordinator;
    expect(coordinatorCodexDefaults()).toEqual({
      model: DEFAULT_CODEX_MODEL_ID,
      reasoningEffort: 'medium',
    });
  });

  it('takes the configured choice when there is one', () => {
    config.coordinator = { model: 'gpt-5.6-sol', reasoningEffort: 'low' };
    expect(coordinatorCodexDefaults()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'low' });
  });

  it('ignores a blank config value rather than starting a session on an empty model', () => {
    config.coordinator = { model: '  ', reasoningEffort: '' };
    expect(coordinatorCodexDefaults()).toEqual({
      model: DEFAULT_CODEX_MODEL_ID,
      reasoningEffort: 'medium',
    });
  });
});

describe("coordinatorProvider / coordinatorClaudeModel", () => {
  it("starts a coordinator on Codex when nothing is configured", async () => {
    delete config.coordinator;
    expect(await coordinatorProvider()).toBe("codex");
    expect(coordinatorClaudeModel()).toBeUndefined();
  });

  it("runs a Claude coordinator on the configured server default Claude model", () => {
    delete config.coordinator;
    config.server = { defaultModel: "claude-opus-5-5" };
    expect(coordinatorClaudeModel()).toBe("claude-opus-5-5");
    delete config.server;
  });

  it("takes Claude and its model from config", async () => {
    config.coordinator = { provider: "claude", claudeModel: "claude-opus-5-5" };
    expect(await coordinatorProvider()).toBe("claude");
    expect(coordinatorClaudeModel()).toBe("claude-opus-5-5");
  });

  it("treats an unknown provider as Codex and a blank Claude model as unset", async () => {
    config.coordinator = { provider: "gemini" as "claude", claudeModel: "  " };
    expect(await coordinatorProvider()).toBe("codex");
    expect(coordinatorClaudeModel()).toBeUndefined();
  });

  // Codex is the default, but an install with only Claude signed in
  // otherwise got a Codex sign-in error from its first project.
  it("starts on the other provider when only that one is signed in", async () => {
    delete config.coordinator;
    auth.codexLoggedIn = false;
    expect(await coordinatorProvider()).toBe("claude");
    config.coordinator = { provider: "claude" };
    auth.codexLoggedIn = true;
    auth.claudeLoggedIn = false;
    expect(await coordinatorProvider()).toBe("codex");
  });

  it("keeps the configured provider when neither is signed in", async () => {
    config.coordinator = { provider: "claude" };
    auth.claudeLoggedIn = false;
    auth.codexLoggedIn = false;
    expect(await coordinatorProvider()).toBe("claude");
    auth.claudeLoggedIn = true;
    auth.codexLoggedIn = true;
  });
});
