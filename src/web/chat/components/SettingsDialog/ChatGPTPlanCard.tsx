import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@liggi/agent-ui-toolkit';
import { parseJson } from '../../../../utils/json.js';

interface PlanStatus {
  active: string | null;
  accounts: Array<{ id: string; label: string; connected: boolean; planEnabled: boolean; paused: string | null; verifiedModel: string | null; welcomed: boolean }>;
  routing: { provider: 'anthropic-api' | 'chatgpt-plan'; model?: string };
  usage: { calls: number; inputTokens: number; outputTokens: number };
  pendingLogin: PendingLogin | null;
}
interface PendingLogin { id: string; launchPath: string; expiresAt: number }
interface ModelChoice { slug: string; display_name: string }

const ACTION = 'px-3 py-1.5 rounded-md bg-accent-soft text-accent text-[13px] font-medium hover:bg-accent/20 cursor-pointer disabled:opacity-50';
const QUIET = 'text-[13px] text-fg-3 hover:text-fg cursor-pointer disabled:opacity-50';
const SIGN_IN = 'inline-flex items-center gap-1 rounded-md bg-white pl-1 pr-3 py-1 text-[13px] font-medium text-black hover:bg-gray-100 disabled:opacity-50 cursor-pointer';

const SIGN_IN_ERRORS: Record<string, string> = {
  login_expired: 'This sign-in has expired. Start again with Continue with ChatGPT.',
  invalid_callback_address: 'That is not the sign-in address. Copy the whole address of the page that failed to load, starting with 127.0.0.1.',
  invalid_oauth_state: 'That address is from a different sign-in. Copy it from the most recent attempt.',
  authorization_declined: 'Sign-in was declined on ChatGPT, so nothing was connected.',
  invalid_grant: 'ChatGPT did not accept that sign-in; it may have expired. Start again.',
};
const signInError = (code?: string) => SIGN_IN_ERRORS[code ?? ''] ?? `Sign-in did not complete (${code ?? 'unknown error'}).`;

const withMonoAddress = (text: string) => text.split('127.0.0.1').flatMap((part, index) => index === 0 ? [part] : [<span key={index} className="font-mono">127.0.0.1</span>, part]);

const SIGN_IN_KEY = 'lattice.chatgptPlanSignIn';
const rememberSignIn = (expiresAt?: number) => { try { if (expiresAt) localStorage.setItem(SIGN_IN_KEY, String(expiresAt)); else localStorage.removeItem(SIGN_IN_KEY); } catch { /* storage unavailable */ } };
/** True while a sign-in started from another device may still be waiting for its pasted address, so Settings reopens after the page reloads. */
export function planSignInWaiting(): boolean {
  try { return Number(localStorage.getItem(SIGN_IN_KEY)) > Date.now(); } catch { return false; }
}
const looksLikeCallback = (text: string) => /\/auth\/callback\?/.test(text) && /[?&]state=/.test(text);

