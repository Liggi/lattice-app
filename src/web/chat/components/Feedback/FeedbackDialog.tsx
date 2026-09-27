/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Loader2, MessageSquare, X } from 'lucide-react';
import { api } from '../../services/api';
import { useFeedbackStatus, useInvalidateFeedback } from '../../hooks/useFeedback';
import { CATEGORIES, errorText, FeedbackCheck, needsCheck, PRIMARY_BTN, QUIET_BTN, SentFields, WhatIsSentToggle } from './FeedbackCheck';
import {
  FEEDBACK_MESSAGE_MAX,
  type FeedbackCategory,
  type FeedbackContext,
  type FeedbackDraftView,
  type FeedbackReceipt,
  type FeedbackScreen,
  type FeedbackSendError,
} from '@/types/feedback';

type Step =
  | { kind: 'edit' }
  | { kind: 'check'; draft: FeedbackDraftView }
  | { kind: 'sending'; draft: FeedbackDraftView }
  | { kind: 'sent'; receipt: FeedbackReceipt }
  | { kind: 'failed'; draft: FeedbackDraftView; error: FeedbackSendError };

interface FeedbackDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The session the feedback is about; null for feedback about Lattice in general. */
  conversationId: string | null;
  screen: FeedbackScreen;
  /** An existing draft to review, such as one an agent proposed. */
  draftId?: string | null;
}

function codePoints(text: string): number {
  return [...text].length;
}

