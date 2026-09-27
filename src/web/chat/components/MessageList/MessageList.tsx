/* oxlint-disable react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render */
import React, { useRef, useMemo, useCallback, useState } from 'react';
import { ArrowDown, ChevronRight, GitBranch, Loader2 } from 'lucide-react';
import { MessageItem } from './MessageItem';
import { ErrorBoundary } from '../ErrorBoundary';
import { AskUserQuestionTool } from '@liggi/agent-ui-toolkit';
import { CompactionDivider } from './CompactionDivider';
import { SkillConversationContext } from './SkillHeading';
import { WorkerEventBlock } from '../WorkerEvents/WorkerEventBlock';
import { FeedbackProposalCard } from '../Feedback/FeedbackProposalCard';
import { BLOCK_BUDGET_BASE, BLOCK_BUDGET_STEP } from './message-list-constants';
import { useMessageAnimation } from './use-message-animation';
import { useScrollManagement } from './use-scroll-management';
import { useBlockBudget } from './use-block-budget';
import { useJumpToMessage } from './use-jump-to-message';
import type { ChatMessage, ToolResult, QuestionRequest, PendingQuestion } from '../../types';
import type { RenderItem } from '../../hooks/useHarnessSession';
import type { ActionTraceEntry, HydrationPhase } from '@liggi/agent-ui-harness/client';
import { CollapsedToolGroup, type BackgroundTaskState } from '@liggi/agent-ui-toolkit';
import { useRenderOrderDetector } from '../../hooks/useRenderOrderDetector';

interface BranchLineage {
  parentSessionId: string;
  atTurn: number;
  branchPointMessageId?: string; // Server-computed message ID for the branch point
}

type MessageProvider = NonNullable<ChatMessage['provider']>;

export interface MessageListProps {
  sessionId?: string;
  messages: ChatMessage[];
  /** Grouped render items from the harness. When provided, groups render as
   *  CollapsedToolGroup instead of individual MessageItems. */
  renderItems?: RenderItem[];
  toolResults?: Record<string, ToolResult>;
  childrenMessages?: Record<string, ChatMessage[]>;
  expandedTasks?: Set<string>;
  onToggleTaskExpanded?: (toolUseId: string) => void;
  isLoading?: boolean;
  isStreaming?: boolean;
  streamingProvider?: MessageProvider;
  currentQuestionRequest?: QuestionRequest | null;
  onAnswerQuestion?: (questionId: string, answers: Record<string, string>) => void;
  /** Pending question from DB (for session recovery) */
  pendingQuestion?: PendingQuestion | null;
  onAnswerPendingQuestion?: (questionId: string, answers: Record<string, string>) => void;
  onDismissPendingQuestion?: (questionId: string) => void;
  // Pagination props
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  // Branch lineage (for child sessions - shows where they branched from)
  branchLineage?: BranchLineage;
  onNavigateToSession?: (sessionId: string) => void;
  // True while a provider switch API call is in flight
  isSwitchingProvider?: boolean;
  // Which provider we're switching to (for indicator text)
  switchingToProvider?: MessageProvider;
  // Message ID to scroll to (used by history turn jump)
  jumpToMessageId?: string | null;
  // Called once the jump target has been handled
  onJumpHandled?: () => void;
  inlinePermissionPrompt?: React.ReactNode;
  onPlanApprove?: () => void | Promise<void>;
  onPlanReject?: () => void | Promise<void>;
  /** Per-plan historical outcomes derived from the event stream. */
  planOutcomes?: Record<string, 'approved' | 'rejected'>;
  /** Background command states keyed by tool_use_id, for the Bash cards. */
  backgroundTaskStates?: Record<string, BackgroundTaskState>;
  /** Recent reducer actions — threaded to render order detector for causal tracing. */
  actionTrace?: ActionTraceEntry[];
  /** Harness hydration phase. Controls entry animations and whether the
   *  scroll-up load-more observer is armed. Required so this component
   *  can't forget to honor hydration semantics. */
  hydrationPhase: HydrationPhase;
}

