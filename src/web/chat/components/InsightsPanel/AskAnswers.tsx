/**
 * An ask, answered in its popover or sheet. With numbered questions
 * (`types/ask-text.ts`) each recommendation is the answer until Change opens
 * a box for words, and "Use the recommendation" puts it back; a question
 * with none asks for words. Send goes once, every answer numbered, a line
 * each. Any other ask shows as written, with one box.
 */

import React, { useState } from 'react';
import { Check, Pencil, Undo2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkSlackBullets } from '../../utils/slack-bullets';
import { markdownComponents } from '../MessageList/MessageItem';
import { askAnswers, type ParsedAsk } from '@/types/ask-text';

const BOX = 'w-full resize-y rounded-md border border-white/[0.08] bg-bg/70 px-3 py-2 text-[13.5px] leading-[1.5] text-fg placeholder:text-fg-3 focus:border-cyan-400/50 focus:outline-none';

/** The one action row: the ways out (Park, Dismiss) quiet on the left, Send on the right. */
function SendRow({ footer, sending, disabled = false, label, onSend }: {
  footer?: React.ReactNode;
  sending: boolean;
  disabled?: boolean;
  label: string;
  onSend: () => void;
}) {
  return (
    <div className="mt-5 flex items-center gap-1">
      {footer}
      <span className="flex-1" />
      <button
        type="button"
        data-testid="ask-send"
        disabled={sending || disabled}
        onClick={onSend}
        className="rounded-md bg-cyan-400 px-3.5 py-1.5 text-[13px] font-medium text-stone-950 hover:bg-cyan-300 disabled:bg-white/[0.06] disabled:text-fg-3"
      >
        {sending ? 'Sending' : label}
      </button>
    </div>
  );
}

/** An ask with no numbered questions: as written, and one box. */
export function AskWords({ text, sending, onSend, footer }: {
  text: string;
  sending: boolean;
  onSend: (text: string) => void;
  footer?: React.ReactNode;
}): JSX.Element {
  const [words, setWords] = useState('');
  const send = () => { if (words.trim()) onSend(words.trim()); };
  return (
    <div className="flex flex-col">
      <div data-testid="call-ask" className="prose prose-sm max-w-none text-[13.5px] leading-[1.55] text-fg-2 dark:prose-invert break-words">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkSlackBullets]} components={markdownComponents}>{text}</ReactMarkdown>
      </div>
      <textarea
        rows={3}
        value={words}
        disabled={sending}
        onChange={(event) => setWords(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(); }}
        placeholder="Your answer"
        aria-label="Your answer"
        className={`${BOX} mt-4`}
      />
      <SendRow footer={footer} sending={sending} disabled={!words.trim()} label="Send" onSend={send} />
    </div>
  );
}

export function AskAnswers({ ask, sending, onSend, footer }: {
  ask: ParsedAsk;
  sending: boolean;
  onSend: (text: string) => void;
  /** The ways out (Park, Dismiss), on Send's line. */
  footer?: React.ReactNode;
}): JSX.Element {
  // null keeps the recommendation; a string is the user's own answer.
  const [answers, setAnswers] = useState<(string | null)[]>(() => ask.questions.map((q) => (q.recommendation ? null : '')));
  const set = (i: number, value: string | null) => setAnswers((prev) => prev.map((v, j) => (j === i ? value : v)));

  return (
    <div data-testid="call-ask" className="flex flex-col">
      {ask.context && <p className="mb-4 text-[13.5px] leading-[1.55] text-fg-2 break-words">{ask.context}</p>}
      <ol className="flex flex-col gap-4">
        {ask.questions.map((q, i) => {
          const own = answers[i];
          return (
            <li key={i} data-testid="ask-question" className="flex gap-2.5">
              <span className="w-4 shrink-0 text-right text-[12.5px] leading-[1.5] tabular-nums text-fg-3">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-[1.5] text-fg-2 break-words">{q.text}</span>
                {own === null ? (
                  <span className="mt-1.5 flex items-start gap-2 rounded-md bg-cyan-400/[0.07] px-2.5 py-1.5">
                    <Check size={14} className="mt-[3px] shrink-0 text-cyan-400" aria-hidden />
                    <span className="min-w-0 flex-1 text-[13.5px] font-medium leading-[1.5] text-fg break-words">{q.recommendation}</span>
                    <button type="button" disabled={sending} onClick={() => set(i, '')} className="-my-0.5 -mr-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-fg-3 hover:text-fg-2">
                      <Pencil size={11} aria-hidden /> Change
                    </button>
                  </span>
                ) : (
                  <span className="mt-1.5 block">
                    <textarea
                      rows={1}
                      value={own}
                      disabled={sending}
                      autoFocus={q.recommendation !== null}
                      onChange={(event) => set(i, event.target.value)}
                      placeholder="Your answer"
                      aria-label={`Answer ${i + 1}`}
                      className={BOX}
                    />
                    {q.recommendation && (
                      <button type="button" disabled={sending} onClick={() => set(i, null)} className="-ml-1.5 mt-0.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-fg-3 hover:text-fg-2">
                        <Undo2 size={12} aria-hidden /> Use the recommendation
                      </button>
                    )}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <SendRow footer={footer} sending={sending} label="Send answers" onSend={() => onSend(askAnswers(ask.questions, answers))} />
    </div>
  );
}
