import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';

type GateState = 'checking' | 'open' | 'locked';

/**
 * On a server with `server.authToken` set, asks for the token once and lets
 * the server keep this browser signed in with a cookie. Without a token the
 * app renders straight away, as it always has.
 */
export function AuthGate({ children }: { children: React.ReactNode }): JSX.Element {
  const [state, setState] = useState<GateState>('checking');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/status')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as { required: boolean; authenticated: boolean };
        if (!cancelled) setState(body.required && !body.authenticated ? 'locked' : 'open');
      })
      // An unreachable server is the app's own error to show, as before the gate existed.
      .catch(() => { if (!cancelled) setState('open'); });
    return () => { cancelled = true; };
  }, []);

  if (state === 'checking') return <div className="min-h-dvh bg-bg" />;
  if (state === 'locked') return <TokenScreen onSignedIn={() => setState('open')} />;
  return <>{children}</>;
}

function TokenScreen({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        onSignedIn();
        return;
      }
      const body = await res.json().catch(() => ({})) as { error?: string };
      setError(body.error ?? `Sign-in failed (HTTP ${res.status})`);
    } catch (err) {
      setError(`Could not reach the Lattice server: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-bg flex items-center justify-center p-4">
      <form onSubmit={(e) => void submit(e)} className="max-w-sm w-full border border-line rounded-lg bg-surface">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <KeyRound size={16} className="text-accent" />
          <span className="text-sm font-medium text-fg">Access token</span>
        </div>
        <div className="p-4 space-y-3">
          <label htmlFor="lattice-access-token" className="block text-sm text-fg-2">
            This Lattice server needs its access token. You only enter it once on this browser.
          </label>
          <div className="relative">
            <input
              id="lattice-access-token"
              name="password"
              type={show ? 'text' : 'password'}
              value={token}
              onChange={(e) => { setToken(e.target.value); setError(null); }}
              autoComplete="current-password"
              autoFocus
              disabled={busy}
              className="w-full px-3 py-2 pr-10 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg placeholder:text-fg-3 focus:outline-none focus:border-accent disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShow(!show)}
              aria-label={show ? 'Hide token' : 'Show token'}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-3 hover:text-fg transition-colors cursor-pointer"
            >
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy || !token.trim()}
              className="px-3 py-2 rounded-md text-[13px] font-medium text-accent hover:bg-accent-soft transition-colors cursor-pointer disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : 'Continue'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
