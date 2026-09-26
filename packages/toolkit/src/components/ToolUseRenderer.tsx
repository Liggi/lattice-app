import React from 'react';
import type { ChatMessage, ToolResult, CustomToolRenderer, BackgroundTaskOutput, BackgroundTaskState } from '../types.js';
import { ToolContent } from './ToolContent.js';
import { ErrorBoundary } from './shared/ErrorBoundary.js';

interface ToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolUseRendererProps {
  toolUse: ToolUse;
  toolResult?: ToolResult;
  toolResults?: Record<string, ToolResult>;
  workingDirectory?: string;
  childrenMessages?: Record<string, ChatMessage[]>;
  questionId?: string;
  onAnswerQuestion?: (questionId: string, answers: Record<string, string>) => void;
  isStreaming?: boolean;
  renderChildMessage?: (message: ChatMessage) => React.ReactNode;
  /** Extension point: consumer-defined renderers checked before defaults. */
  customRenderers?: Record<string, CustomToolRenderer>;
  /** Callbacks for PlanTool approval. */
  onPlanApprove?: () => void | Promise<void>;
  onPlanReject?: () => void | Promise<void>;
  /** Historical plan outcomes keyed by tool_use_id. */
  planOutcomes?: Record<string, 'approved' | 'rejected'>;
  /** Optional fetcher for BashTool background output. */
  fetchBackgroundOutput?: (path: string) => Promise<BackgroundTaskOutput | null>;
  /** Background command states keyed by the tool_use_id that started each one. */
  backgroundTaskStates?: Record<string, BackgroundTaskState>;
}

const EMPTY_TOOL_RESULTS: Record<string, ToolResult> = {};
const EMPTY_CHILDREN: Record<string, ChatMessage[]> = {};

export function ToolUseRenderer({
  toolUse,
  toolResult,
  toolResults = EMPTY_TOOL_RESULTS,
  workingDirectory,
  childrenMessages = EMPTY_CHILDREN,
  questionId,
  onAnswerQuestion,
  isStreaming,
  renderChildMessage,
  customRenderers,
  onPlanApprove,
  onPlanReject,
  planOutcomes,
  fetchBackgroundOutput,
  backgroundTaskStates,
}: ToolUseRendererProps): React.JSX.Element | null {
  // select: ToolSearch queries are internal schema pre-loading — hide entirely
  if (toolUse.name === 'ToolSearch' && typeof toolUse.input.query === 'string' && toolUse.input.query.startsWith('select:')) {
    return null;
  }

  return (
    <ErrorBoundary name={`Tool:${toolUse.name}`}>
      <div data-testid={`tool-${toolUse.name}`}>
        <ToolContent
          toolName={toolUse.name}
          toolInput={toolUse.input}
          toolResult={toolResult}
          workingDirectory={workingDirectory}
          toolUseId={toolUse.id}
          childrenMessages={childrenMessages}
          toolResults={toolResults}
          questionId={questionId}
          onAnswerQuestion={onAnswerQuestion}
          isStreaming={isStreaming}
          renderChildMessage={renderChildMessage}
          customRenderers={customRenderers}
          onPlanApprove={onPlanApprove}
          onPlanReject={onPlanReject}
          planOutcomes={planOutcomes}
          fetchBackgroundOutput={fetchBackgroundOutput}
          backgroundTaskStates={backgroundTaskStates}
        />
      </div>
    </ErrorBoundary>
  );
}
