import { useState } from 'react';
import { ArrowUp, X } from 'lucide-react';
import { SessionStateIcon } from '@/web/chat/components/shared/session-state-icon/SessionStateIcon';

/**
 * An open question the chat has scrolled away from, held above the composer
 * (2026-09-29, Jason: "questions disappear up the thread"). Shown only while
 * its card is out of sight; a tap brings the card back into view, where it is
 * answered, so the card stays the one place to answer or change an answer.
 * The × dismisses the question without answering, as the card's own does.
 */
export function OpenQuestionStrip({ question, onJump, onDismiss }: {
  question: string;
  onJump: () => void;
  onDismiss: () => Promise<void>;
}): JSX.Element {
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismiss = async () => {
    setDismissing(true);
    setError(null);
    try {
      await onDismiss();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDismissing(false);
    }
  };
  return (
    <div className="w-full max-w-3xl px-4 mb-2">
      <div data-testid="open-question-strip" className="flex w-full items-center rounded-lg border border-line bg-surface transition-colors hover:bg-surface-2">
        <button
          type="button"
          data-testid="open-question-jump"
          onClick={onJump}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2.5 text-left"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center">
            <SessionStateIcon state={{ kind: 'needs-you' }} variant="session" />
          </span>
          <span className="min-w-0 flex-1 text-[13px] font-medium leading-[1.45] text-fg break-words">{question}</span>
          <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-accent">
            <ArrowUp size={13} strokeWidth={2} aria-hidden />
            Answer
          </span>
        </button>
        <button
          type="button"
          data-testid="open-question-dismiss"
          onClick={() => void dismiss()}
          disabled={dismissing}
          aria-label="Dismiss the question"
          title="Dismiss the question"
          className="flex h-11 w-11 shrink-0 items-center justify-center text-fg-3 transition-colors hover:text-fg disabled:opacity-50"
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
      {error && <p className="mt-1 px-1 text-[12px] text-rose-400">Could not dismiss: {error}</p>}
    </div>
  );
}
