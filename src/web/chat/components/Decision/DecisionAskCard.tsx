import { createContext, useContext, type ReactNode } from 'react';
import { DecisionCard } from '@liggi/agent-ui-toolkit';
import type { DecisionAskedData, ThreadDecisions } from '@/types/decisions';

const DecisionsContext = createContext<{ sessionId?: string; decisions: ThreadDecisions } | null>(null);

export function DecisionsProvider({ sessionId, decisions, children }: { sessionId?: string; decisions: ThreadDecisions; children: ReactNode }): JSX.Element {
  return <DecisionsContext.Provider value={{ sessionId, decisions }}>{children}</DecisionsContext.Provider>;
}

const NONE: ReadonlySet<string> = new Set();

/** Inbox ids of answers the user took back before the agent read them; their messages are not shown. */
export function useWithdrawnAnswers(): ReadonlySet<string> {
  return useContext(DecisionsContext)?.decisions.withdrawnAnswers ?? NONE;
}

async function postAnswer(sessionId: string, decisionId: string, answer: string): Promise<void> {
  const response = await fetch(`/api/harness/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  });
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: string } | null;
  throw new Error(body?.error ?? `HTTP ${response.status}`);
}

/**
 * An agent's question to the user (`lattice ask`). Once answered the card
 * keeps only the question: the answer is the user's own message below it.
 */
export function DecisionAskCard({ decision }: { decision: DecisionAskedData }): JSX.Element {
  const context = useContext(DecisionsContext);
  const state = context?.decisions.byId.get(decision.id);
  const questions = [{
    question: decision.question,
    options: decision.options.map((option) => ({ label: option.label, description: option.consequence, recommended: option.recommended })),
  }];
  const sessionId = context?.sessionId;
  const onAnswer = sessionId
    ? (answers: Record<string, string>) => postAnswer(sessionId, decision.id, answers[decision.question] ?? '')
    : undefined;

  return (
    <DecisionCard
      questions={questions}
      answered={state?.answer != null ? {} : undefined}
      closed={state?.replaced ? 'Replaced by a later question' : undefined}
      canChange={state?.latest}
      onAnswer={onAnswer}
    />
  );
}