interface MessageGroup {
  type: 'user' | 'assistant' | 'error' | 'system';
  messages: ChatMessage[];
  groupIndex: number;
}

const EMPTY_TOOL_RESULTS: Record<string, ToolResult> = {};
const EMPTY_CHILDREN_MESSAGES: Record<string, ChatMessage[]> = {};

function isCompactionBoundaryMessage(message: ChatMessage): boolean {
  return message.type === 'system' && message.systemSubtype === 'compact_boundary';
}

function isWorkerEventMessage(message: ChatMessage): boolean {
  return message.type === 'system' && message.systemSubtype === 'worker';
}

/**
 * A coordinator's own tool use between two pieces of conversation: one quiet
 * line saying what it did (or is doing), opening to the ordinary rows.
 */
function FoldedMachineryRow({ item, renderBody }: {
  item: Extract<RenderItem, { kind: 'folded' }>;
  renderBody: (ri: RenderItem, isStreamingMessage: boolean) => React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const active = item.temporalState === 'active';
  return (
    <div data-testid="folded-machinery">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 py-1 text-xs text-fg-3 hover:text-fg-2 transition-colors cursor-pointer max-w-full"
      >
        {active
          ? <Loader2 size={12} className="animate-spin flex-shrink-0" />
          : <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />}
        <span className="text-left break-words">
          {item.summary}
          {active && item.latestHint && <span className="text-fg-3/70"> · {item.latestHint}</span>}
        </span>
      </button>
      {open && (
        <div className="mt-1 mb-2 pl-[18px] space-y-2">
          {item.items.map((ri) => {
            const key = ri.kind === 'group' ? ri.group.id : ri.kind === 'folded' ? ri.id : (ri.message.messageId || ri.message.id);
            return <div key={key}>{renderBody(ri, false)}</div>;
          })}
        </div>
      )}
    </div>
  );
}

export const MessageList: React.FC<MessageListProps> = ({
  sessionId,
  messages,
  renderItems: renderItemsProp,
  toolResults = EMPTY_TOOL_RESULTS,
  childrenMessages = EMPTY_CHILDREN_MESSAGES,
  expandedTasks = new Set(),
  onToggleTaskExpanded,
  isLoading,
  isStreaming,
  streamingProvider: _streamingProvider,
  currentQuestionRequest,
  onAnswerQuestion,
  pendingQuestion,
  onAnswerPendingQuestion,
  onDismissPendingQuestion,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  branchLineage,
  onNavigateToSession,
  isSwitchingProvider = false,
  switchingToProvider = 'claude',
  jumpToMessageId = null,
  onJumpHandled,
  inlinePermissionPrompt,
  onPlanApprove,
  onPlanReject,
  planOutcomes = {},
  backgroundTaskStates,
  actionTrace,
  hydrationPhase,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const { hasShownContent, newMessageIds } = useMessageAnimation({
    sessionId,
    messages,
    hydrationPhase,
  });

  // Messages are already normalized by normalizeForDisplay() in the hydration
  // path. tool_result-only user messages have been stripped before reaching
  // this component.
  // See docs/MESSAGE_TESTING_INFRA.md for the normalization design.
  const displayMessages = messages;

  // Branch point message ID comes from the server (handles pagination correctly)
  const branchPointMessageId = branchLineage?.branchPointMessageId ?? null;

  // Build flat item list for rendering.
  // When renderItems is available, use it (includes collapsed groups).
  // Otherwise, fall back to grouping messages by type (legacy path).

  type FlatMessageItem = {
    kind: 'message';
    message: ChatMessage;
    groupIndex: number;
    groupType: 'user' | 'assistant' | 'error' | 'system';
    isFirstInGroup: boolean;
    isLastInGroup: boolean;
    providerSwitch?: { from: MessageProvider; to: MessageProvider };
  };

  type FlatGroupItem = {
    kind: 'group';
    renderItem: Extract<RenderItem, { kind: 'group' }>;
    // Provide a stable message-like shape for the block budget / scroll systems
    message: ChatMessage;
    groupIndex: number;
    groupType: 'assistant';
    isFirstInGroup: boolean;
    isLastInGroup: boolean;
  };

  type FlatFoldedItem = {
    kind: 'folded';
    renderItem: Extract<RenderItem, { kind: 'folded' }>;
    message: ChatMessage;
    groupIndex: number;
    groupType: 'assistant';
    isFirstInGroup: boolean;
    isLastInGroup: boolean;
  };

  type FlatItem = FlatMessageItem | FlatGroupItem | FlatFoldedItem;

  // Group consecutive messages by type (used for message grouping context)
  const messageGroups = useMemo(() => {
    const groups: MessageGroup[] = [];
    displayMessages.forEach((message) => {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup && lastGroup.type === message.type) {
        lastGroup.messages.push(message);
      } else {
        groups.push({ type: message.type, messages: [message], groupIndex: groups.length });
      }
    });
    return groups;
  }, [displayMessages]);

  const flatItems: FlatItem[] = useMemo(() => {
    // When renderItems are available, use them for rendering
    if (renderItemsProp && renderItemsProp.length > 0) {
      const items: FlatItem[] = [];
      let groupIdx = 0;

      for (const ri of renderItemsProp) {
        if (ri.kind === 'message') {
          items.push({
            kind: 'message',
            message: ri.message,
            groupIndex: groupIdx++,
            groupType: ri.message.type as 'user' | 'assistant' | 'error' | 'system',
            isFirstInGroup: true,
            isLastInGroup: true,
          });
        } else if (ri.kind === 'folded') {
          // A coordinator's folded machinery — synthetic ChatMessage as for groups
          const syntheticMessage: ChatMessage = {
            id: ri.id,
            messageId: ri.id,
            type: 'assistant',
            content: ri.summary,
            timestamp: ri.items[0]?.kind === 'message' ? ri.items[0].message.timestamp : new Date(0).toISOString(),
            provider: 'claude',
          };
          items.push({
            kind: 'folded',
            renderItem: ri,
            message: syntheticMessage,
            groupIndex: groupIdx++,
            groupType: 'assistant',
            isFirstInGroup: true,
            isLastInGroup: true,
          });
        } else {
          // Collapsed group — create a synthetic ChatMessage for the systems
          // that expect one (animations, scroll, block budget)
          const syntheticMessage: ChatMessage = {
            id: ri.group.id,
            messageId: ri.group.id,
            type: 'assistant',
            content: ri.group.summary,
            timestamp: ri.group.timestamp,
            provider: 'claude',
          };
          items.push({
            kind: 'group',
            renderItem: ri,
            message: syntheticMessage,
            groupIndex: groupIdx++,
            groupType: 'assistant',
            isFirstInGroup: true,
            isLastInGroup: true,
          });
        }
      }

      return items;
    }

    // Fallback: build from messages (no grouping)
    const items: FlatItem[] = [];
    let lastAssistantProvider: MessageProvider | undefined;

    messageGroups.forEach((group, groupIndex) => {
      group.messages.forEach((message, messageIndex) => {
        const isLastInGroup = messageIndex === group.messages.length - 1;

        const explicitProvider = message.provider === 'claude' || message.provider === 'codex'
          ? message.provider
          : undefined;
        let providerSwitch: { from: MessageProvider; to: MessageProvider } | undefined;
        if (message.type === 'assistant') {
          const currentAssistantProvider = explicitProvider || lastAssistantProvider;
          if (
            currentAssistantProvider
            && lastAssistantProvider
            && currentAssistantProvider !== lastAssistantProvider
          ) {
            providerSwitch = { from: lastAssistantProvider, to: currentAssistantProvider };
          }
          if (currentAssistantProvider) {
            lastAssistantProvider = currentAssistantProvider;
          }
        }

        items.push({
          kind: 'message',
          message,
          groupIndex,
          groupType: group.type,
          isFirstInGroup: messageIndex === 0,
          isLastInGroup,
          providerSwitch,
        });
      });
    });

    return items;
  }, [renderItemsProp, messageGroups]);

  // Reverse the items for column-reverse display
  // (newest at bottom visually, but first in DOM with column-reverse)
  const reversedItems = useMemo(() => [...flatItems].reverse(), [flatItems]);

  // Detect rendering order anomalies (visual DOM order ≠ data order)
  const expectedMessageOrder = useMemo(
    () => flatItems.map(item => item.message.messageId || item.message.id),
    [flatItems],
  );
  useRenderOrderDetector({
    conversationId: sessionId ?? null,
    expectedOrder: expectedMessageOrder,
    containerRef: scrollContainerRef,
    isStreaming,
    actionTrace,
  });

  const { showJumpToLatest, unseenCount, handleJumpToLatest } = useScrollManagement({
    sessionId,
    messages,
    isStreaming,
    scrollContainerRef,
  });

  const {
    visibleCount,
    visibleReversedItems,
    hasInternalMore,
    setBlockBudget,
  } = useBlockBudget({
    sessionId,
    reversedItems,
    hasMore,
    isLoadingMore,
    onLoadMore,
    topSentinelRef,
    scrollContainerRef,
    hydrationPhase,
    initialBudget: BLOCK_BUDGET_BASE,
    budgetStep: BLOCK_BUDGET_STEP,
  });

  useJumpToMessage({
    jumpToMessageId,
    reversedItems,
    visibleCount,
    setBlockBudget,
    scrollContainerRef,
    onJumpHandled,
    blockBudgetStep: BLOCK_BUDGET_STEP,
  });

  // One render item's body, without the thread's column wrapper: used for
  // top-level rows and again for the rows inside a coordinator's fold.
  const renderBody = useCallback((ri: RenderItem, isStreamingMessage: boolean): React.ReactNode => {
    if (ri.kind === 'group') {
      return (
        <ErrorBoundary name="CollapsedGroup">
          <CollapsedToolGroup group={ri.group} temporalState={ri.temporalState} />
        </ErrorBoundary>
      );
    }
    if (ri.kind === 'folded') {
      return (
        <ErrorBoundary name="FoldedMachinery">
          <FoldedMachineryRow item={ri} renderBody={renderBody} />
        </ErrorBoundary>
      );
    }
    return (
      <ErrorBoundary name="Message">
        <MessageItem
          message={ri.message}
          toolResults={toolResults}
          childrenMessages={childrenMessages}
          expandedTasks={expandedTasks}
          onToggleTaskExpanded={onToggleTaskExpanded}
          isFirstInGroup={true}
          isLastInGroup={true}
          isStreaming={isStreamingMessage}
          currentQuestionRequest={currentQuestionRequest}
          onAnswerQuestion={onAnswerQuestion}
          onPlanApprove={onPlanApprove}
          onPlanReject={onPlanReject}
          planOutcomes={planOutcomes}
          backgroundTaskStates={backgroundTaskStates}
          reactable
        />
      </ErrorBoundary>
    );
  }, [toolResults, childrenMessages, expandedTasks, onToggleTaskExpanded, currentQuestionRequest, onAnswerQuestion, onPlanApprove, onPlanReject, planOutcomes, backgroundTaskStates]);

  const renderItem = useCallback((item: FlatItem) => {
    const resolvedMessageId = item.message.messageId || item.message.id;
    const messageKey = resolvedMessageId;

    // Collapsed group or a coordinator's fold
    if (item.kind === 'group' || item.kind === 'folded') {
      return (
        <div key={messageKey} className="w-full flex justify-center" data-message-id={messageKey}>
          <div className={`w-full max-w-3xl px-4 ${item.kind === 'folded' ? 'py-1' : 'py-2'}`}>
            {renderBody(item.renderItem, false)}
          </div>
        </div>
      );
    }

    // Regular message
    const isBranchPoint = branchPointMessageId !== null && branchPointMessageId === resolvedMessageId;
    const staggerIndex = newMessageIds.get(messageKey);
    const isNewMessage = staggerIndex !== undefined;
    const isAssistant = item.groupType === 'assistant';
    const applyMessageAnimation = isNewMessage && !isAssistant;
    const isCompactionMessage = isCompactionBoundaryMessage(item.message);
    const isWorkerMessage = isWorkerEventMessage(item.message);
    const feedbackProposal = item.message.type === 'system' && item.message.systemSubtype === 'feedback' ? item.message.feedbackProposal : undefined;
    const isStreamingMessage = isStreaming && isAssistant;

    return (
      <div
        key={messageKey}
        className={`w-full flex justify-center ${applyMessageAnimation ? 'animate-message-in' : ''}`}
        style={applyMessageAnimation && staggerIndex !== undefined && staggerIndex > 0 ? { animationDelay: `${staggerIndex * 120}ms` } : undefined}
        data-message-id={messageKey}
      >
        <div className="w-full max-w-3xl px-4 py-2">
          {isCompactionMessage ? (
            <CompactionDivider
              trigger={item.message.compactMetadata?.trigger}
              preTokens={item.message.compactMetadata?.preTokens}
              postTokens={item.message.compactMetadata?.postTokens}
              durationMs={item.message.compactMetadata?.durationMs}
              costUsd={item.message.compactMetadata?.costUsd}
            />
          ) : feedbackProposal ? (
            <ErrorBoundary name="FeedbackProposal">
              <FeedbackProposalCard proposal={feedbackProposal} timestamp={item.message.timestamp} onNavigateToSession={onNavigateToSession} />
            </ErrorBoundary>
          ) : isWorkerMessage ? (
            <ErrorBoundary name="WorkerEvent">
              <WorkerEventBlock message={item.message} onNavigateToSession={onNavigateToSession} />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary name="Message">
              <MessageItem
                message={item.message}
                toolResults={toolResults}
                childrenMessages={childrenMessages}
                expandedTasks={expandedTasks}
                onToggleTaskExpanded={onToggleTaskExpanded}
                isFirstInGroup={item.isFirstInGroup}
                isLastInGroup={item.isLastInGroup}
                isStreaming={isStreamingMessage}
                currentQuestionRequest={currentQuestionRequest}
                onAnswerQuestion={onAnswerQuestion}
                onPlanApprove={onPlanApprove}
                onPlanReject={onPlanReject}
                planOutcomes={planOutcomes}
                backgroundTaskStates={backgroundTaskStates}
                reactable
              />
            </ErrorBoundary>
          )}
          {isBranchPoint && branchLineage && onNavigateToSession && (
            <div
              data-testid="branch-point-indicator"
              data-branch-turn={branchLineage.atTurn}
              className="flex items-center gap-2 mt-3 mb-1 py-2 text-[12.5px] text-fg-3 border-t border-b border-line"
            >
              <GitBranch size={13} className="text-fg-3" />
              <span>
                Branched from{' '}
                <button
                  onClick={() => onNavigateToSession(branchLineage.parentSessionId)}
                  className="text-fg-2 hover:text-fg hover:underline cursor-pointer"
                >
                  parent session
                </button>
                {' '}at turn {branchLineage.atTurn}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }, [renderBody, toolResults, childrenMessages, expandedTasks, onToggleTaskExpanded, isStreaming, currentQuestionRequest, onAnswerQuestion, branchPointMessageId, branchLineage, onNavigateToSession, newMessageIds, onPlanApprove, onPlanReject, planOutcomes, backgroundTaskStates]);

  if (displayMessages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex flex-col justify-end relative bg-background scrollbar-auto-hide overflow-hidden">
        <div className="relative z-10 w-full flex justify-center p-8">
          <div className="w-full max-w-3xl px-4">
            {!isStreaming && !inlinePermissionPrompt && (
              <div className="text-center text-muted-foreground animate-message-in">
                <p>No messages yet. Start by typing a message below.</p>
              </div>
            )}
            {inlinePermissionPrompt && (
              <div className="py-1">
                {inlinePermissionPrompt}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <SkillConversationContext.Provider value={sessionId}>
    <div
      className={`flex-1 min-h-0 relative bg-background transition-opacity duration-300 ease-out ${
        hasShownContent ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div
        ref={scrollContainerRef}
        data-testid="message-list"
        className="h-full min-h-0 relative overflow-y-auto overflow-x-hidden bg-background flex flex-col-reverse scrollbar-auto-hide"
      >
        {/* Provider switching indicator - shows immediately when switch is in flight */}
        {isSwitchingProvider && (
          <div className="w-full flex justify-center py-3">
            <div className="flex items-center gap-2 text-xs text-fg-3 animate-pulse">
              <span>Switching to {switchingToProvider}...</span>
            </div>
          </div>
        )}
        {/* Thinking indicator - first child in flex-col-reverse = visual bottom, in flow after all messages.
            Always rendered (when there are messages) so it can animate out smoothly instead of
            being yanked from the DOM. Uses grid row transition for smooth height collapse. */}

        {/* Codex stays active while waiting for an answer; other providers render after streaming stops. */}
        {(!isStreaming || _streamingProvider === 'codex') && pendingQuestion && onAnswerPendingQuestion && (
          <div className="w-full flex justify-center relative z-10">
            <div className="w-full max-w-3xl px-4 py-2">
              <ErrorBoundary name="PendingQuestion">
                <AskUserQuestionTool
                  input={{ questions: pendingQuestion.questions }}
                  result=""
                  questionId={pendingQuestion.id}
                  onAnswer={onAnswerPendingQuestion}
                  onDismiss={onDismissPendingQuestion}
                  isRecovered={true}
                />
              </ErrorBoundary>
            </div>
          </div>
        )}

        {inlinePermissionPrompt && (
          <div className="w-full flex justify-center relative z-10">
            <div className="w-full max-w-3xl px-4 py-2">
              {inlinePermissionPrompt}
            </div>
          </div>
        )}

        {/* Messages - rendered in reverse order, displayed bottom-to-top via column-reverse */}
        {visibleReversedItems.map(item => renderItem(item))}

        {/* Loading indicator for initial load */}
        {isLoading && displayMessages.length === 0 && (
          <div className="flex items-center justify-center p-8 relative z-10">
            <div className="flex gap-1">
              <span className="w-1 h-1 bg-fg-3 rounded-full animate-bounce [animation-delay:-0.32s]" />
              <span className="w-1 h-1 bg-fg-3 rounded-full animate-bounce [animation-delay:-0.16s]" />
              <span className="w-1 h-1 bg-fg-3 rounded-full animate-bounce" />
            </div>
          </div>
        )}

        {/* Loading more indicator - appears at the "top" (last in DOM due to column-reverse) */}
        {isLoadingMore && (
          <div className="flex items-center justify-center p-4 relative z-10">
            <div className="flex gap-1">
              <span className="w-1 h-1 bg-fg-3 rounded-full animate-bounce [animation-delay:-0.32s]" />
              <span className="w-1 h-1 bg-fg-3 rounded-full animate-bounce [animation-delay:-0.16s]" />
              <span className="w-1 h-1 bg-fg-3 rounded-full animate-bounce" />
            </div>
          </div>
        )}

        {/* Sentinel element for infinite scroll - triggers when scrolled to top */}
        {hasInternalMore && !isLoadingMore && (
          <div ref={topSentinelRef} className="h-1 w-full shrink-0" />
        )}
      </div>
      {showJumpToLatest && (
        <div className="pointer-events-none absolute bottom-4 left-0 right-0 z-20 flex justify-center">
          <div className="w-full max-w-3xl px-4 flex justify-end pointer-events-none">
            <button
              data-testid="jump-to-latest"
              onClick={handleJumpToLatest}
              aria-label={unseenCount > 0 ? `Jump to latest, ${unseenCount} new` : 'Jump to latest'}
              className={`pointer-events-auto relative w-8 h-8 flex items-center justify-center rounded-full bg-surface-2 border border-line-2 shadow-md hover:text-fg transition-colors cursor-pointer ${unseenCount > 0 ? 'text-fg' : 'text-fg-2'}`}
            >
              <ArrowDown size={15} />
              {unseenCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 flex items-center justify-center rounded-full bg-surface-2 border border-line-2 text-accent text-[10px] leading-none font-semibold tabular-nums">
                  {unseenCount > 99 ? '99+' : unseenCount}
                </span>
              )}
            </button>
          </div>
        </div>
      )}

    </div>
    </SkillConversationContext.Provider>
  );
};
