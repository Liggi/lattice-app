import React, { useState } from 'react';
import { Check, CheckCircle2, Pencil, X } from 'lucide-react';
import type { QuestionDefinition, QuestionOption } from '../types.js';
import { tk } from '../tokens.js';

export interface DecisionCardProps {
  questions: QuestionDefinition[];
  /**
   * Set once answered: the card keeps only a tick and the question. Pass
   * `answers` to show them too, where no message of the user's carries them.
   */
  answered?: { answers?: Record<string, string> };
  /** Why an unanswered card can no longer be answered (replaced, dismissed, expired). */
  closed?: string;
  /** Answers keyed by question text: an option's label, or the user's own words. */
  onAnswer?: (answers: Record<string, string>) => void | Promise<void>;
  /** Offered on an answered card while the answer can still be taken back. */
  canChange?: boolean;
  onDismiss?: () => void | Promise<void>;
}

const RECOMMENDED_SUFFIX = /\s*\(Recommended\)\s*$/i;

/** Models put the marker at the end of either the label or the description. */
function isRecommended(option: QuestionOption): boolean {
  return option.recommended === true || RECOMMENDED_SUFFIX.test(option.label) || RECOMMENDED_SUFFIX.test(option.description ?? '');
}

function displayLabel(label: string): string {
  return label.replace(RECOMMENDED_SUFFIX, '');
}

/**
 * The answers in a Claude AskUserQuestion result, which reads
 * `Your questions have been answered: "Q"="A", "Q2"="A2". …`.
 */
export function parseAnsweredResult(result: string): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const match of result.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) answers[match[1]] = match[2];
  return answers;
}

const QUIET_BTN = `px-2.5 py-1.5 rounded-md text-[13px] ${tk.text.muted} hover:text-parchment-900 dark:hover:text-stone-200 ${tk.hover} transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`;
const PRIMARY_BTN = 'px-3 py-1.5 rounded-md bg-cyan-500/10 dark:bg-cyan-400/10 text-cyan-700 dark:text-cyan-400 text-[13px] font-medium hover:bg-cyan-500/20 dark:hover:bg-cyan-400/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * A question the agent needs the user to decide, answered with a tap. Each
 * option is a whole row so its consequence reads in full on a phone. One
 * single-choice question sends on tap; several questions, or a multi-choice
 * one, are chosen first and sent together.
 */
