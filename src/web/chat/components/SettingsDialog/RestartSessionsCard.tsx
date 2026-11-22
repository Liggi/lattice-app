import { type JSX, useState } from 'react';
import { Check, Loader2, RotateCw } from 'lucide-react';

const QUIET_BTN = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[13px] text-fg-3 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50';

/** "3 restarted", "Nothing to restart", with sessions left running after it. */
function resultText(restarted: number, kept: number): string {
  const done = restarted ? `${restarted} restarted` : 'Nothing to restart';
  return kept ? `${done} · ${kept} busy, left running` : done;
}

/** Ends idle sessions' Claude Code and Codex processes so each starts fresh on its next message. */
export function RestartSessionsCard(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null);

  const restart = async () => {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch('/api/sessions/restart-idle', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = (await response.json().catch(() => ({}))) as { restarted?: number; kept?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setResult({ text: resultText(data.restarted ?? 0, data.kept ?? 0), failed: false });
    } catch (error) {
      setResult({ text: `Could not restart: ${error instanceof Error ? error.message : String(error)}`, failed: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border border-line rounded-lg bg-bg" data-testid="restart-sessions">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-4">
        <div className="min-w-[14rem] flex-1">
          <p className="text-sm font-medium text-fg">Pick up new sign-ins and settings</p>
          <p className="mt-1 text-[13px] text-fg-3">
            For MCP sign-ins and settings changed outside Lattice. Idle sessions restart and use them from their next message.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {result && (
            <span className={`flex items-center gap-1 text-[13px] ${result.failed ? 'text-rose-300' : 'text-fg-2'}`} data-testid="restart-sessions-result">
              {!result.failed && <Check size={14} className="text-emerald-400" aria-hidden />}
              {result.text}
            </span>
          )}
          <button
            onClick={() => void restart()}
            disabled={busy}
            className={QUIET_BTN}
            title="Sessions still working keep running"
            data-testid="restart-sessions-button"
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RotateCw size={14} aria-hidden />}
            Restart
          </button>
        </div>
      </div>
    </section>
  );
}
