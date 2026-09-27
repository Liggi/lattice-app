/* oxlint-disable react-doctor/no-cascading-set-state */
import { useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, MessageSquare, X } from 'lucide-react';
import { api } from '../../services/api';
import { useFeedbackProposal, useInvalidateFeedback } from '../../hooks/useFeedback';
import { CATEGORIES, errorText, FeedbackCheck, needsCheck, PRIMARY_BTN, QUIET_BTN, SentFields, WhatIsSentToggle } from './FeedbackCheck';
import { FEEDBACK_MESSAGE_MAX, type FeedbackCategory, type FeedbackDraftView, type FeedbackProposedData } from '@/types/feedback';

/** The kind, folded into the header sentence rather than set as its own label. */
const KIND_ARTICLE: Record<FeedbackCategory, string> = { bug: 'a bug report', suggestion: 'a suggestion', other: 'feedback' };
const KIND_NOUN: Record<FeedbackCategory, string> = { bug: 'Bug report', suggestion: 'Suggestion', other: 'Feedback' };

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

type Mode = 'view' | 'edit' | 'sending' | 'rejecting' | 'check';

/**
 * An agent's feedback proposal, in the chat the user is reading: the full
 * text and exactly what goes with it, sent, edited or rejected right here.
 */
export function FeedbackProposalCard({ proposal: data, timestamp, onNavigateToSession }: {
  proposal: FeedbackProposedData;
  timestamp: string;
  onNavigateToSession?: (sessionId: string) => void;
}): JSX.Element | null {
  const { proposal, error: loadError } = useFeedbackProposal(data.draftId);
  const invalidate = useInvalidateFeedback();
  const [mode, setMode] = useState<Mode>('view');
  const [category, setCategory] = useState<FeedbackCategory>('other');
  const [message, setMessage] = useState('');
  const [showFields, setShowFields] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkDraft, setCheckDraft] = useState<FeedbackDraftView | null>(null);
  const time = formatTime(timestamp);

  if (!proposal) {
    return loadError ? (
      <p className="px-2.5 py-1.5 text-[13px] text-rose-300">Could not load a feedback proposal: {errorText(loadError)}</p>
    ) : null;
  }

  if (proposal.state === 'gone' || proposal.state === 'rejected') {
    return (
      <div data-testid="feedback-proposal-closed" className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-fg-3">
        <X size={14} className="shrink-0" />
        <span>{proposal.state === 'rejected' ? 'Feedback not sent' : 'A feedback proposal that is no longer here'}</span>
        <span className="flex-1" />
        {time && <span className="text-[11px]">{time}</span>}
      </div>
    );
  }

  const worker = data.workerTitle ? (
    onNavigateToSession ? (
      // A link rather than a button, so a long name wraps with the sentence around it.
      <a
        href={`/c/${data.from}`}
        onClick={(e) => { e.preventDefault(); onNavigateToSession(data.from); }}
        className="font-medium !text-fg-2 !no-underline hover:!text-accent"
      >
        {data.workerTitle}
      </a>
    ) : <span className="font-medium text-fg-2">{data.workerTitle}</span>
  ) : null;

  if (proposal.state === 'sent') {
    return (
      <div data-testid="feedback-proposal-sent" className="rounded-lg border border-line bg-surface px-3.5 py-2.5">
        <Header icon={<CheckCircle2 size={14} className="shrink-0 text-emerald-400" />} time={time}>
          {KIND_NOUN[proposal.category]}{worker && <> from {worker}</>} sent to the Lattice maintainer
        </Header>
        <Passage>{proposal.message}</Passage>
      </div>
    );
  }

  const draft = proposal.draft;
  const editing = mode === 'edit';
  const busy = mode !== 'view' && mode !== 'edit';
  const length = [...message].length;
  const tooLong = length > FEEDBACK_MESSAGE_MAX;

  const startEdit = () => {
    setCategory(draft.category);
    setMessage(draft.message);
    setError(null);
    setMode('edit');
  };

  const send = async (target: FeedbackDraftView) => {
    setMode('sending');
    setError(null);
    try {
      const result = await api.sendFeedbackDraft(target.id, target.revision);
      if (!result.sent) setError(`Not sent. ${result.error?.message ?? ''} It is kept here.`);
    } catch (err) {
      if (needsCheck(err)) {
        setCheckDraft(target);
        setMode('check');
        return;
      }
      setError(errorText(err));
    }
    await invalidate();
    setMode('view');
  };

  /** Sends what is on screen: the edited text when editing, else the draft as shown. */
  const onSend = async () => {
    if (!editing) {
      await send(draft);
      return;
    }
    setMode('sending');
    try {
      await send(await api.updateFeedbackDraft(draft.id, { category, message }));
    } catch (err) {
      setError(errorText(err));
      setMode('edit');
    }
  };

  const reject = async () => {
    setMode('rejecting');
    try {
      await api.deleteFeedbackDraft(draft.id);
      await invalidate();
    } catch (err) {
      setError(errorText(err));
    }
    setMode('view');
  };

  return (
    <div data-testid="feedback-proposal" className="rounded-lg border border-line bg-surface">
      <div className="px-3.5 pt-2.5 pb-2">
        <Header icon={<MessageSquare size={14} className="shrink-0 text-fg-3" />} time={time}>
          {worker ?? 'The agent'} wants to send {editing ? 'feedback' : KIND_ARTICLE[draft.category]} to the Lattice maintainer
        </Header>

        {editing ? (
          <div className="mt-2 space-y-1.5">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={Math.min(12, Math.max(4, message.split('\n').length + 1))}
              autoFocus
              aria-label="Feedback message"
              data-testid="feedback-proposal-editor"
              className="w-full px-3 py-2 bg-bg border border-line-2 rounded-md text-sm leading-[1.55] text-fg focus:outline-none focus:border-accent resize-y"
            />
            <div className="flex items-center justify-between gap-2">
              <div role="radiogroup" aria-label="Kind of feedback" className="inline-flex items-center gap-0.5">
                {CATEGORIES.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={category === value}
                    onClick={() => setCategory(value)}
                    className={`px-2 py-0.5 text-xs rounded transition-colors cursor-pointer ${category === value ? 'bg-surface-2 text-fg' : 'text-fg-3 hover:text-fg'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className={`text-[11px] font-mono ${tooLong ? 'text-rose-300' : 'text-fg-3'}`}>
                {length.toLocaleString()} / {FEEDBACK_MESSAGE_MAX.toLocaleString()}
              </span>
            </div>
          </div>
        ) : (
          <Passage testId="feedback-proposal-message">{draft.message}</Passage>
        )}

        {!draft.sendable && (
          <p className="mt-2 text-xs text-amber-300">This was proposed for a different feedback destination ({draft.collectorOrigin}). It can only be rejected.</p>
        )}
        {mode === 'check' && checkDraft && (
          <div className="mt-2.5">
            <FeedbackCheck onDone={() => void send(checkDraft)} onCancel={() => setMode('view')} />
          </div>
        )}
        {(error ?? (draft.lastError && mode === 'view' ? `Not sent. ${draft.lastError.message} It is kept here.` : null)) && (
          <div className="mt-2 flex items-start gap-2 text-xs text-rose-300" data-testid="feedback-proposal-error">
            <AlertTriangle size={14} className="shrink-0 mt-px" />
            <span>{error ?? `Not sent. ${draft.lastError?.message} It is kept here.`}</span>
          </div>
        )}

        {mode !== 'check' && (
          <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1.5">
            <div className="mr-auto">
              <WhatIsSentToggle open={showFields} onToggle={() => setShowFields((open) => !open)} />
            </div>
            <button onClick={() => void reject()} disabled={busy} className={`${QUIET_BTN} hover:text-rose-300`} data-testid="feedback-proposal-reject">
              Reject
            </button>
            {editing ? (
              <button onClick={() => setMode('view')} className={QUIET_BTN}>Cancel edit</button>
            ) : (
              <button onClick={startEdit} disabled={busy || !draft.sendable} className={QUIET_BTN} data-testid="feedback-proposal-edit">Edit</button>
            )}
            <button
              onClick={() => void onSend()}
              disabled={busy || !draft.sendable || (editing && (tooLong || message.trim().length === 0))}
              className={`${PRIMARY_BTN} ml-1`}
              data-testid="feedback-proposal-send"
            >
              {mode === 'sending' && <Loader2 size={14} className="animate-spin" />}
              <span>{mode === 'sending' ? 'Sending' : 'Send'}</span>
            </button>
          </div>
        )}
      </div>

      {showFields && (
        <div className="rounded-b-lg border-t border-line bg-surface-2/60 px-3.5 py-2.5" data-testid="feedback-proposal-fields">
          <SentFields fields={draft.payload} fromAgent destination={draft.collectorOrigin} />
        </div>
      )}
    </div>
  );
}

/** The card's one quiet line: who, what, and when. */
function Header({ icon, time, children }: { icon: JSX.Element; time: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-2 text-sm leading-[1.55] text-fg-3">
      <span className="mt-[3px]">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {time && <span className="shrink-0 pt-[2px] text-[11px]">{time}</span>}
    </div>
  );
}

/** The feedback itself, in full, set in the darker inset used for quoted passages. */
function Passage({ testId, children }: { testId?: string; children: string }): JSX.Element {
  return (
    <p data-testid={testId} className="mt-2 rounded-md bg-bg px-3 py-2 text-sm leading-[1.55] text-fg whitespace-pre-wrap break-words">
      {children}
    </p>
  );
}