export function DecisionCard({ questions, answered, closed, onAnswer, canChange, onDismiss }: DecisionCardProps): React.JSX.Element {
  const [reopened, setReopened] = useState(false);
  const [chosen, setChosen] = useState<Record<number, string[]>>({});
  const [writing, setWriting] = useState<Record<number, boolean>>({});
  const [words, setWords] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if ((answered && !reopened) || closed) {
    const shown = answered?.answers ?? {};
    return (
      <div data-testid={closed ? 'decision-card-closed' : 'decision-card-answered'} className={`w-full max-w-[68ch] rounded-lg border ${tk.card.border} ${tk.card.bg} px-3.5 py-2.5`}>
        {questions.map((q, i) => (
          <div key={i} className={`flex items-start gap-2 text-sm leading-[1.55] ${i > 0 ? 'mt-1.5' : ''}`}>
            {closed
              ? <X size={14} className={`mt-[3px] shrink-0 ${tk.text.muted}`} />
              : <CheckCircle2 size={14} className="mt-[3px] shrink-0 text-emerald-600 dark:text-emerald-400" />}
            <div className="min-w-0 flex-1">
              <div className={tk.text.muted}>{q.question}</div>
              {shown[q.question] && <div className={`${tk.text.heading} whitespace-pre-wrap break-words`}>{displayLabel(shown[q.question])}</div>}
              {i === questions.length - 1 && closed && <div className={`mt-0.5 text-[12px] ${tk.text.muted}`}>{closed}</div>}
            </div>
            {i === 0 && !closed && canChange && onAnswer && (
              <button type="button" onClick={() => setReopened(true)} className={`${QUIET_BTN} -my-1.5 -mr-2`} data-testid="decision-card-change">
                Change
              </button>
            )}
          </div>
        ))}
      </div>
    );
  }

  const interactive = Boolean(onAnswer) && !sending;
  const oneTap = questions.length === 1 && !questions[0].multiSelect;

  const send = async (answers: Record<string, string>) => {
    if (!onAnswer) return;
    setSending(true);
    setError(null);
    try {
      await onAnswer(answers);
      setReopened(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const answerFor = (i: number): string | undefined => {
    if (writing[i]) return words[i]?.trim() || undefined;
    const picks = chosen[i];
    return picks && picks.length > 0 ? picks.join(', ') : undefined;
  };
  const allAnswered = questions.every((_, i) => answerFor(i) !== undefined);
  const sendChosen = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => { const a = answerFor(i); if (a) answers[q.question] = a; });
    void send(answers);
  };

  const pick = (i: number, q: QuestionDefinition, label: string) => {
    if (oneTap) {
      void send({ [q.question]: label });
      return;
    }
    setWriting((w) => ({ ...w, [i]: false }));
    setChosen((c) => {
      const current = c[i] ?? [];
      if (!q.multiSelect) return { ...c, [i]: [label] };
      return { ...c, [i]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] };
    });
  };

  const needsSend = !oneTap || writing[0];

  return (
    <div data-testid="decision-card" className={`w-full max-w-[68ch] rounded-lg border ${tk.card.border} ${tk.card.bg} px-3.5 pt-3 pb-2`}>
      {questions.map((q, i) => (
        <div key={i} className={i > 0 ? 'mt-4' : ''}>
          <div className="flex items-start gap-2">
            <p className={`min-w-0 flex-1 text-[15px] leading-[1.5] font-medium ${tk.text.heading}`}>{q.question}</p>
            {i === 0 && onDismiss && (
              <button type="button" onClick={() => void onDismiss()} title="Dismiss" aria-label="Dismiss the question" className={`p-1 -mr-1 rounded ${tk.text.muted} ${tk.hover} transition-colors cursor-pointer`}>
                <X size={14} />
              </button>
            )}
          </div>
          <div className="mt-2.5 flex flex-col gap-1.5">
            {q.options.map((option) => {
              const selected = !writing[i] && (chosen[i] ?? []).includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={!interactive}
                  onClick={() => pick(i, q, option.label)}
                  style={{ touchAction: 'manipulation' }}
                  data-testid="decision-card-option"
                  className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                    selected
                      ? 'border-cyan-500/50 bg-cyan-500/10 dark:border-cyan-400/50 dark:bg-cyan-400/10'
                      : 'border-parchment-200 bg-parchment-50 dark:border-white/[0.08] dark:bg-stone-900/50'
                  } ${interactive ? 'cursor-pointer hover:border-cyan-500/50 hover:bg-cyan-500/10 dark:hover:border-cyan-400/50 dark:hover:bg-cyan-400/10' : 'opacity-60 cursor-not-allowed'}`}
                >
                  <span className="flex items-baseline gap-3">
                    {q.multiSelect && (
                      <span className={`relative top-[2px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${selected ? 'border-cyan-500 dark:border-cyan-400' : 'border-parchment-300 dark:border-white/[0.24]'}`}>
                        {selected && <Check size={10} className="text-cyan-700 dark:text-cyan-400" />}
                      </span>
                    )}
                    <span className={`min-w-0 flex-1 text-sm font-medium leading-[1.5] ${tk.text.heading}`}>{displayLabel(option.label)}</span>
                    {isRecommended(option) && <span className={`shrink-0 text-[11px] ${tk.text.muted}`}>Recommended</span>}
                  </span>
                  {option.description && <span className={`mt-0.5 block text-[13px] leading-[1.5] ${tk.text.secondary}`}>{displayLabel(option.description)}</span>}
                </button>
              );
            })}
          </div>
          {writing[i] ? (
            <textarea
              value={words[i] ?? ''}
              onChange={(e) => setWords((w) => ({ ...w, [i]: e.target.value }))}
              rows={3}
              autoFocus
              disabled={sending}
              aria-label="Your answer"
              placeholder="Your answer"
              className={`mt-2 w-full px-3 py-2 rounded-md border text-sm leading-[1.55] resize-y focus:outline-none focus:border-cyan-500/60 border-parchment-300 dark:border-white/[0.14] ${tk.surface} ${tk.text.primary}`}
            />
          ) : (
            <button
              type="button"
              disabled={!interactive}
              onClick={() => { setWriting((w) => ({ ...w, [i]: true })); setChosen((c) => ({ ...c, [i]: [] })); }}
              className={`${QUIET_BTN} mt-1 -ml-2 flex items-center gap-1.5`}
              data-testid="decision-card-own-words"
            >
              <Pencil size={12} />
              <span>Answer in your own words</span>
            </button>
          )}
        </div>
      ))}

      {error && <p className="mt-2 text-[13px] text-rose-600 dark:text-rose-300">Not sent: {error}</p>}

      {(needsSend || reopened) && (
        <div className="mt-2 flex items-center justify-end gap-1">
          {(reopened || (oneTap && writing[0])) && (
            <button
              type="button"
              onClick={() => { if (oneTap && writing[0]) setWriting({}); else setReopened(false); }}
              disabled={sending}
              className={QUIET_BTN}
            >
              {oneTap && writing[0] ? 'Cancel' : 'Keep my answer'}
            </button>
          )}
          {needsSend && (
            <button type="button" onClick={sendChosen} disabled={!interactive || !allAnswered} className={PRIMARY_BTN} data-testid="decision-card-send">
              {sending ? 'Sending' : 'Send'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
