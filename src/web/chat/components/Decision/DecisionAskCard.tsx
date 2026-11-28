import { type JSX, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { DecisionCard } from '@liggi/agent-ui-toolkit';
import { isOpenDecision, type DecisionAskedData, type DecisionState, type ThreadDecisions } from '@/types/decisions';
import { usePlugins } from '../../plugins/PluginsContext';
import { ErrorBoundary } from '../ErrorBoundary';

/** Told whether an open card is in sight in the chat, so its question can be kept in reach when it is not. */
type OnCardInSight = (decisionId: string, inSight: boolean) => void;

const DecisionsContext = createContext<{ sessionId?: string; decisions: ThreadDecisions; onCardInSight?: OnCardInSight } | null>(null);

export function DecisionsProvider({ sessionId, decisions, onCardInSight, children }: {
  sessionId?: string;
  decisions: ThreadDecisions;
  onCardInSight?: OnCardInSight;
  children: ReactNode;
}): JSX.Element {
  return <DecisionsContext.Provider value={{ sessionId, decisions, onCardInSight }}>{children}</DecisionsContext.Provider>;
}

/** Fractions of the card at which sight is re-checked: fine enough to catch a third of a tall card. */
const SIGHT_THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

/**
 * Whether an open card is in sight in the chat's scroller: at least a third
 * of it, or of the first 240px of a card taller than that. The scroller ends
 * at the composer dock, so a card behind the dock is out of sight. A card
 * that unmounts (scrolled past the rendered history) is out of sight too.
 */
function useCardSight(decisionId: string, open: boolean, onCardInSight: OnCardInSight | undefined) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!open || !onCardInSight || !node) return;
    const root = node.closest('[data-testid="message-list"]');
    const observer = new IntersectionObserver(([entry]) => {
      const needed = Math.min(entry.boundingClientRect.height, 240) / 3;
      onCardInSight(decisionId, entry.isIntersecting && entry.intersectionRect.height >= needed);
    }, { root, threshold: SIGHT_THRESHOLDS });
    observer.observe(node);
    return () => {
      observer.disconnect();
      onCardInSight(decisionId, false);
    };
  }, [decisionId, open, onCardInSight]);
  return ref;
}

const NONE: ReadonlySet<string> = new Set();

/** Inbox ids of answers the user took back before the agent read them; their messages are not shown. */
export function useWithdrawnAnswers(): ReadonlySet<string> {
  return useContext(DecisionsContext)?.decisions.withdrawnAnswers ?? NONE;
}

async function postAnswer(sessionId: string, decisionId: string, answer: string, edit?: string): Promise<void> {
  const response = await fetch(`/api/harness/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(edit === undefined ? { answer } : { answer, edit }),
  });
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: string } | null;
  throw new Error(body?.error ?? `HTTP ${response.status}`);
}

/** Takes back an answer or dismissal from the panel before it goes (`held-replies.ts`). */
async function undoHeld(sessionId: string, replyId: string): Promise<void> {
  const response = await fetch(`/api/conv/${encodeURIComponent(sessionId)}/project/replies/${encodeURIComponent(replyId)}/undo`, { method: 'POST' });
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: string } | null;
  console.error('Undoing the answer failed:', body?.error ?? `HTTP ${response.status}`);
}

/** The user declines to answer: the card closes as dismissed and the agent is told. */
export async function dismissQuestion(sessionId: string, decisionId: string): Promise<void> {
  const response = await fetch(`/api/harness/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/dismiss`, { method: 'POST' });
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: string } | null;
  throw new Error(body?.error ?? `HTTP ${response.status}`);
}

/** Why a card no longer takes an answer, in the line that replaces its options. */
function closedLabel(state: DecisionState | undefined): string | undefined {
  if (state?.replaced) return 'Replaced by a later question';
  if (state?.dismissed) return 'Dismissed';
  if (state?.withdrawn) return state.withdrawn.reason ? `Withdrawn: ${state.withdrawn.reason}` : 'Withdrawn';
  return undefined;
}

/**
 * An agent's question to the user (`lattice ask`). Once answered the card
 * keeps only the question: the answer is the user's own message below it,
 * whether they tapped an option or wrote to the thread instead. Only a tapped
 * answer can be changed from the card. An open card can be dismissed
 * without answering, as it can from the strip above the composer and the
 * panel's Needs you row.
 */
export function DecisionAskCard({ decision }: { decision: DecisionAskedData }): JSX.Element {
  const context = useContext(DecisionsContext);
  const state = context?.decisions.byId.get(decision.id);
  const questions = [{
    question: decision.question,
    detail: decision.detail,
    options: decision.options.map((option) => ({ label: option.label, description: option.consequence, recommended: option.recommended })),
  }];
  const sessionId = context?.sessionId;
  const open = Boolean(state && isOpenDecision(state));

  // A plugin's own view of the card, with the text the user edited in it and anything stopping its action.
  const View = usePlugins().cardViews.get(decision.action && decision.view ? `${decision.action.plugin}:${decision.view}` : '');
  const edit = useRef<string | undefined>(undefined);
  const [blockedWhy, setBlockedWhy] = useState<string | null>(null);
  const setEdit = useCallback((value: string | undefined) => { edit.current = value; }, []);
  const blockRuns = useCallback((reason: string | null) => setBlockedWhy(reason), []);
  const runs = decision.action?.runs;

  const onAnswer = sessionId
    ? (answers: Record<string, string>) => {
      const answer = answers[decision.question] ?? '';
      return postAnswer(sessionId, decision.id, answer, View && answer === runs ? edit.current : undefined);
    }
    : undefined;

  const sightRef = useCardSight(decision.id, open, context?.onCardInSight);
  const onDismiss = sessionId && open
    ? () => dismissQuestion(sessionId, decision.id).catch((err: unknown) => console.error('Dismissing the question failed:', err))
    : undefined;

  return (
    <div ref={sightRef}>
      <DecisionCard
        questions={questions}
        answered={state?.answer != null || state?.settled ? {} : undefined}
        closed={closedLabel(state)}
        canChange={state?.latest && state.answer != null && !state.actionRan}
        onAnswer={onAnswer}
        onDismiss={onDismiss}
        held={state?.held && sessionId ? { answer: state.held.answer, onUndo: () => undoHeld(sessionId, state.held!.id) } : undefined}
        blocked={View && open && runs && blockedWhy ? { [runs]: blockedWhy } : undefined}
        body={View && decision.action ? (
          <ErrorBoundary name={`plugin card ${decision.action.plugin}:${decision.view}`}>
            <div data-lattice-plugin={decision.action.plugin}>
              <View
                cardId={decision.id}
                conversationId={sessionId ?? ''}
                payload={decision.action.payload}
                open={open}
                answer={state?.answer ?? null}
                actionRan={state?.actionRan ?? false}
                setEdit={setEdit}
                blockRuns={blockRuns}
              />
            </div>
          </ErrorBoundary>
        ) : undefined}
      />
    </div>
  );
}
