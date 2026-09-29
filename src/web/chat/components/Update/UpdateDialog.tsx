/* oxlint-disable react-doctor/no-cascading-set-state */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleArrowUp, Copy, Loader2, X } from 'lucide-react';
import { api } from '../../services/api';
import { markdownComponents } from '../MessageList/MessageItem';
import { PRIMARY_BTN, QUIET_BTN } from '../Feedback/FeedbackCheck';
import { updateStatusQueryKey } from '../../hooks/useUpdateStatus';
import type { UpdateStatus } from '@/types/update';

const POLL_MS = 1_000;
/** How long the page waits for the restarted server before saying it hasn't come back. */
const RESTART_GIVE_UP_MS = 120_000;

interface UpdateDialogProps {
  status: UpdateStatus;
  onClose: () => void;
}

/** Reads /api/update without the api client, whose failures while the server restarts would count as network trouble. */
async function pollStatus(): Promise<UpdateStatus | null> {
  try {
    const res = await fetch('/api/update', { cache: 'no-store' });
    return res.ok ? await res.json() as UpdateStatus : null;
  } catch {
    return null;
  }
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function UpdateDialog({ status: initial, onClose }: UpdateDialogProps): JSX.Element {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState(initial);
  const [startError, setStartError] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [copied, setCopied] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const target = initial.latest ?? '';

  const notes = useQuery({
    queryKey: ['update', 'notes', target],
    queryFn: async () => (await api.getReleaseNotes()).notes,
    staleTime: Infinity,
    retry: false,
  });

  const busy = status.phase === 'installing' || status.phase === 'restarting';

  // The sidebar line and Settings read the same status.
  useEffect(() => {
    queryClient.setQueryData(updateStatusQueryKey, status);
  }, [queryClient, status]);

  // While it installs and restarts, follow the server until it answers as the new version, then reload into it.
  useEffect(() => {
    if (!busy) return;
    let cancelled = false;
    const startedAt = Date.now();
    const tick = async () => {
      const next = await pollStatus();
      if (cancelled) return;
      if (next && next.current === target) {
        window.location.reload();
        return;
      }
      if (next) setStatus(next);
      else setStatus((s) => ({ ...s, phase: 'restarting' }));
      if (next && next.phase !== 'installing' && next.phase !== 'restarting') {
        void queryClient.invalidateQueries({ queryKey: updateStatusQueryKey });
        return;
      }
      if (!next && Date.now() - startedAt > RESTART_GIVE_UP_MS) {
        setGaveUp(true);
        return;
      }
      window.setTimeout(() => void tick(), POLL_MS);
    };
    const first = window.setTimeout(() => void tick(), POLL_MS);
    return () => { cancelled = true; window.clearTimeout(first); };
  }, [busy, target, queryClient]);

  const update = async () => {
    setStartError(null);
    setShowOutput(false);
    try {
      setStatus(await api.startUpdate());
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyCommand = (command: string) => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const { install } = status;
  const failure = status.phase === 'failed' ? status.error : null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center sm:items-center"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
        paddingRight: 'calc(env(safe-area-inset-right, 0px) + 1rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
        paddingLeft: 'calc(env(safe-area-inset-left, 0px) + 1rem)',
      }}
      data-testid="update-dialog"
    >
      <button type="button" className="absolute inset-0 bg-black/50" onClick={busy ? undefined : onClose} aria-label="Close" />

      <div className="relative z-10 w-full max-w-xl bg-surface border border-line rounded-lg overflow-hidden max-h-[calc(100dvh-2rem)] sm:max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
          <div className="flex items-baseline gap-2 min-w-0">
            <CircleArrowUp size={16} className="text-accent shrink-0 self-center" />
            <span className="text-sm font-medium text-fg">Lattice {target}</span>
            <span className="text-xs text-fg-3">You have {status.current}</span>
          </div>
          {!busy && (
            <button onClick={onClose} className="shrink-0 p-1 rounded-sm text-fg-3 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer" aria-label="Close">
              <X size={16} />
            </button>
          )}
        </div>

        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {notes.isLoading ? (
            <Loader2 size={16} className="animate-spin text-fg-3" />
          ) : notes.isError ? (
            <p className="text-sm text-fg-2">The release notes could not be loaded from GitHub.</p>
          ) : !notes.data?.length ? (
            <p className="text-sm text-fg-2">No release notes were published for {target}.</p>
          ) : (
            notes.data.map((note) => (
              <section key={note.version} className="space-y-1.5">
                {notes.data.length > 1 && (
                  <div className="flex items-baseline justify-between gap-3">
                    <a href={note.url} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-fg hover:text-accent">
                      {note.name}
                    </a>
                    <span className="text-xs text-fg-3 tabular-nums">{formatDate(note.publishedAt)}</span>
                  </div>
                )}
                <div className="prose max-w-none text-sm leading-[1.55] dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{note.body || 'No notes for this version.'}</ReactMarkdown>
                </div>
              </section>
            ))
          )}

          {!install.canUpdate && install.command && (
            <div className="space-y-2 border-t border-line pt-4" data-testid="update-manual">
              <p className="text-xs text-fg-2">{install.reason}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg break-all">
                  {install.command}
                </code>
                <button onClick={() => copyCommand(install.command!)} className="ui-icon-btn p-2 cursor-pointer" aria-label="Copy command">
                  {copied ? <CheckCircle2 size={16} className="text-emerald-400" /> : <Copy size={16} />}
                </button>
              </div>
            </div>
          )}
        </div>

        {install.canUpdate && (failure || startError || gaveUp) && (
          <div className="px-4 pb-3 space-y-2" data-testid="update-failed">
            <div className="flex items-start gap-2 text-xs text-rose-300">
              <AlertTriangle size={14} className="shrink-0 mt-px" />
              <span>
                {gaveUp
                  ? `Lattice hasn't come back after the restart. Look at the terminal or service it runs in; reload this page once it is up.`
                  : failure?.message ?? startError}
              </span>
            </div>
            {failure?.output && (
              <>
                <button onClick={() => setShowOutput((open) => !open)} className="flex items-center gap-1 text-xs font-medium text-fg-3 hover:text-fg cursor-pointer">
                  {showOutput ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  What npm said
                </button>
                {showOutput && (
                  <pre className="max-h-48 overflow-auto rounded-md bg-bg px-3 py-2 text-[11px] font-mono text-fg-2 whitespace-pre-wrap">{failure.output}</pre>
                )}
              </>
            )}
          </div>
        )}

        {/* On a phone the note sits above the buttons rather than squeezed beside them. */}
        <div className="px-4 py-3 border-t border-line flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {install.canUpdate && !busy ? (
            <p className="text-xs text-fg-3">Updating restarts Lattice. A turn that is running gets cut off and carries on after the restart.</p>
          ) : <span className="hidden sm:block" />}
          <div className="flex shrink-0 items-center justify-end gap-2">
            {!install.canUpdate ? (
              <button onClick={onClose} className={PRIMARY_BTN}>Done</button>
            ) : busy && !gaveUp ? (
              <span className="flex items-center gap-2 text-[13px] text-fg-2" data-testid="update-progress">
                <Loader2 size={14} className="animate-spin" />
                {status.phase === 'installing' ? `Installing ${target}` : 'Restarting Lattice'}
              </span>
            ) : gaveUp ? (
              <button onClick={() => window.location.reload()} className={PRIMARY_BTN}>Reload</button>
            ) : (
              <>
                <button onClick={onClose} className={QUIET_BTN}>Not now</button>
                <button onClick={() => void update()} className={PRIMARY_BTN} data-testid="update-start">
                  {failure || startError ? 'Try again' : 'Update and restart'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
