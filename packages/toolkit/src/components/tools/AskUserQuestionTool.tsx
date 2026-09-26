import React, { useState } from 'react';
import { Check, ChevronRight, X, Star, Pencil, MessageCircleQuestion } from 'lucide-react';
import type { QuestionDefinition } from '../../types.js';
import { tk } from '../../tokens.js';

interface AskUserQuestionToolProps {
  input: { questions?: QuestionDefinition[] };
  result: string;
  questionId?: string;
  onAnswer?: (questionId: string, answers: Record<string, string>) => void | Promise<void>;
  onDismiss?: (questionId: string) => void | Promise<void>;
  isPending?: boolean;
  isRecovered?: boolean;
}

function isRecommended(label: string): boolean {
  return /\(Recommended\)\s*$/i.test(label);
}

function cleanLabel(label: string): string {
  return label.replace(/\s*\(Recommended\)\s*$/i, '');
}

export function AskUserQuestionTool({
  input, result, questionId, onAnswer, onDismiss, isRecovered = false,
}: AskUserQuestionToolProps): React.JSX.Element {
  const [selectedOptions, setSelectedOptions] = useState<Record<number, Set<string>>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const [showOther, setShowOther] = useState<Record<number, boolean>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const questions = input.questions || [];

  if (result) {
    return (
      <div className="w-fit max-w-full">
        <div className={`border rounded-lg ${tk.card.border} ${tk.card.bg}`}>
          <div className="flex items-center gap-2 px-3 py-2">
            <Check size={14} className="text-emerald-400/80 flex-shrink-0" />
            <span className={`text-xs ${tk.text.muted}`}>Question answered</span>
          </div>
        </div>
      </div>
    );
  }

  const handleOptionToggle = (qIdx: number, label: string, multi: boolean) => {
    if (label !== '__other__') setShowOther(prev => ({ ...prev, [qIdx]: false }));
    setSelectedOptions(prev => {
      const next = { ...prev };
      if (!next[qIdx]) next[qIdx] = new Set();
      if (multi) {
        if (next[qIdx].has(label)) next[qIdx].delete(label); else next[qIdx].add(label);
      } else {
        next[qIdx] = new Set([label]);
      }
      return next;
    });
  };

  const handleOtherToggle = (qIdx: number) => {
    setShowOther(prev => {
      const n = { ...prev, [qIdx]: !prev[qIdx] };
      if (n[qIdx]) setSelectedOptions(s => ({ ...s, [qIdx]: new Set() }));
      return n;
    });
  };

  const handleSubmit = async () => {
    if (!questionId || !onAnswer) return;
    const answers: Record<string, string> = {};
    questions.forEach((q, idx) => {
      if (showOther[idx] && otherText[idx]?.trim()) {
        answers[q.question] = `Other: ${otherText[idx].trim()}`;
      } else {
        const sel = selectedOptions[idx];
        if (sel && sel.size > 0) answers[q.question] = Array.from(sel).join(', ');
      }
    });
    if (Object.keys(answers).length === 0) return;
    setIsSubmitting(true);
    try { await onAnswer(questionId, answers); } catch (err) { console.error('[AskUserQuestionTool] onAnswer failed:', err); }
    finally { setIsSubmitting(false); }
  };

  const allAnswered = questions.every((_, idx) =>
    (selectedOptions[idx] && selectedOptions[idx].size > 0) || (showOther[idx] && otherText[idx]?.trim())
  );
  const hasAnyRecommended = questions.some(q => q.options.some(o => isRecommended(o.label)));

  return (
    <div className={`w-full rounded-lg overflow-hidden border ${tk.card.border} ${tk.card.bg}`}>
      <div className={`px-3 py-2 border-b ${tk.separator} flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <MessageCircleQuestion size={14} className="text-cyan-600 dark:text-cyan-400" />
          <span className={`text-xs font-medium ${tk.text.secondary}`}>{isRecovered ? 'Waiting for your answer' : 'Input required'}</span>
        </div>
        {onDismiss && questionId && (
          <button onClick={() => onDismiss(questionId)} className={`p-1 rounded ${tk.text.faint} hover:${tk.text.secondary} ${tk.hover} transition-colors`} title="Dismiss">
            <X size={12} />
          </button>
        )}
      </div>

      <div className="p-3 space-y-3">
        {isRecovered && <div className={`text-[13px] ${tk.text.muted}`}>Session paused. Answer to resume.</div>}
        {questions.length === 0 && <div className="text-xs text-amber-400">No questions received. Waiting for question data...</div>}

        {questions.map((question, qIdx) => (
          <div key={qIdx} className="space-y-2">
            {question.header && <span className={`text-xs font-medium ${tk.text.muted}`}>{question.header}</span>}
            <div className={`text-[13px] ${tk.text.heading}`}>{question.question}</div>
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option, oIdx) => {
                const isSelected = selectedOptions[qIdx]?.has(option.label) && !showOther[qIdx];
                const recommended = isRecommended(option.label);
                return (
                  <button
                    key={oIdx}
                    onClick={() => handleOptionToggle(qIdx, option.label, question.multiSelect || false)}
                    disabled={isSubmitting || !questionId}
                    style={{ touchAction: 'manipulation' }}
                    className={`px-3 py-1.5 rounded-md border text-[13px] transition-colors select-none flex items-center gap-1.5 ${
                      isSelected
                        ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300'
                        : `border-parchment-300 dark:border-white/[0.14] ${tk.text.secondary} hover:border-parchment-400 dark:hover:border-white/[0.24] hover:${tk.text.primary}`
                    } ${isSubmitting || !questionId ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {question.multiSelect && isSelected && <Check size={10} />}
                    {cleanLabel(option.label)}
                    {recommended && <Star size={10} className="text-amber-500 fill-amber-500/40 dark:text-amber-400 dark:fill-amber-400/40" />}
                  </button>
                );
              })}
              <button
                onClick={() => handleOtherToggle(qIdx)}
                disabled={isSubmitting || !questionId}
                style={{ touchAction: 'manipulation' }}
                className={`px-3 py-1.5 rounded-md border border-dashed text-[13px] transition-colors select-none flex items-center gap-1.5 ${
                  showOther[qIdx]
                    ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300'
                    : `border-parchment-300 dark:border-white/[0.14] ${tk.text.muted} hover:border-parchment-400 dark:hover:border-white/[0.24]`
                } ${isSubmitting || !questionId ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <Pencil size={10} /> Other...
              </button>
            </div>
            {showOther[qIdx] && (
              <textarea
                value={otherText[qIdx] || ''}
                onChange={(e) => setOtherText(prev => ({ ...prev, [qIdx]: e.target.value }))}
                placeholder="Type your response..."
                disabled={isSubmitting}
                className={`w-full px-3 py-2 rounded-md border text-[13px] placeholder:${tk.text.faint} focus:outline-none focus:border-cyan-500/60 resize-none transition-colors
                  border-parchment-300 dark:border-white/[0.14] bg-white dark:bg-stone-900 ${tk.text.primary}`}
                rows={2}
              />
            )}
          </div>
        ))}

        <div className="flex items-center justify-between gap-3 pt-1">
          {hasAnyRecommended ? (
            <div className={`flex items-center gap-1.5 text-[13px] ${tk.text.faint}`}>
              <Star size={10} className="text-amber-500 fill-amber-500/40 dark:text-amber-400 dark:fill-amber-400/40" /> <span>Recommended</span>
            </div>
          ) : <div />}
          <button
            onClick={handleSubmit}
            disabled={!allAnswered || isSubmitting || !questionId}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] transition-colors ${
              allAnswered && !isSubmitting && questionId
                ? 'font-medium text-cyan-700 dark:text-cyan-400 hover:bg-cyan-500/10 cursor-pointer'
                : `${tk.text.faint} cursor-not-allowed`
            }`}
          >
            {isSubmitting ? <span>{isRecovered ? 'Resuming...' : 'Submitting...'}</span> : <><span>{isRecovered ? 'Submit & Resume' : 'Submit'}</span><ChevronRight size={11} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
