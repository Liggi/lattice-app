/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, ExternalLink, Loader2, LogIn } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { parseJson } from '../../../../utils/json.js';
import { PROVIDER_SIGN_IN_QUERY_KEY } from '../../hooks/useProviderSignIn';
import { api } from '../../services/api';
import { ClaudeLoginTerminal, type LoginAttemptState } from './ClaudeLoginTerminal';
import { SecretKeyField } from './SecretKeyField';
import { ChatGPTPlanCard } from './ChatGPTPlanCard';
import { ClaudeEndpointsCard, type ClaudeEndpointUpdate } from './ClaudeEndpointsCard';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import type { ClaudeEndpointSetting } from '../../services/api/types';

type ClaudeStatusResponse =
  | { available: false; installed: boolean; error: string }
  | { available: true; installed: true; exitCode: number | null; signal: string | null; status: unknown };

type CodexStatusResponse = { available: boolean; installed: boolean; loggedIn: boolean; detail: string };

const INSTALL_DOCS = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://learn.chatgpt.com/docs/codex/cli',
} as const;

/**
 * In place of Connect when the CLI is not on the server's PATH: there is
 * nothing to sign in to until it is installed, and "spawn codex ENOENT" told
 * a newcomer none of that.
 */
function InstallActions({ provider, onCheckAgain }: { provider: keyof typeof INSTALL_DOCS; onCheckAgain: () => void }): JSX.Element {
  return (
    <>
      <a
        href={INSTALL_DOCS[provider]}
        target="_blank"
        rel="noreferrer"
        data-testid={`provider-install-${provider}`}
        className={`${PRIMARY_BTN} !no-underline`}
      >
        <ExternalLink size={14} />
        <span>How to install</span>
      </a>
      <button
        type="button"
        onClick={onCheckAgain}
        className={QUIET_BTN}
      >
        Check again
      </button>
    </>
  );
}

type CodexDeviceLogin = { sessionId: string; verificationUrl: string; userCode: string };

type CodexDeviceLoginState =
  | { state: 'pending' }
  | { state: 'success' }
  | { state: 'failed'; error: string };

const CODEX_LOGIN_POLL_MS = 2_000;