async function requestPlan<Value>(endpoint: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Value> {
  const response = await fetch(`/api/chatgpt-plan/${endpoint}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = parseJson(await response.text()) as Value & { error?: string; code?: string };
  if (!response.ok) throw new Error(result.code === 'subscription_sharing_usage_limit_exceeded' ? 'Usage limit reached. Manage usage in ChatGPT, then resume requests here.'
    : endpoint.startsWith('login/') && result.code ? signInError(result.code) : result.error ?? 'Could not complete the ChatGPT plan action.');
  return result;
}

export function ChatGPTPlanCard(): JSX.Element {
  const [status, setStatus] = useState<PlanStatus | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<PendingLogin | null>(null);
  const card = useRef<HTMLElement>(null);
  const [pasted, setPasted] = useState('');
  const localBrowser = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  const pasting = !!attempt && !localBrowser;
  const active = status?.accounts.find((account) => account.id === status.active);
  const usingPlan = status?.routing.provider === 'chatgpt-plan';

  const refresh = useCallback(async () => {
    const result = await requestPlan<PlanStatus>('status');
    setStatus(result);
    if (!result.pendingLogin) rememberSignIn();
    return result;
  }, []);

  const endAttempt = () => { setAttempt(null); setPasted(''); rememberSignIn(); };
  useEffect(() => {
    void refresh().then((result) => {
      if (!result.pendingLogin) return;
      setAttempt(result.pendingLogin);
      if (!localBrowser) rememberSignIn(result.pendingLogin.expiresAt);
      card.current?.scrollIntoView({ block: 'start' });
    }).catch((failure: Error) => setError(failure.message));
  }, [refresh, localBrowser]);
  useEffect(() => {
    if (!attempt) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void requestPlan<{ phase: string; error?: string }>(`login/${attempt.id}`).then(async (result) => {
        if (!alive || result.phase === 'pending') return;
        endAttempt();
        if (result.phase === 'failed') setError(signInError(result.error));
        await refresh();
      }).catch((failure: Error) => { if (alive) { endAttempt(); setError(failure.message); } });
    }, 1500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [attempt, refresh]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Action failed.'); }
    finally { setBusy(false); await refresh().catch((failure: Error) => setError(failure.message)); }
  };

  const beginLogin = (accountId?: string, enablePlan = false) => {
    const tab = window.open('about:blank', '_blank');
    if (!tab) { setError('Allow a new tab for ChatGPT sign-in and try again.'); return; }
    void act(async () => {
      try {
        const login = await requestPlan<{ id: string; launchPath: string }>('login', { accountId, enablePlan });
        const expiresAt = Date.now() + 10 * 60 * 1000;
        tab.location.href = login.launchPath; setAttempt({ ...login, expiresAt });
        if (!localBrowser) rememberSignIn(expiresAt);
      } catch (failure) { tab.close(); throw failure; }
    });
  };
  const finishPasted = (url = pasted) => void act(async () => {
    if (!attempt) return;
    try {
      const result = await requestPlan<{ phase: string; error?: string }>(`login/${attempt.id}/callback`, { url });
      endAttempt();
      if (result.phase === 'failed') throw new Error(signInError(result.error));
    } catch (failure) {
      const current = await requestPlan<{ phase: string }>(`login/${attempt.id}`).catch(() => ({ phase: 'failed' }));
      if (current.phase !== 'pending') endAttempt();
      throw failure;
    }
  });
  const signIn = () => beginLogin(active?.id, active?.connected === true && !active.planEnabled);
  const cancelAttempt = () => void act(async () => { if (attempt) await requestPlan(`login/${attempt.id}`, undefined, 'DELETE'); endAttempt(); });
  const acknowledgeWelcome = () => void act(async () => { await requestPlan('welcome', {}); });
  const showWelcome = usingPlan === true && !!active?.verifiedModel && !active.welcomed;
  const routingLabel = !usingPlan ? 'Background calls currently use the Anthropic API key, if configured.'
    : !active?.connected ? 'ChatGPT plan selected; requests wait for sign-in.'
    : active.paused ? 'ChatGPT plan selected; requests are paused.'
    : !active.planEnabled || active.verifiedModel !== status?.routing.model ? 'ChatGPT plan selected; test a model to resume requests.'
    : 'Using ChatGPT plan';

  return (
    <section ref={card} className="border border-line rounded-lg bg-bg p-4 space-y-3 scroll-mt-4" aria-label="Background inference">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium text-fg">Use your ChatGPT plan</h3>
          <p className="text-[13px] text-fg-2">For Lattice’s background summaries, activity labels, insights and project names. Separate from Codex sign-in.</p>
        </div>
        {status && !attempt && !active?.connected && <button type="button" onClick={signIn} disabled={busy || !!attempt} className={SIGN_IN}><img src="/chatgpt-mark.svg" alt="" className="h-8 w-8" />Continue with ChatGPT</button>}
      </div>
      {!status && !error && <p className="flex items-center gap-2 text-[13px] text-fg-3"><Loader2 size={14} className="animate-spin" />Checking connection…</p>}
      {status && !attempt && <p className="text-[13px] text-fg-2">{routingLabel} <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">Manage usage <ExternalLink size={12} /></a></p>}
      {active?.connected && !pasting && <div className="space-y-3">
        <label className="block space-y-1 text-[13px] text-fg-2">ChatGPT account
          <select aria-label="ChatGPT account" value={status?.active ?? ''} disabled={busy} onChange={(event) => {
            const accountId = event.target.value; setModels([]); setModel('');
            void act(async () => { await requestPlan('account', { accountId }); });
          }} className="block w-full min-w-0 rounded-md border border-line-2 bg-surface px-2 py-2 text-fg">
            {status?.accounts.filter((account) => account.connected).map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
          </select>
        </label>
        {!active.planEnabled && <div className="space-y-2"><p className="text-[13px] text-amber-300">Signed in, but permission to use your plan is not enabled.</p>{!attempt && <button type="button" className={SIGN_IN} onClick={signIn} disabled={busy || !!attempt}><img src="/chatgpt-mark.svg" alt="" className="h-8 w-8" />Continue with ChatGPT</button>}</div>}
        {active.planEnabled && !active.paused && <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex-1 min-w-0 space-y-1 text-[13px] text-fg-2">Background model
              <select aria-label="Background model" value={model} onChange={(event) => setModel(event.target.value)} disabled={busy || models.length === 0} className="block w-full min-w-0 rounded-md border border-line-2 bg-surface px-2 py-2 text-fg">
                <option value="">{models.length ? 'Choose a discovered model' : 'Load models for this account'}</option>
                {models.map((choice) => <option key={choice.slug} value={choice.slug}>{choice.display_name}</option>)}
              </select>
            </label>
            <button type="button" disabled={busy} className={QUIET} onClick={() => void act(async () => {
              const catalog = await requestPlan<{ models: ModelChoice[] }>('models'); setModels(catalog.models);
              setModel(catalog.models.some((choice) => choice.slug === status?.routing.model) ? status!.routing.model! : '');
            })}>Refresh models</button>
          </div>
          {active.verifiedModel && usingPlan && <p className="flex items-center gap-1.5 text-[13px] text-fg"><CheckCircle2 size={14} className="text-emerald-400 shrink-0" />Verified model: {active.verifiedModel}</p>}
          <button type="button" disabled={busy || !model} className={ACTION} onClick={() => void act(async () => { await requestPlan('activate', { model }); })}>{busy ? 'Checking…' : 'Test and use ChatGPT plan'}</button>
        </div>}
        {active.paused && <div className="space-y-2">
          <p className="flex items-start gap-2 text-[13px] text-amber-300"><AlertTriangle size={14} className="shrink-0 mt-0.5" />Usage limit reached. New plan requests are paused; no paid API fallback is used.</p>
          <a className={`${ACTION} inline-block`} href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage</a>
          <button type="button" className={`${QUIET} ml-3`} disabled={busy} onClick={() => void act(async () => { await requestPlan('resume', {}); })}>Resume after reviewing usage</button>
        </div>}
        <p className="text-xs text-fg-3">Feature opt-ins stay unchanged. Plan usage is tracked separately from API-dollar estimates. Lattice never enables credits.</p>
        {usingPlan && <p className="text-xs text-fg-3">Recorded plan calls: {status?.usage.calls}. This is not a measure of your remaining allowance.</p>}
        <div className="flex flex-wrap gap-4">
          <button type="button" disabled={busy} className={QUIET} onClick={() => void act(async () => {
            const result = await requestPlan<{ revoked: boolean }>('disconnect', {}); setModels([]); setModel('');
            if (!result.revoked) setError('Local credentials cleared. Remote revocation was not confirmed; disconnect Lattice in ChatGPT Settings.');
          })}>Disconnect</button>
          <button type="button" disabled={busy || !!attempt} className={QUIET} onClick={() => beginLogin()}>Add another account</button>
          {usingPlan && <button type="button" disabled={busy} className={QUIET} onClick={() => void act(async () => {
            const response = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backgroundInference: { provider: 'anthropic-api' } }) });
            if (!response.ok) throw new Error('Could not select Anthropic API billing.');
          })}>Use Anthropic API billing instead</button>}
        </div>
      </div>}
      {attempt && localBrowser && <div className="flex flex-wrap items-center gap-3 text-[13px] text-fg-2"><Loader2 size={14} className="animate-spin" />Waiting for sign-in…<button type="button" className={QUIET} onClick={cancelAttempt}>Cancel</button></div>}
      {pasting && <div className="space-y-3 text-[13px] text-fg-2">
        <p>Approve Lattice in the ChatGPT tab. That tab then shows a page that can’t load, at an address starting <span className="font-mono text-fg">127.0.0.1</span>. That’s expected: copy that whole address and paste it here.</p>
        <input type="text" inputMode="url" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Sign-in address" value={pasted} disabled={busy}
          onChange={(event) => setPasted(event.target.value)}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (!looksLikeCallback(text)) return;
            event.preventDefault(); setPasted(text); finishPasted(text);
          }}
          placeholder="Paste the 127.0.0.1 address" className="block w-full min-w-0 rounded-md border border-line-2 bg-surface px-2 py-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-3" />
        {error && <p role="alert" className="text-[13px] text-rose-300 break-words">{withMonoAddress(error)}</p>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button type="button" className={ACTION} disabled={busy || !pasted.trim()} onClick={() => finishPasted()}>{busy ? 'Finishing…' : 'Finish sign-in'}</button>
          <button type="button" className={QUIET} disabled={busy} onClick={cancelAttempt}>Cancel</button>
        </div>
        <p className="text-xs text-fg-3">Pasting finishes the sign-in. It stays open until {new Date(attempt!.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, even if this page reloads. Closed the ChatGPT tab? <button type="button" onClick={() => window.open(attempt!.launchPath, '_blank', 'noreferrer')} className="text-accent hover:underline cursor-pointer">Reopen it</button>.</p>
      </div>}
      <Dialog open={showWelcome} onOpenChange={(open) => { if (!open && !busy) acknowledgeWelcome(); }}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md bg-surface border-line p-5">
          <DialogTitle className="pr-6 text-base text-fg">You’re using your ChatGPT plan</DialogTitle>
          <DialogDescription className="text-[13px] text-fg-2">Enabled background features now use your selected ChatGPT model. Manage your plan and app limits in ChatGPT settings. Other feature opt-ins have not changed.</DialogDescription>
          <button type="button" disabled={busy} className={`${ACTION} justify-self-start`} onClick={acknowledgeWelcome}>Got it</button>
        </DialogContent>
      </Dialog>
      {error && !pasting && <p role="alert" className="text-[13px] text-rose-300 break-words">{withMonoAddress(error)}</p>}
    </section>
  );
}
