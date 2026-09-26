/**
 * One question-and-answer about a highlighted span, rendered as marginalia.
 *
 * The shape is thekg.io's stacked pair — question pane, then answer pane —
 * rendered in the app's own vocabulary: a neutral card with a hairline, a small
 * sentence-case label above the body, and a surface step on hover. The two
 * panes are told apart by their labels, not by a hue.
 *
 * Every state the flow can be in keeps its own pane rather than a separate
 * treatment: a streaming answer is the answer pane with shimmer blocks in it, a
 * failure is the same pane tinted rose, and an exchange nobody has answered yet
 * is the same pane with just its label.
 *
 * Marked `data-annotation-ui` so the card is invisible to two things at once:
 * the quote index that resolves spans in the article (its text must not become
 * matchable article text), and the selection layer (selecting inside a card is
 * not an ask about the article).
 */

import { NoteMarkdown } from './ArticleMarkdown';
import { ASK_STATUS_LABEL, type AskStatus } from './ask-state';

const PANE = 'p-4 rounded-lg border border-line transition-colors duration-150';

/** A failed answer is the only pane that takes a state colour. */
const ERROR_PANE = 'bg-[rgb(var(--color-rose-rgb)/0.1)]';

export interface ExchangeCardProps {
  question: string;
  /** Persisted answer, or null when the exchange has never been answered. */
  answerMd: string | null;
  /** Live state when this exchange is the one currently being asked. */
  live?: { status: AskStatus; answer: string; error: string | null } | null;
  /**
   * The quoted span. Shown only in the fallback list, where the card has no
   * anchor in the text and the quote is the only thing locating it.
   */
  quote?: string;
}

/**
 * Shimmer blocks while an answer is on its way. thekg.io uses shadcn's
 * `Skeleton` (`animate-pulse rounded-md`) at `h-4`; this repo has no such
 * primitive, so the same three bars are written out.
 */
function AnswerSkeleton(): JSX.Element {
  return (
    <div className="space-y-2" aria-hidden="true">
      <div className="h-4 w-full animate-pulse rounded-md bg-surface-2" />
      <div className="h-4 w-4/5 animate-pulse rounded-md bg-surface-2" />
      <div className="h-4 w-3/4 animate-pulse rounded-md bg-surface-2" />
    </div>
  );
}

export function ExchangeCard({ question, answerMd, live, quote }: ExchangeCardProps): JSX.Element {
  const failed = live?.status === 'error';
  const answer = (live && live.answer !== '' ? live.answer : answerMd) ?? '';
  const hasAnswer = answer !== '';
  const pending = Boolean(live) && !failed && !hasAnswer;
  const unanswered = !live && (answerMd === null || answerMd === '');

  // Sentence-case label. While an ask is live the word is its status, so the
  // pane says what it is doing without leaving the idiom.
  let answerLabel = 'Answer';
  let answerLabelClass = 'text-fg-2';
  if (failed) {
    answerLabel = ASK_STATUS_LABEL.error;
    answerLabelClass = 'text-rose-300';
  } else if (live) {
    answerLabel = ASK_STATUS_LABEL[live.status];
    answerLabelClass = 'text-accent';
  } else if (unanswered) {
    answerLabel = 'Unanswered';
    answerLabelClass = 'text-fg-3';
  }

  return (
    <div data-annotation-ui="true" data-testid="km-exchange-card" className="my-4 space-y-2">
      <div className={`${PANE} bg-surface hover:bg-surface-2`}>
        <div className="text-xs font-medium mb-2 text-fg-2">Question</div>
        {quote !== undefined && (
          <div className="mb-3 pb-3 border-b border-line text-xs italic text-fg-3 break-words">
            {quote}
          </div>
        )}
        <div className="text-fg text-sm font-medium break-words">{question}</div>
      </div>

      <div className={`${PANE} ${failed ? ERROR_PANE : 'bg-surface hover:bg-surface-2'}`}>
        <div className={`text-xs font-medium mb-2 ${answerLabelClass}`}>{answerLabel}</div>

        {pending && <AnswerSkeleton />}

        {hasAnswer && (
          <div className="[&>div>p]:mb-0 [&>div>p:not(:last-child)]:mb-2">
            <NoteMarkdown content={answer} />
          </div>
        )}

        {failed && live?.error && (
          <div
            className={`text-sm text-rose-300 break-words${
              hasAnswer ? ' mt-3 pt-3 border-t border-line' : ''
            }`}
          >
            {live.error}
          </div>
        )}
      </div>
    </div>
  );
}
