/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardPaste, CornerDownLeft, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { parseJson } from '../../../../utils/json.js';

/**
 * Claude Code's own sign-in, shown in a terminal inside Lattice.
 *
 * The daemon runs `claude auth login` on a PTY; this draws its screen and
 * sends what the person types. Lattice does not read the URL or the code out
 * of the output: the link is tappable because the CLI prints it as one, and
 * the code goes wherever the CLI's prompt is. The attempt lives in the daemon,
 * so switching to the sign-in tab and back, or a dropped phone connection,
 * rejoins the same terminal.
 */

export type LoginAttemptState =
  | { phase: 'running'; startedAt: number; expiresAt: number }
  | { phase: 'succeeded'; startedAt: number; endedAt: number }
  | { phase: 'failed'; startedAt: number; endedAt: number; reason: string }
  | { phase: 'cancelled'; startedAt: number; endedAt: number };

interface ClaudeLoginTerminalProps {
  /** Called once the CLI has exited and its status has been checked. */
  onFinished: (state: Exclude<LoginAttemptState, { phase: 'running' }>) => void;
  /** Called when the person leaves the sign-in before it finished. */
  onCancelled: () => void;
}

const TERMINAL_ROWS = 12;
const INPUT_RETRIES = 2;

function newClientId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // Not JSON.
  }
  return `HTTP ${response.status}`;
}

function openLink(uri: string): void {
  window.open(uri, '_blank', 'noopener');
}