export function FeedbackDialog({ isOpen, onClose, conversationId, screen, draftId = null }: FeedbackDialogProps): JSX.Element | null {
  const status = useFeedbackStatus();
  const invalidate = useInvalidateFeedback();
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [showFields, setShowFields] = useState(false);
  const [message, setMessage] = useState('');
  const [existing, setExisting] = useState<FeedbackDraftView | null>(null);
  const [context, setContext] = useState<FeedbackContext | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'edit' });
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  /** A draft this dialog made that has not been tried yet; closing removes it. */
  const untriedDraft = useRef<string | null>(null);

  const enabled = status?.enabled === true;

  useEffect(() => {
    if (!isOpen) return;
    setStep({ kind: 'edit' });
    setError(null);
    setExisting(null);
    setContext(null);
    untriedDraft.current = null;
    if (!draftId) {
      setCategory('bug');
      setMessage('');
    }
  }, [isOpen, draftId]);

  // What the draft will carry besides the text: the draft's own payload when
  // reviewing one, else what a new draft here would get.
  useEffect(() => {
    if (!isOpen || !enabled) return;
    let cancelled = false;
    const load = draftId
      ? api.getFeedbackDraft(draftId).then((draft) => {
        if (cancelled) return;
        setExisting(draft);
        setCategory(draft.category);
        setMessage(draft.message);
        if (draft.lastError) setStep({ kind: 'failed', draft, error: draft.lastError });
      })
      : api.getFeedbackContext(conversationId).then((ctx) => { if (!cancelled) setContext(ctx); });
    load.catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [isOpen, enabled, draftId, conversationId]);

  if (!isOpen) return null;

  const close = () => {
    const leftover = untriedDraft.current;
    untriedDraft.current = null;
    if (leftover) void api.deleteFeedbackDraft(leftover).catch(() => {}).finally(() => void invalidate());
    else void invalidate();
    onClose();
  };

  /** Switched off in Settings: switch it back on here. The check waits for the first send. */
  const turnOn = async () => {
    setError(null);
    try {
      await api.updateFeedbackSettings({ enabled: true });
      await invalidate();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const length = codePoints(message);
  const tooLong = length > FEEDBACK_MESSAGE_MAX;
  // Send only once the page shows every field that will go.
  const detailsLoaded = Boolean(existing ?? context);
  const canSend = message.trim().length > 0 && !tooLong && !working && detailsLoaded;

  /** Save exactly what is on screen as the draft, then send it. */
  const startSend = async () => {
    setWorking(true);
    setError(null);
    let draft: FeedbackDraftView;
    try {
      if (existing) {
        draft = await api.updateFeedbackDraft(existing.id, { category, message });
      } else {
        draft = await api.createFeedbackDraft({ category, message, conversationId, screen });
        untriedDraft.current = draft.id;
      }
      setExisting(draft);
    } catch (err) {
      setError(errorText(err));
      setWorking(false);
      return;
    }
    setWorking(false);
    await send(draft);
  };

  const send = async (draft: FeedbackDraftView) => {
    untriedDraft.current = null;
    setStep({ kind: 'sending', draft });
    try {
      const result = await api.sendFeedbackDraft(draft.id, draft.revision);
      if (result.sent && result.receipt) setStep({ kind: 'sent', receipt: result.receipt });
      else setStep({ kind: 'failed', draft: result.draft ?? draft, error: result.error ?? { code: 'unknown', message: 'Not sent.', at: new Date().toISOString() } });
    } catch (err) {
      if (needsCheck(err)) setStep({ kind: 'check', draft });
      else setStep({ kind: 'failed', draft, error: { code: 'local', message: errorText(err), at: new Date().toISOString() } });
    }
    void invalidate();
  };

  const deleteDraft = async () => {
    if (!existing) return;
    setWorking(true);
    try {
      await api.deleteFeedbackDraft(existing.id);
      untriedDraft.current = null;
      await invalidate();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const locked = step.kind !== 'edit' && step.kind !== 'failed';
  const fromAgent = existing?.source === 'agent';
  const payload = existing?.payload;
  const scope = payload?.scope ?? context?.scope ?? (conversationId ? 'session' : 'app');
  const fields = payload ?? (context ? {
    scope: context.scope,
    session_ref: context.sessionRef,
    provider: context.provider,
    model: context.model,
    lattice_version: context.latticeVersion,
    screen,
    install_id: context.installId,
  } : null);
  const destination = existing?.collectorOrigin ?? context?.collectorOrigin ?? status?.collectorOrigin ?? '';
  const stranded = existing ? !existing.sendable : false;

  const title = fromAgent ? 'Feedback an agent proposed' : 'Send feedback';
  const subtitle = scope === 'session' ? 'About this session' : 'About Lattice';

  // On the body, not where it is opened: iOS clips a fixed element to the
  // Settings scroller it sits in, and the form could not be scrolled.
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center sm:items-center"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
        paddingRight: 'calc(env(safe-area-inset-right, 0px) + 1rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
        paddingLeft: 'calc(env(safe-area-inset-left, 0px) + 1rem)',
      }}
      data-testid="feedback-dialog"
    >
      <button type="button" className="absolute inset-0 bg-black/50" onClick={close} aria-label="Close feedback" />

      <div className="relative z-10 w-full max-w-xl bg-surface border border-line rounded-lg overflow-hidden max-h-[calc(100dvh-2rem)] sm:max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
          <div className="flex items-center gap-2 min-w-0">
            <MessageSquare size={16} className="text-fg-3 shrink-0" />
            <span className="text-sm font-medium text-fg">{title}</span>
            {enabled && <span className="text-xs text-fg-3">{subtitle}</span>}
          </div>
          <button onClick={close} className="shrink-0 p-1 rounded-sm text-fg-3 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {!status ? (
            <Loader2 size={16} className="animate-spin text-fg-3" />
          ) : !enabled ? (
            <div className="space-y-3" data-testid="feedback-opt-in">
              <p className="text-sm text-fg">Feedback is switched off on this Lattice.</p>
              <ul className="space-y-1.5 text-xs text-fg-2 list-disc pl-4">
                <li>Switching it on lets you send feedback about Lattice to its maintainer. It sends nothing by itself.</li>
                <li>Only messages you send leave this machine. You see exactly what each one contains first.</li>
                <li>Agents can propose feedback. It appears in your chat for you to send, edit or reject.</li>
                <li>Messages are kept on Cloudflare for 90 days, and a Cloudflare-hosted model flags off-topic or abusive ones.</li>
              </ul>
              {status.collectorProblem && <p className="text-xs text-rose-300">{status.collectorProblem}</p>}
            </div>
          ) : step.kind === 'sent' ? (
            <div className="space-y-2" data-testid="feedback-sent">
              <div className="flex items-center gap-2 text-sm text-emerald-400">
                <CheckCircle2 size={16} />
                <span>Received by the feedback service</span>
              </div>
              <p className="text-xs text-fg-3">
                It is stored for the maintainer to read; that does not mean it has been read yet. Reference <span className="font-mono">{step.receipt.id}</span>.
              </p>
            </div>
          ) : (
            <>
              {stranded && (
                <p className="text-xs text-amber-300">
                  This draft was made for a different feedback destination ({existing?.collectorOrigin}). It can only be deleted.
                </p>
              )}

              <div
                role="radiogroup"
                aria-label="Kind of feedback"
                className="inline-flex items-center gap-0.5 rounded-md border border-line p-0.5"
              >
                {CATEGORIES.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={category === value}
                    disabled={locked || stranded}
                    onClick={() => setCategory(value)}
                    className={`px-2.5 py-1 text-xs rounded transition-colors cursor-pointer disabled:cursor-default ${
                      category === value ? 'bg-surface-2 text-fg' : 'text-fg-3 hover:text-fg'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="space-y-1">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  readOnly={locked || stranded}
                  rows={7}
                  placeholder={scope === 'session' ? 'What went wrong or could be better in this session?' : 'What went wrong or could be better in Lattice?'}
                  aria-label="Feedback message"
                  data-testid="feedback-message"
                  className="w-full px-3 py-2 bg-bg border border-line-2 rounded-md text-sm text-fg focus:outline-none focus:border-accent resize-y read-only:text-fg-2"
                />
                <div className={`text-right text-[11px] font-mono ${tooLong ? 'text-rose-300' : 'text-fg-3'}`}>
                  {length.toLocaleString()} / {FEEDBACK_MESSAGE_MAX.toLocaleString()}
                </div>
              </div>

              <div className="space-y-2">
                <WhatIsSentToggle open={showFields} onToggle={() => setShowFields((open) => !open)} />
                {showFields && (
                  <div className="rounded-md bg-surface-2/60 px-3 py-2.5" data-testid="feedback-dialog-fields">
                    {!fields ? <Loader2 size={14} className="animate-spin text-fg-3" /> : (
                      <SentFields fields={fields} fromAgent={fromAgent} destination={destination} />
                    )}
                  </div>
                )}
              </div>

              {step.kind === 'check' && (
                <FeedbackCheck onDone={() => void send(step.draft)} />
              )}

              {step.kind === 'failed' && (
                <div className="flex items-start gap-2 text-xs text-rose-300" data-testid="feedback-not-sent">
                  <AlertTriangle size={14} className="shrink-0 mt-px" />
                  <span>Not sent. {step.error.message} The draft is kept here.</span>
                </div>
              )}
            </>
          )}

          {error && <p className="text-xs text-rose-300">{error}</p>}
        </div>

        <div className="px-4 py-3 border-t border-line flex items-center justify-between gap-3">
          <div>
            {existing && step.kind !== 'sent' && !locked && (
              <button onClick={() => void deleteDraft()} disabled={working} className={`${QUIET_BTN} hover:text-rose-300`}>
                Delete draft
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step.kind === 'sent' ? (
              <button onClick={close} className={PRIMARY_BTN}>Done</button>
            ) : !status ? null : !enabled ? (
              <>
                <button onClick={close} className={QUIET_BTN}>Not now</button>
                <button onClick={() => void turnOn()} disabled={Boolean(status.collectorProblem)} className={PRIMARY_BTN} data-testid="feedback-turn-on">
                  <span>Turn on feedback</span>
                </button>
              </>
            ) : step.kind === 'check' ? (
              <button onClick={() => setStep({ kind: 'edit' })} className={QUIET_BTN}>Cancel</button>
            ) : step.kind === 'sending' ? (
              <span className="flex items-center gap-2 text-[13px] text-fg-3">
                <Loader2 size={14} className="animate-spin" />
                Sending
              </span>
            ) : (
              <>
                <button onClick={close} className={QUIET_BTN}>{existing ? 'Close' : 'Cancel'}</button>
                <button onClick={() => void startSend()} disabled={!canSend || stranded} className={PRIMARY_BTN} data-testid="feedback-send">
                  {working && <Loader2 size={14} className="animate-spin" />}
                  <span>{step.kind === 'failed' ? 'Try again' : 'Send'}</span>
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