function safeJsonParse(text: string): unknown | null {
  try {
    return parseJson(text) as unknown;
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const message = (data && typeof data === 'object' && data !== null && 'error' in data && typeof (data as { error?: unknown }).error === 'string')
      ? (data as { error: string }).error
      : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

export function ProviderAuthTab(): JSX.Element {
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Claude sign-in runs in a terminal the daemon owns; this only says whether
  // that panel is open and what the last attempt came to.
  const [claudeSignInOpen, setClaudeSignInOpen] = useState(false);
  const [claudeLoginSuccess, setClaudeLoginSuccess] = useState(false);
  const [claudeError, setClaudeError] = useState<string | null>(null);

  // How Claude conversations are billed, and whether a key is saved for it.
  const [claudeAuthMode, setClaudeAuthMode] = useState<'cli' | 'api-key'>('cli');
  const [anthropicKeyConfigured, setAnthropicKeyConfigured] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<ClaudeEndpointSetting[]>([]);
  const { setClaudeEndpointsFrom } = usePreferencesContext();

  // Codex device-code state (CLI polls OpenAI; we poll the CLI)
  const [codexStatus, setCodexStatus] = useState<CodexStatusResponse | null>(null);
  const [codexLogin, setCodexLogin] = useState<CodexDeviceLogin | null>(null);
  const [codexLoginSuccess, setCodexLoginSuccess] = useState(false);
  const [codexStarting, setCodexStarting] = useState(false);

  const queryClient = useQueryClient();
  const refreshStatuses = useCallback(async () => {
    setError(null);
    void queryClient.invalidateQueries({ queryKey: PROVIDER_SIGN_IN_QUERY_KEY });
    const [claudeResult, codexResult] = await Promise.allSettled([
      fetchJson<ClaudeStatusResponse>('/api/provider-auth/claude/status'),
      fetchJson<CodexStatusResponse>('/api/provider-auth/codex/status'),
    ]);
    if (claudeResult.status === 'fulfilled') setClaudeStatus(claudeResult.value);
    if (codexResult.status === 'fulfilled') setCodexStatus(codexResult.value);
    const failure = [claudeResult, codexResult].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) {
      setError(failure.reason instanceof Error ? failure.reason.message : 'Failed to load auth status');
    }
  }, [queryClient]);

  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  const claudeLoggedIn = useMemo(() => {
    if (!claudeStatus || !claudeStatus.available) return false;
    if (!claudeStatus.status || typeof claudeStatus.status !== 'object') return false;
    const status = claudeStatus.status as { loggedIn?: unknown };
    return status.loggedIn === true;
  }, [claudeStatus]);

  const claudeAuthMethod = useMemo(() => {
    if (!claudeStatus || !claudeStatus.available) return null;
    if (!claudeStatus.status || typeof claudeStatus.status !== 'object') return null;
    const status = claudeStatus.status as { authMethod?: unknown };
    return typeof status.authMethod === 'string' ? status.authMethod : null;
  }, [claudeStatus]);

  const claudeSubscription = useMemo(() => {
    if (!claudeStatus || !claudeStatus.available) return null;
    if (!claudeStatus.status || typeof claudeStatus.status !== 'object') return null;
    const status = claudeStatus.status as { subscriptionType?: unknown };
    return typeof status.subscriptionType === 'string' && status.subscriptionType ? status.subscriptionType : null;
  }, [claudeStatus]);

  useEffect(() => {
    api.getConfig().then((config) => {
      setClaudeAuthMode(config.server?.claudeAuthMode === 'api-key' ? 'api-key' : 'cli');
      setAnthropicKeyConfigured(config.anthropic?.apiKeyConfigured === true);
      setEndpoints(config.claudeEndpoints ?? []);
    }).catch((err) => {
      setBillingError(err instanceof Error ? err.message : 'Could not read the billing setting');
    });
  }, []);

  const openClaudeSignIn = useCallback(() => {
    setClaudeError(null);
    setClaudeLoginSuccess(false);
    setClaudeSignInOpen(true);
  }, []);

  const onClaudeSignInFinished = useCallback((state: Exclude<LoginAttemptState, { phase: 'running' }>) => {
    setClaudeSignInOpen(false);
    if (state.phase === 'succeeded') {
      setClaudeLoginSuccess(true);
    } else if (state.phase === 'failed') {
      setClaudeError(state.reason);
    }
    void refreshStatuses();
  }, [refreshStatuses]);

  const onClaudeSignInCancelled = useCallback(() => {
    setClaudeSignInOpen(false);
    void refreshStatuses();
  }, [refreshStatuses]);

  const saveClaudeBilling = useCallback(async (update: { mode?: 'cli' | 'api-key'; apiKey?: string | null }) => {
    setBillingError(null);
    // The radio moves at once; the response confirms it or an error puts it back.
    const previousMode = claudeAuthMode;
    if (update.mode) setClaudeAuthMode(update.mode);
    try {
      const config = await api.updateConfig({
        ...(update.mode ? { server: { claudeAuthMode: update.mode } } : {}),
        ...(update.apiKey !== undefined ? { anthropic: { apiKey: update.apiKey } } : {}),
      });
      setClaudeAuthMode(config.server?.claudeAuthMode === 'api-key' ? 'api-key' : 'cli');
      setAnthropicKeyConfigured(config.anthropic?.apiKeyConfigured === true);
    } catch (err) {
      if (update.mode) setClaudeAuthMode(previousMode);
      setBillingError(err instanceof Error ? err.message : 'Could not save the billing setting');
      throw err;
    }
  }, [claudeAuthMode]);

  const saveEndpoints = useCallback(async (list: ClaudeEndpointUpdate[]) => {
    const config = await api.updateConfig({ claudeEndpoints: list });
    setEndpoints(config.claudeEndpoints ?? []);
    setClaudeEndpointsFrom(config);
  }, [setClaudeEndpointsFrom]);

  const claudeLogout = useCallback(async () => {
    setClaudeError(null);
    try {
      await fetchJson('/api/provider-auth/claude/logout', { method: 'POST', body: JSON.stringify({}) });
      void refreshStatuses();
    } catch (err) {
      setClaudeError(err instanceof Error ? err.message : 'Failed to logout');
    }
  }, [refreshStatuses]);

  // Codex: device-code flow
  const startCodexLogin = useCallback(async () => {
    setError(null);
    setCodexLoginSuccess(false);
    setCodexStarting(true);
    try {
      const data = await fetchJson<CodexDeviceLogin>('/api/provider-auth/codex/login', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setCodexLogin(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Codex login');
    } finally {
      setCodexStarting(false);
    }
  }, []);

  useEffect(() => {
    if (!codexLogin) return;
    const { sessionId } = codexLogin;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const state = await fetchJson<CodexDeviceLoginState>(`/api/provider-auth/codex/login/${sessionId}`);
          if (cancelled || state.state === 'pending') return;
          setCodexLogin(null);
          if (state.state === 'success') {
            setCodexLoginSuccess(true);
          } else {
            setError(state.error);
          }
          void refreshStatuses();
        } catch (err) {
          if (cancelled) return;
          setCodexLogin(null);
          setError(err instanceof Error ? err.message : 'Codex login stopped responding');
        }
      })();
    }, CODEX_LOGIN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [codexLogin, refreshStatuses]);

  const cancelCodexLogin = useCallback(() => {
    if (codexLogin) {
      void fetch(`/api/provider-auth/codex/login/${codexLogin.sessionId}`, { method: 'DELETE' });
    }
    setCodexLogin(null);
    setCodexLoginSuccess(false);
  }, [codexLogin]);

  const codexLogout = useCallback(async () => {
    setError(null);
    try {
      await fetchJson('/api/provider-auth/codex/logout', { method: 'POST', body: JSON.stringify({}) });
      setCodexLoginSuccess(false);
      void refreshStatuses();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to logout');
    }
  }, [refreshStatuses]);

  const codexConnecting = !!codexLogin;

  const claudeLine: StatusLine = !claudeStatus
    ? { tone: 'checking', text: 'Checking…' }
    : claudeStatus.available === false
      ? { tone: 'warn', text: claudeStatus.installed ? `Unavailable: ${claudeStatus.error}` : 'Claude Code is not installed on the machine running Lattice.' }
      : claudeLoggedIn
        ? { tone: 'ok', text: claudeSignedInText(claudeAuthMethod, claudeSubscription) }
        : { tone: 'off', text: 'Not signed in' };

  const codexLine: StatusLine = !codexStatus
    ? { tone: 'checking', text: 'Checking…' }
    : codexStatus.available === false
      ? { tone: 'warn', text: codexStatus.installed ? `Unavailable: ${codexStatus.detail}` : 'Codex is not installed on the machine running Lattice.' }
      : codexStatus.loggedIn
        ? { tone: 'ok', text: codexSignedInText(codexStatus.detail) }
        : { tone: 'off', text: 'Not signed in' };

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-fg-3">
        Lattice runs Claude Code and Codex on this machine with your own plans. Each keeps its own sign-in.
      </p>

      <ProviderCard
        name="Claude"
        line={claudeLine}
        statusTestId="claude-status"
        actions={claudeSignInOpen ? null : claudeStatus?.available === false && !claudeStatus.installed ? (
          <InstallActions provider="claude" onCheckAgain={() => void refreshStatuses()} />
        ) : claudeLoggedIn ? (
          <>
            <button onClick={openClaudeSignIn} className={QUIET_BTN} data-testid="claude-sign-in-again">
              Sign in again
            </button>
            <button onClick={() => void claudeLogout()} className={QUIET_BTN}>
              Sign out
            </button>
          </>
        ) : (
          <button onClick={openClaudeSignIn} disabled={!claudeStatus} className={PRIMARY_BTN} data-testid="claude-connect">
            <LogIn size={14} />
            <span>Sign in</span>
          </button>
        )}
      >
        {(claudeError || claudeLoginSuccess || claudeSignInOpen) && (
          <div className="px-4 pb-4 space-y-3">
            {claudeError && (
              <p className="text-xs text-rose-300" data-testid="claude-error">{claudeError}</p>
            )}
            {claudeLoginSuccess && (
              <div className="flex items-center gap-2 text-xs text-emerald-400" data-testid="claude-signed-in">
                <CheckCircle2 size={14} />
                <span>Signed in. Claude Code saved the login on this machine.</span>
              </div>
            )}
            {claudeSignInOpen && (
              <ClaudeLoginTerminal onFinished={onClaudeSignInFinished} onCancelled={onClaudeSignInCancelled} />
            )}
          </div>
        )}

        {!claudeSignInOpen && claudeStatus?.available !== false && (
          <div className="border-t border-line px-4 py-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <span className="text-xs text-fg-3">Conversations use</span>
              <div
                role="radiogroup"
                aria-label="How Claude conversations are billed"
                className="inline-flex items-center gap-0.5 rounded-md border border-line p-0.5"
              >
                {([['cli', 'Claude plan'], ['api-key', 'API key']] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={claudeAuthMode === mode}
                    onClick={() => { if (claudeAuthMode !== mode) void saveClaudeBilling({ mode }).catch(() => {}); }}
                    className={`px-2.5 py-1 text-xs rounded transition-colors cursor-pointer ${
                      claudeAuthMode === mode ? 'bg-surface-2 text-fg' : 'text-fg-3 hover:text-fg'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {claudeAuthMode === 'api-key' && (
              <p className={`text-xs ${anthropicKeyConfigured ? 'text-fg-3' : 'text-amber-300'}`}>
                {anthropicKeyConfigured
                  ? 'Billed per token to the Anthropic API key below.'
                  : 'No Anthropic API key saved below yet, so conversations still use the Claude sign-in.'}
              </p>
            )}
            {billingError && <p className="text-xs text-rose-300">{billingError}</p>}
          </div>
        )}
      </ProviderCard>

      <ClaudeEndpointsCard endpoints={endpoints} onSave={saveEndpoints} />

      <ProviderCard
        name="Codex"
        line={codexLine}
        actions={
          <>
            {codexStatus?.available === false && !codexStatus.installed ? (
              <InstallActions provider="codex" onCheckAgain={() => void refreshStatuses()} />
            ) : codexStatus?.loggedIn ? (
              <button onClick={() => void codexLogout()} disabled={codexConnecting} className={QUIET_BTN}>
                Sign out
              </button>
            ) : (
              <button
                onClick={() => void startCodexLogin()}
                disabled={codexConnecting || codexStarting}
                className={PRIMARY_BTN}
              >
                {codexStarting || codexConnecting ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
                <span>{codexConnecting ? 'Waiting…' : 'Sign in'}</span>
              </button>
            )}
            {codexConnecting && (
              <button onClick={cancelCodexLogin} className={QUIET_BTN}>
                Cancel
              </button>
            )}
          </>
        }
      >
        {(codexLoginSuccess || codexLogin) && (
          <div className="px-4 pb-4 space-y-3">
            {codexLoginSuccess && (
              <div className="flex items-center gap-2 text-xs text-emerald-400">
                <CheckCircle2 size={14} />
                <span>Signed in. Codex saved the login on this machine.</span>
              </div>
            )}
            {codexLogin && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <p className="text-xs text-fg-2">
                    1. Open the sign-in page and log in to ChatGPT:
                  </p>
                  <a
                    href={codexLogin.verificationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 text-xs text-accent hover:underline"
                  >
                    <ExternalLink size={12} />
                    <span>{codexLogin.verificationUrl}</span>
                  </a>
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-fg-2">
                    2. Enter this one-time code when asked (expires in 15 minutes):
                  </p>
                  <div className="flex items-center gap-3">
                    <code className="text-lg font-mono tracking-[0.2em] text-fg bg-bg border border-line-2 rounded-md px-3 py-2 select-all">
                      {codexLogin.userCode}
                    </code>
                    <span className="flex items-center gap-2 text-xs text-fg-3">
                      <Loader2 size={12} className="animate-spin" />
                      Waiting for sign-in…
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </ProviderCard>

      <ChatGPTPlanCard />
      <section className="border border-line rounded-lg bg-bg p-4 space-y-2">
        <SecretKeyField
          id="claude-anthropic-key"
          label="Anthropic API key"
          hint="Optional"
          placeholder="sk-ant-..."
          configured={anthropicKeyConfigured}
          onSave={(value) => saveClaudeBilling({ apiKey: value })}
        />
        <p className="text-xs text-fg-3">
          For background calls when Anthropic API billing is selected. Billed per token, separately from ChatGPT plan usage.
        </p>
      </section>

      {error && (
        <p className="text-xs text-rose-300">{error}</p>
      )}
    </div>
  );
}

type StatusLine = { tone: 'ok' | 'off' | 'warn' | 'checking'; text: string };

const QUIET_BTN = 'px-2.5 py-1.5 rounded-md text-[13px] text-fg-3 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50';
const PRIMARY_BTN = 'flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent-soft text-accent text-[13px] font-medium hover:bg-accent/20 transition-colors cursor-pointer disabled:opacity-50';

const STATUS_ICON: Record<StatusLine['tone'], JSX.Element> = {
  ok: <CheckCircle2 size={14} className="shrink-0 text-emerald-400" aria-hidden />,
  off: <CircleDashed size={14} className="shrink-0 text-fg-3" aria-hidden />,
  warn: <AlertTriangle size={14} className="shrink-0 text-amber-300" aria-hidden />,
  checking: <Loader2 size={14} className="shrink-0 text-fg-3 animate-spin" aria-hidden />,
};

/** "claude.ai" + "max" → "Signed in with your Claude Max plan". */
function claudeSignedInText(authMethod: string | null, subscription: string | null): string {
  if (authMethod !== 'claude.ai') return authMethod ? `Signed in (${authMethod})` : 'Signed in';
  const plan = subscription ? `Claude ${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}` : 'Claude';
  return `Signed in with your ${plan} plan`;
}

/** Rewords `codex login status` ("Logged in using ChatGPT") to match Claude's line. */
function codexSignedInText(detail: string): string {
  if (/chatgpt/i.test(detail)) return 'Signed in with your ChatGPT plan';
  if (/api key/i.test(detail)) return 'Signed in with an API key';
  return detail || 'Signed in';
}

/** One provider: name and sign-in state on the left, its actions on the right, detail below. */
function ProviderCard({ name, line, statusTestId, actions, children }: {
  name: string;
  line: StatusLine;
  statusTestId?: string;
  actions: React.ReactNode;
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <section className="border border-line rounded-lg bg-bg">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{name}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] text-fg-2" data-testid={statusTestId}>
            {STATUS_ICON[line.tone]}
            <span className={line.tone === 'ok' ? 'text-fg' : undefined}>{line.text}</span>
          </p>
        </div>
        {actions && <div className="flex items-center gap-1 shrink-0 -ml-2.5 sm:ml-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
