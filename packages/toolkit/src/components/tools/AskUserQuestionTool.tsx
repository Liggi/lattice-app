import React from 'react';
import type { QuestionDefinition } from '../../types.js';
import { DecisionCard, parseAnsweredResult } from '../DecisionCard.js';

interface AskUserQuestionToolProps {
  input: { questions?: QuestionDefinition[] };
  result: string;
  /** Set while the question is waiting for the user; without it the card cannot be answered here. */
  questionId?: string;
  onAnswer?: (questionId: string, answers: Record<string, string>) => void | Promise<void>;
  onDismiss?: (questionId: string) => void | Promise<void>;
}

/**
 * The provider's own question tool (Claude's AskUserQuestion, Codex's
 * request_user_input) as a decision card. Its answer goes back as the tool's
 * result rather than as a message, so the answered card shows it.
 */
export function AskUserQuestionTool({ input, result, questionId, onAnswer, onDismiss }: AskUserQuestionToolProps): React.JSX.Element {
  const questions = input.questions ?? [];
  if (result) return <DecisionCard questions={questions} answered={{ answers: parseAnsweredResult(result) }} />;
  return (
    <DecisionCard
      questions={questions}
      onAnswer={questionId && onAnswer ? (answers) => onAnswer(questionId, answers) : undefined}
      onDismiss={questionId && onDismiss ? () => onDismiss(questionId) : undefined}
    />
  );
}