export function ClaudeLoginTerminal({ onFinished, onCancelled }: ClaudeLoginTerminalProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const attemptRef = useRef<string | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const clientIdRef = useRef(newClientId());
  const seqRef = useRef(0);
  const sendChain = useRef<Promise<void>>(Promise.resolve());
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'starting' | 'running' | 'reconnecting' | 'finished'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [showTypeBar, setShowTypeBar] = useState(false);
  const canReadClipboard = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;

  // Keystrokes leave in order and each carries its own sequence number, so a
  // request retried after a lost response is recognised and not typed twice.
  const sendInput = useCallback((data: string) => {
    const id = attemptRef.current;
    if (!id || !data) return;
    seqRef.current += 1;
    const seq = seqRef.current;
    sendChain.current = sendChain.current.then(async () => {
      for (let attempt = 0; attempt <= INPUT_RETRIES; attempt += 1) {
        try {
          const response = await fetch(`/api/provider-auth/claude/login-terminal/${id}/input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: clientIdRef.current, seq, data }),
          });
          if (response.ok) return;
          setError(await readError(response));
          return;
        } catch {
          if (attempt === INPUT_RETRIES) setError('Lost the connection while typing; check the terminal before typing again');
        }
      }
    });
  }, []);

  const sendResize = useCallback(() => {
    const id = attemptRef.current;
    const term = termRef.current;
    if (!id || !term) return;
    void fetch(`/api/provider-auth/claude/login-terminal/${id}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols: term.cols, rows: term.rows }),
    }).catch(() => {});
  }, []);

  const finish = useCallback((state: LoginAttemptState) => {
    if (state.phase === 'running') return;
    streamRef.current?.close();
    streamRef.current = null;
    setPhase('finished');
    onFinished(state);
  }, [onFinished]);

  // The screen, over Server-Sent Events. A `replay` frame is the whole history
  // so far, drawn on a cleared screen; `output` frames follow live.
  const openStream = useCallback((id: string) => {
    streamRef.current?.close();
    const source = new EventSource(`/api/provider-auth/claude/login-terminal/${id}/stream`);
    streamRef.current = source;
    source.addEventListener('replay', (event) => {
      const { data } = parseJson((event as MessageEvent<string>).data) as { data: string };
      termRef.current?.reset();
      termRef.current?.write(data);
      setPhase('running');
      setError(null);
      // On a phone the CLI's long link pushes the prompt and the buttons under
      // the fold; bring them up so the person sees where to paste.
      actionsRef.current?.scrollIntoView({ block: 'nearest' });
    });
    source.addEventListener('output', (event) => {
      const { data } = parseJson((event as MessageEvent<string>).data) as { data: string };
      termRef.current?.write(data);
    });
    source.addEventListener('state', (event) => {
      finish(parseJson((event as MessageEvent<string>).data) as LoginAttemptState);
    });
    source.addEventListener('error', (event) => {
      if ((event as MessageEvent<string>).data) {
        const { error: message } = parseJson((event as MessageEvent<string>).data) as { error: string };
        setError(message);
        source.close();
        return;
      }
      if (source.readyState === EventSource.CLOSED) {
        setError('Lost the connection to the sign-in terminal');
      } else {
        setPhase('reconnecting');
      }
    });
  }, [finish]);

  const start = useCallback(async (restart: boolean) => {
    const term = termRef.current;
    setError(null);
    setPhase('starting');
    seqRef.current = 0;
    try {
      const response = await fetch('/api/provider-auth/claude/login-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: term?.cols ?? 80, rows: term?.rows ?? TERMINAL_ROWS, restart }),
      });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      const result = await response.json() as { attemptId: string; state: LoginAttemptState; reused: boolean };
      attemptRef.current = result.attemptId;
      setAttemptId(result.attemptId);
      if (result.state.phase !== 'running') {
        finish(result.state);
        return;
      }
      openStream(result.attemptId);
      sendResize();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Claude sign-in');
    }
  }, [finish, openStream, sendResize]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      rows: TERMINAL_ROWS,
      cursorBlink: true,
      convertEol: false,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      scrollback: 2000,
      theme: { background: '#0b0b0d', foreground: '#e6e6e6', cursor: '#e6e6e6' },
      linkHandler: { activate: (_event, uri) => openLink(uri) },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    const inputDisposable = term.onData((data) => sendInput(data));

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fit.fit();
        sendResize();
      }, 150);
    });
    observer.observe(host);

    // A phone that comes back from the sign-in tab may find its stream gone
    // without a retry scheduled; rejoin the same attempt.
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      const id = attemptRef.current;
      if (id && (!streamRef.current || streamRef.current.readyState === EventSource.CLOSED)) openStream(id);
    };
    document.addEventListener('visibilitychange', onVisible);

    void start(false);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      inputDisposable.dispose();
      streamRef.current?.close();
      streamRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [openStream, sendInput, sendResize, start]);

  const cancel = useCallback(() => {
    const id = attemptRef.current;
    streamRef.current?.close();
    streamRef.current = null;
    if (id) void fetch(`/api/provider-auth/claude/login-terminal/${id}`, { method: 'DELETE' }).catch(() => {});
    onCancelled();
  }, [onCancelled]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
      termRef.current?.focus();
    } catch {
      setShowTypeBar(true);
    }
  }, [sendInput]);

  const sendTyped = useCallback(() => {
    if (!typed) return;
    sendInput(`${typed}\r`);
    setTyped('');
    setShowTypeBar(false);
    termRef.current?.focus();
  }, [sendInput, typed]);

  const running = phase === 'running' || phase === 'reconnecting';

  return (
    <div className="space-y-3" data-testid="claude-login-terminal">
      <p className="text-xs text-fg-2">
        This is Claude Code&apos;s own sign-in, running on the computer that runs Lattice.
        Tap the link it shows, sign in to Claude, then paste the code it gives you at the prompt.
      </p>

      <div
        ref={hostRef}
        className="rounded-md border border-line-2 bg-[#0b0b0d] p-2 overflow-hidden"
        data-testid="claude-login-screen"
        onClick={() => termRef.current?.focus()}
      />

      {phase === 'starting' && !error && (
        <p className="flex items-center gap-2 text-xs text-fg-3"><Loader2 size={12} className="animate-spin" />Starting Claude Code…</p>
      )}
      {phase === 'reconnecting' && (
        <p className="flex items-center gap-2 text-xs text-fg-3"><Loader2 size={12} className="animate-spin" />Reconnecting to the sign-in…</p>
      )}
      {error && <p className="text-xs text-rose-300">{error}</p>}

      <div ref={actionsRef} className="flex flex-wrap items-center gap-2">
        {running && (
          <>
            <button
              type="button"
              onClick={() => (canReadClipboard ? void pasteFromClipboard() : setShowTypeBar((open) => !open))}
              className="ui-action-btn flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer"
              data-testid="claude-login-paste"
            >
              <ClipboardPaste size={14} />
              <span>Paste</span>
            </button>
            <button
              type="button"
              onClick={() => { sendInput('\r'); termRef.current?.focus(); }}
              className="ui-action-btn flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer"
              data-testid="claude-login-enter"
            >
              <CornerDownLeft size={14} />
              <span>Enter</span>
            </button>
          </>
        )}
        {error && attemptId && (
          <button
            type="button"
            onClick={() => void start(true)}
            className="ui-action-btn flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer"
            data-testid="claude-login-retry"
          >
            <RefreshCw size={14} />
            <span>Start over</span>
          </button>
        )}
        <button
          type="button"
          onClick={cancel}
          className="ui-action-btn ui-action-btn--rose flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer ml-auto"
          data-testid="claude-login-cancel"
        >
          <XCircle size={14} />
          <span>Cancel</span>
        </button>
      </div>

      {showTypeBar && running && (
        <div className="space-y-1">
          <p className="text-xs text-fg-3">Paste here if the terminal will not take a paste; it is typed into the prompt, then Enter.</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') sendTyped(); }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Type into the terminal"
              className="flex-1 text-xs font-mono bg-bg border border-line-2 rounded-md px-3 py-2 text-fg placeholder:text-fg-3 focus:outline-none focus:border-accent"
              data-testid="claude-login-typebar"
            />
            <button
              type="button"
              onClick={sendTyped}
              disabled={!typed}
              className="px-3 py-2 rounded-md text-[13px] font-medium text-accent hover:bg-accent-soft transition-colors cursor-pointer disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
