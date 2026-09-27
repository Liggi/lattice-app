import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { api } from '../../services/api';
import { useFeedbackDrafts, useFeedbackStatus, useInvalidateFeedback } from '../../hooks/useFeedback';
import { FeedbackDialog } from './FeedbackDialog';

/** An on/off switch; the label beside it names what it controls. */
function Switch({ checked, onChange, disabled, label, testId }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  testId?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? 'bg-accent/30 border-accent/60' : 'bg-surface-2 border-line-2'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
          checked ? 'translate-x-[18px] bg-accent' : 'translate-x-[2px] bg-fg-3'
        }`}
      />
    </button>
  );
}

/** Settings → General: turning feedback on, sending it, and drafts waiting to be sent. */
export function FeedbackSettingsSection(): JSX.Element {
  const status = useFeedbackStatus();
  const enabled = status?.enabled === true;
  const drafts = useFeedbackDrafts(enabled);
  const invalidate = useInvalidateFeedback();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ draftId: string | null; conversationId: string | null } | null>(null);

  const save = async (settings: { enabled: boolean }) => {
    setSaving(true);
    setError(null);
    try {
      await api.updateFeedbackSettings(settings);
      await invalidate();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-line pt-4 space-y-3" data-testid="feedback-settings">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-fg-2">Send feedback about Lattice</p>
          <p className="text-xs text-fg-3">
            Send feedback to the Lattice maintainer, and let agents propose it in your chat; nothing is sent until you press Send.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={!status || saving}
          onChange={(next) => void save({ enabled: next })}
          label="Send feedback about Lattice"
          testId="feedback-enabled-switch"
        />
      </div>

      {enabled && (
        <>
          <button
            onClick={() => setDialog({ draftId: null, conversationId: null })}
            className="ui-action-btn flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer"
          >
            <MessageSquare size={14} />
            <span>Send feedback</span>
          </button>

          {drafts.length > 0 && (
            <div className="space-y-2" data-testid="feedback-drafts">
              <p className="text-xs font-medium text-fg-2">Waiting for you to send ({drafts.length})</p>
              {drafts.map((draft) => (
                <div key={draft.id} className="rounded-md border border-line px-3 py-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] uppercase tracking-wider text-fg-3">
                      {draft.source === 'agent' ? 'Proposed by an agent' : 'Your draft'}
                      {draft.scope === 'session' ? ', about a session' : ''}
                    </span>
                    <button
                      onClick={() => setDialog({ draftId: draft.id, conversationId: draft.conversationId })}
                      className="text-[13px] font-medium text-accent hover:text-fg cursor-pointer"
                    >
                      Review
                    </button>
                  </div>
                  <p className="text-xs text-fg-2 whitespace-pre-wrap break-words">{draft.message}</p>
                  {!draft.sendable && <p className="text-xs text-amber-300">Made for a different destination; it can only be deleted.</p>}
                  {draft.lastError && draft.sendable && <p className="text-xs text-rose-300">Not sent. {draft.lastError.message}</p>}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {status?.collectorProblem && <p className="text-xs text-rose-300">{status.collectorProblem}</p>}

      {error && <p className="text-xs text-rose-300">{error}</p>}

      <FeedbackDialog
        isOpen={dialog !== null}
        onClose={() => setDialog(null)}
        conversationId={dialog?.conversationId ?? null}
        draftId={dialog?.draftId ?? null}
        screen="settings"
      />
    </div>
  );
}
