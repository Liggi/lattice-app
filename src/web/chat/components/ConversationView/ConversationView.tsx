/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { useState, useEffect, useCallback, useRef, useMemo, Profiler } from 'react';
import { DecisionsProvider, dismissQuestion } from '../Decision/DecisionAskCard';
import { ExplainsProvider } from '../Explain/ExplainCard';
import { OpenQuestionStrip } from '../Decision/OpenQuestionStrip';
import { CLAUDE_QUESTION_ID_PREFIX, isOpenDecision } from '@/types/decisions';
import type { QuestionRequest } from '../../types';
import { QueuedMessages } from './QueuedMessages';
import { SenderNamesProvider } from '../shared/sender-names';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageList } from '../MessageList/MessageList';
import { Composer, ComposerRef } from '@/web/chat/components/Composer';
import { ComposerContextControl } from '@/web/chat/components/Composer/ComposerContextControl';
import { ComposerGoalControl } from '@/web/chat/components/Composer/ComposerGoalControl';
import { NextStepsPrompt } from '../NextSteps';
import { ConversationHeader } from '../ConversationHeader/ConversationHeader';
import { InsightsPanel, type SyncState } from '../InsightsPanel';
import { CoordinatorPanel } from '../InsightsPanel/CoordinatorPanel';
import { PermissionBanner, PermissionWaitingLine } from '../PermissionBanner';
import { AnnotationSelectionLayer, AnnotationSpanIcons, AnnotationStatusBadge } from '../MessageAnnotations';
import { useMessageAnnotations } from '../../hooks/useMessageAnnotations';
import { Import } from 'lucide-react';
import { useToast } from '../Toast/Toast';
import { ReactionsProvider, SelectionMessageActions } from '../MessageReactions/MessageReactions';
import { api } from '../../services/api';
import { useHarnessSession } from '../../hooks/useHarnessSession';
import { useWorkers } from '../../hooks/useWorkers';
import { useConversationSendMessage } from './use-conversation-send-message';
import { resolveIsArchived, resolveIsCoordinator, resolveParentConversationId } from '../../utils/session-identity';
import { useDuplicateMessageDetector } from '../../hooks/useDuplicateMessageDetector';
import { usePermissions } from '../../hooks/usePermissions';
import { conversationKeys, useConversations } from '../../contexts/ConversationsContext';
import type {
  UnifiedConversationSummary,
  ToolResult,
  NextStepProposal,
  PendingWork,
} from '../../types';
import { TeamColorProvider, useTeamColorContext } from '../../contexts/TeamColorContext';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { ToolkitProvider } from '@liggi/agent-ui-toolkit';
import { debugFlags } from '../../services/debug-logger';
import { MessageDebugOverlay } from '../MessageDebugOverlay/MessageDebugOverlay';
import {
  dedupeNearDuplicateUserMessages,
} from './message-dedupe';
import {
  evaluateSessionLoadWatchdogRecovery,
  logSessionLoadWatchdogTriggered,
  reconnectClaudeStreamIfNeeded,
  reconnectFromConversationStatus,
  refetchSessionWatchdogQueries,
  type SessionLoadWatchdogReason,
} from './session-load-watchdog';
import {
  maybeApplyProposedNextStepsFromConversationDetails,
  maybeFocusComposerOnInitialConversationLoad,
} from './conversation-load-helpers';
import { useMessagePagination } from './use-message-pagination';
import { useInsightsPanelState } from './use-insights-panel-state';
import { foldCoordinatorMachinery } from '../../utils/coordinator-thread';
import { useDocumentTitle } from './use-document-title';
import { usePendingQuestions } from './use-pending-questions';
import { useDevNoteAutoCheckoff } from './use-dev-note-auto-checkoff';
import { useSessionVisibilityRefresh } from './use-session-visibility-refresh';
import { useConversationNavigationTelemetry } from './use-conversation-navigation-telemetry';
import { restoreComposerDraft, useConversationSendHandlers } from './use-conversation-send-handlers';
import { useConversationStopHandler } from './use-conversation-stop-handler';
import { useSessionStatus, sessionStatusKeys } from '../../hooks/useSessionStatus';
import { useTransientErrorDismiss } from './use-transient-error-dismiss';
import { shouldRefetchOnCompletion } from './session-active-state';
import { setBrowserIncidentContext, clearBrowserIncidentContext } from '../../services/browser-incidents';
import type { Provider } from '@/types/unified-messages';
import { CLAUDE_MODELS } from '@/constants/claude-models';
import { endpointModelOption } from '@/constants/claude-endpoint';
import {
  CODEX_EFFORTS,
  CODEX_MODELS,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL_ID,
  effortsForCodexModel,
} from '@/constants/codex-models';
import { getProviderCapabilities, supportsAttachments } from '@/types/provider-capabilities';
const SESSION_LOAD_MAX_RECOVERY_ATTEMPTS = 2;

/**
 * What the composer calls the thing it is waiting on between turns. The status
 * bar is the one place that says why a live session isn't asking for input, so
 * it names the actual kind rather than calling every one a background task.
 */
const PENDING_WORK_STATUS_LABEL: Record<PendingWork, string> = {
  background_task: 'Waiting for background task',
  subagent: 'Waiting for subagent',
  workflow: 'Waiting for workflow',
  scheduled_wakeup: 'Waiting for scheduled wake-up',
};

/** Map raw fetch/network errors into friendlier messages for the error banner. */
function humanizeLoadError(msg: string): string {
  if (msg.includes('Failed to fetch') || msg.includes('Load failed') || msg.includes('NetworkError')) {
    return 'Connection lost — retrying…';
  }
  if (msg.includes('timeout')) {
    return 'Session load timed out — retrying…';
  }
  return msg;
}

/** Bridges Lattice's TeamColorContext → toolkit's ToolkitProvider. */
function ToolkitBridge({ children }: { children: React.ReactNode }): JSX.Element {
  const { agentColors } = useTeamColorContext();
  const resolveAgentColor = useCallback(
    (name: string) => agentColors[name],
    [agentColors],
  );
  return (
    <ToolkitProvider theme="dark" resolveAgentColor={resolveAgentColor}>
      {children}
    </ToolkitProvider>
  );
}

interface ConversationViewProps {
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
}

export function ConversationView({ sidebarOpen, onToggleSidebar }: ConversationViewProps = {}): JSX.Element {
  const { conversationId: routeConversationId } = useParams<{ conversationId: string }>();
  const conversationId = routeConversationId;
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // Keep browser incident context in sync with current conversation
  useEffect(() => {
    if (conversationId) {
      setBrowserIncidentContext({ conversationId, sessionId: conversationId });
    }
    return () => clearBrowserIncidentContext();
  }, [conversationId]);

  // Message debug overlay: ?debug=messages URL param or __latticeDebug.enable('messages')
  const showMessageDebug = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('debug') === 'messages' || debugFlags.messages === true;
  }, [location.search]);

  // --- Harness session + permissions ---
  const {
    status: harnessStatus,
    connected: harnessConnected,
    hydrationPhase: harnessHydrationPhase,
    processAlive,
    error: harnessError,
    messages: harnessMessages,
    renderItems: harnessRenderItems,
    childrenMessages: harnessChildrenMessages,
    usage: harnessUsage,
    sessionModel: harnessSessionModel,
    sessionModelFallback: harnessSessionModelFallback,
    codexGoal: harnessCodexGoal,
    codexGoalEventSeen,
    compaction: harnessCompaction,
    compactionAfterReply: harnessCompactionAfterReply,
    activeStartTime: harnessActiveStartTime,
    pendingWork,
    backgroundTaskStates,
    pendingMessages: harnessPendingMessages,
    actionTrace: harnessActionTrace,
    send: harnessSend,
    compact: harnessCompact,
    stop: harnessStopFn,
    reconnect: harnessReconnect,
    injectEvent: _harnessInjectEvent,
    fetchHistory: harnessFetchHistory,
    lastWorkerEventSeq,
    lastEventSeq,
    reactions: harnessReactions,
    agentReactions: harnessAgentReactions,
    decisions: harnessDecisions,
    explains: harnessExplains,
    openDecision: harnessOpenDecision,
  } = useHarnessSession(conversationId ?? null);
  // A message from another session arrives on the harness stream, which carries
  // no worker event and need not change our status — so nothing else here would
  // refetch the names. Keying the fetch on the senders actually seen means the
  // first message from a peer we have never heard from resolves on its arrival
  // rather than waiting for the next unrelated event. A sender the server
  // cannot name changes this key once and then stops, so there is no retry loop.
  const seenSenders = useMemo(() => {
    const ids = new Set<string>();
    for (const m of harnessMessages) {
      const sender = m.attribution?.sender;
      if (sender) ids.add(sender);
    }
    for (const p of harnessPendingMessages) {
      const sender = p.attribution?.sender;
      if (sender) ids.add(sender);
    }
    return [...ids].sort().join(',');
  }, [harnessMessages, harnessPendingMessages]);
  const { workers, project, senders } = useWorkers(conversationId ?? null, lastWorkerEventSeq, harnessStatus, seenSenders, lastEventSeq);
  const {
    permissionRequest,
    answerPermission,
    answerPermissionWithPattern,
    answerPermissionWithPatterns,
  } = usePermissions(conversationId);

  // Local UI state
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [proposedNextSteps, setProposedNextSteps] = useState<NextStepProposal[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Mid-session model switch: the user's pending selection from the composer
  // badge. Rides every send as extra.model (the harness respawns with --resume
  // when it differs from the running config) and clears once the session
  // reports it is actually on the selected model.
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const { claudeEndpoints } = usePreferencesContext();
  // Codex reasoning effort works the same way, except that the conversation
  // records what it is running at, so the control shows that and this holds
  // only a choice the user has made and not yet sent.
  const [pendingReasoningEffort, setPendingReasoningEffort] = useState<string | null>(null);

  // Clear the pending selection once the session confirms it. Prefix
  // comparison tolerates alias vs dated-id forms of the same model (same
  // pattern as sessionModelFallback detection in useHarnessSession).
  useEffect(() => {
    if (!pendingModel || !harnessSessionModel) return;
    if (harnessSessionModel.startsWith(pendingModel) || pendingModel.startsWith(harnessSessionModel)) {
      setPendingModel(null);
    }
  }, [pendingModel, harnessSessionModel]);


  // Models offered by the composer badge for mid-session switching. No entry
  // is a creation default: choosing any model here is an explicit switch.
  // A saved endpoint's model is offered alongside: switching to it moves this
  // session onto that server, and switching back returns it to the sign-in.
  const switchableClaudeModels = useMemo(
    () => [
      ...CLAUDE_MODELS.filter((m) => m.composerSelectable).map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        isDefault: false,
      })),
      ...claudeEndpoints.map((endpoint) => endpointModelOption(endpoint)),
    ],
    [claudeEndpoints],
  );

  const switchableCodexModels = useMemo(
    () => CODEX_MODELS.filter((model) => model.composerSelectable).map((model) => ({
      id: model.id,
      label: model.label,
      description: model.description,
      isDefault: false,
    })),
    [],
  );

  const switchableCodexEfforts = useMemo(() => {
    const model = pendingModel ?? harnessSessionModel ?? DEFAULT_CODEX_MODEL_ID;
    return effortsForCodexModel(model).map((effortId) => {
      const effort = CODEX_EFFORTS.find((candidate) => candidate.id === effortId);
      return {
        id: effortId,
        label: effort?.label ?? effortId,
        description: effort?.description,
        isDefault: effortId === DEFAULT_CODEX_EFFORT,
      };
    });
  }, [harnessSessionModel, pendingModel]);

  // Derived state
  const isCompacting = harnessHydrationPhase === 'ready'
    && harnessCompaction?.phase === 'started';
  // Compaction that runs once a reply has finished (the server's automatic
  // one, or the compact control) is not the agent working: the composer
  // shows it as a quiet 'Compacting context' with no timer or Stop, and a
  // message sent meanwhile is held and answered as soon as it ends.
  const isCompactingAfterReply = isCompacting && harnessCompactionAfterReply;
  const isActive = harnessStatus !== 'idle' || isCompacting;
  const isIdle = harnessStatus === 'idle' && !isCompacting;
  const isInitializing = harnessStatus === 'initializing';
  const isStreaming = harnessStatus === 'streaming';
  const sessionError = harnessError ?? localError;
  const clearSessionError = useCallback(() => setLocalError(null), []);

  // Messages come directly from the harness — single pipeline, no merge.
  // Single pipeline: harness events are the sole message source.
  // No merge, no dedup, no timestamp comparison.
  const mergedMessages = harnessMessages;

  // Derive toolResults from messages — scan for tool_result content blocks
  // so MessageList can resolve tool_use spinners.
  const toolResults = useMemo(() => {
    const results: Record<string, ToolResult> = {};
    for (const msg of mergedMessages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          results[b.tool_use_id] = {
            status: 'completed',
            result: typeof b.content === 'string' ? b.content : undefined,
            is_error: typeof b.is_error === 'boolean' ? b.is_error : undefined,
          };
        }
      }
    }
    return results;
  }, [mergedMessages]);

  // Action wrappers
  const sendMessage = useConversationSendMessage({
    conversationId,
    connected: harnessConnected,
    send: harnessSend,
    compact: harnessCompact,
    reconnect: harnessReconnect,
    setLocalError,
  });

  const harnessStop = useCallback(async (): Promise<boolean> => {
    try {
      await harnessStopFn();
      return true;
    } catch {
      return false;
    }
  }, [harnessStopFn]);

  const forceKill = useCallback(async () => { await harnessStopFn(); }, [harnessStopFn]);

  const toggleTaskExpanded = useCallback((toolUseId: string) => {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      if (next.has(toolUseId)) next.delete(toolUseId);
      else next.add(toolUseId);
      return next;
    });
  }, []);

  const clearNextSteps = useCallback(() => setProposedNextSteps(null), []);

  const enqueueMessage = useCallback(async (displayMessage: string) => {
    // Always send directly — sendMessage handles mid-turn injection via harnessSend
    await sendMessage(displayMessage);
  }, [sendMessage]);


  // Narrow objects for sub-hooks
  const sendSession = useMemo(() => ({
    messages: mergedMessages,
    isActive,
    isConnected: harnessConnected,
    proposedNextSteps,
    clearNextSteps,
    addOptimisticUserMessage: (_text: string) => {},
    sendMessage,
    enqueueMessage,
  }), [mergedMessages, isActive, harnessConnected, proposedNextSteps, clearNextSteps, sendMessage, enqueueMessage]);

  const stopSession = useMemo(() => ({
    stop: harnessStop,
    forceKill,
  }), [harnessStop, forceKill]);

  const [conversationTitle] = useState<string>('Conversation');
  const [isPermissionDecisionLoading, setIsPermissionDecisionLoading] = useState(false);
  const [sessionFailureError, setSessionFailureError] = useState<string | null>(null);
  const [isStopRequested, setIsStopRequested] = useState(false);

  // Auto-dismiss transient network errors (e.g., "Load failed" on mobile app-switch)
  const clearSessionFailureError = useCallback(() => setSessionFailureError(null), []);
  useTransientErrorDismiss({
    sessionError: sessionError,
    sessionFailureError,
    clearSessionError: clearSessionError,
    clearSessionFailureError,
  });

  const { insightsPanelOpen, toggleInsightsPanel, closeInsightsPanel } = useInsightsPanelState();

  // Cross-session sidebar state is managed by parent (ConversationViewWrapper)
  // to prevent remount on session change
  const crossSessionSidebarOpen = sidebarOpen ?? false;

  // Cross-session overlay (inline panel over messages)

  // Feedback panel overlay

  // Stable callbacks for Composer (avoids re-creating on every render, which would
  // trigger useEffect re-fires in Composer for directory/command fetching)
  const handleFetchFileSystem = useCallback(async (directory: string) => {
    try {
      const response = await api.listDirectory({
        path: directory || '',
        recursive: false,
        respectGitignore: true,
      });
      return response.entries;
    } catch (error) {
      console.error('Failed to fetch file system entries:', error);
      return [];
    }
  }, []);

  const handleFetchCommands = useCallback(async (workingDirectory?: string) => {
    try {
      const response = await api.getCommands(workingDirectory || '');
      return response.commands;
    } catch (error) {
      console.error('Failed to fetch commands:', error);
      return [];
    }
  }, []);

  const {
    conversations,
    pendingInsightsUpdates,
    invalidateConversations,
    setSessionOptimisticOngoing,
  } = useConversations();
  const conversationSummary = useMemo<UnifiedConversationSummary | null>(() => {
    if (!conversationId) return null;
    return conversations.find((conversation) => conversation.conversationId === conversationId) || null;
  }, [conversations, conversationId]);
  const sessionStatus = useSessionStatus(conversationId);
  const activeProvider: Provider = conversationSummary?.activeProvider
    ?? conversationSummary?.latestProvider
    ?? sessionStatus.provider
    ?? 'claude';
  const activeProviderCapabilities = getProviderCapabilities(activeProvider);


  // The composer reads its draft only when it mounts, so a restored draft is
  // shown by mounting it again.
  const [composerMount, setComposerMount] = useState(0);
  const restoreDraftFromBackup = useCallback(() => {
    if (restoreComposerDraft(conversationId)) setComposerMount((count) => count + 1);
  }, [conversationId]);

  // Refs
  const composerRef = useRef<ComposerRef>(null);
  const hasInitiallyFocusedRef = useRef(false);
  const nextStepsDismissedRef = useRef(false);
  const navStartRef = useRef<{ conversationId?: string; time?: number; traceId?: string }>({});
  const loadRecoveryAttemptsRef = useRef<Record<string, number>>({});
  const loadRecoveryInFlightRef = useRef(false);

  // Clear navigation state to prevent issues on refresh
  useEffect(() => {
    if (location.state) {
      try {
        window.history.replaceState({}, document.title);
      } catch (_error) {
        // Navigation state replacement is best-effort.
      }
    }
  }, [location]);

  // Reset focus tracking when conversationId changes
  useEffect(() => {
    hasInitiallyFocusedRef.current = false;
    nextStepsDismissedRef.current = false;
  }, [conversationId]);

  // Refetch conversation details when a session completes (ongoing → completed).
  // See session-active-state.ts for shouldRefetchOnCompletion logic.
  const prevOngoing = useRef(sessionStatus.isOngoing);
  useEffect(() => {
    const wasOngoing = prevOngoing.current;
    prevOngoing.current = sessionStatus.isOngoing;

    if (shouldRefetchOnCompletion(wasOngoing, sessionStatus.isOngoing) && conversationId) {
      // The status endpoint only reports 'completed' after the backend has
      // finished writing; HTTP fetch latency provides natural debounce.
      // eslint-disable-next-line no-console
      console.debug(`[DETAIL-TRACE] completion-edge invalidating details for ${conversationId?.slice(0, 12)}`);
      void queryClient.invalidateQueries({ queryKey: conversationKeys.details(conversationId) });
    }
  }, [sessionStatus.isOngoing, conversationId, queryClient]);

  // Reset state when navigating to a different session
  const prevSessionIdRef = useRef(conversationId);
  useEffect(() => {
    if (prevSessionIdRef.current === conversationId) return;
    prevSessionIdRef.current = conversationId;
    setIsStopRequested(false);

    if (conversationId) {
      // Force fresh conversation details on session switch. The details query
      // has a 30s staleTime, so cached data from a previous visit may be missing
      // the final response if the session completed in between.
      // eslint-disable-next-line no-console
      console.debug(`[DETAIL-TRACE] session-switch invalidating details for ${conversationId?.slice(0, 12)}`);
      void queryClient.invalidateQueries({ queryKey: conversationKeys.details(conversationId) });

      // Force fresh session status so stale 'ongoing' from a previous visit
      // doesn't keep the Live indicator stuck after the session has completed.
      void queryClient.invalidateQueries({ queryKey: sessionStatusKeys.one(conversationId) });
    }
  }, [conversationId, queryClient]);

  // Conversation detail limit — only used for metadata now (next steps, MCP servers, etc).
  // Messages come from harness events, not the API.
  const INITIAL_MESSAGE_LIMIT = 50;
  const conversationDetailsLimit = 10; // minimal — we only need metadata, not messages

  const {
    data: conversationDetails,
    isLoading: detailsLoading,
    error: detailsError,
    isFetching: detailsFetching,
  } = useQuery({
    queryKey: conversationKeys.details(conversationId || ''),
    queryFn: () => {
      const traceId = navStartRef.current.conversationId === conversationId
        ? navStartRef.current.traceId
        : undefined;
      // eslint-disable-next-line no-console
      console.debug(`[DETAIL-TRACE] queryFn executing for ${conversationId?.slice(0, 12)} limit=${conversationDetailsLimit} traceId=${traceId?.slice(0, 16)}`);
      return api.getConversationDetails(conversationId!, {
        limit: conversationDetailsLimit,
        traceId,
        timeout: 20_000,
      });
    },
    enabled: !!conversationId,
    staleTime: 30_000,
    // Reuse fresh query data on rapid revisits during session-switch/archive flows.
    // Query keys are conversation-specific, so this does not risk showing a different session.
    refetchOnMount: true,
    // Visibility refresh is handled explicitly in the effect above.
    refetchOnWindowFocus: false,
    // Retry transient failures: 404s (new session, JSONL not yet written),
    // network errors (tab resume before network stack wakes up), and timeouts.
    retry: (failureCount, error) => {
      if (failureCount >= 3) return false;
      if (!(error instanceof Error)) return false;
      const msg = error.message;
      const is404 = msg.includes('not found');
      const isNetwork = msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed');
      const isTimeout = msg.includes('timeout');
      return is404 || isNetwork || isTimeout;
    },
    retryDelay: (attemptIndex) => Math.min(500 * 2 ** attemptIndex, 3000),
  });

  // The effort the conversation is recorded as running at, from the segment.
  // Shown when the user has not picked anything, so the control tells the
  // truth about a coordinator instead of falling back to the default entry.
  const savedReasoningEffort = conversationDetails?.reasoningEffort ?? null;

  // Drop the pending choice once the conversation is actually on it: the saved
  // value takes over from there, and a later change made elsewhere is not
  // masked by a selection the user has already had applied.
  useEffect(() => {
    if (pendingReasoningEffort && pendingReasoningEffort === savedReasoningEffort) {
      setPendingReasoningEffort(null);
    }
  }, [pendingReasoningEffort, savedReasoningEffort]);

  // A coordinator's thread is its conversation with the user and its worker
  // blocks; its own tool use folds behind one line. The flag comes from the
  // list or the details route (an archived session is not in the list), and
  // a thread that already has workers is a coordinator whatever the flag says.
  const isCoordinator = resolveIsCoordinator(conversationSummary, conversationDetails, workers.length);
  // The project this thread was picked up from, resolved the same way, so a
  // completed worker reached from a report link behaves like a live one. It
  // is both the header's way back and the test for a worker session.
  const parentConversationId = resolveParentConversationId(conversationSummary, conversationDetails);
  // A worker's mission and history restate the project thread it was picked up
  // from, so it gets no panel — and no toggle offering one. A worker that is
  // itself a coordinator keeps its own workers panel.
  const isWorkerSession = Boolean(parentConversationId);
  const hasInsightsPanel = isCoordinator || !isWorkerSession;
  // Same list-then-details resolution: without it an archived session, which
  // has no list row, reads as active and its header offers Archive again
  // instead of Restore.
  const isArchived = resolveIsArchived(conversationSummary, conversationDetails);
  const threadRenderItems = useMemo(
    () => (isCoordinator ? foldCoordinatorMachinery(harnessRenderItems, isStreaming) : harnessRenderItems),
    [isCoordinator, harnessRenderItems, isStreaming],
  );

  const {
    data: codexGoalResponse,
  } = useQuery({
    queryKey: ['codex-goal', conversationId],
    queryFn: () => api.getCodexGoal(conversationId!),
    enabled: Boolean(conversationId && activeProvider === 'codex'),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const codexGoal = activeProvider === 'codex'
    ? (codexGoalEventSeen ? harnessCodexGoal : codexGoalResponse?.goal ?? null)
    : null;

  const setCodexGoal = useCallback((goal: typeof codexGoal) => {
    queryClient.setQueryData(['codex-goal', conversationId], { goal });
  }, [conversationId, queryClient]);

  const handleSaveCodexGoal = useCallback(async (objective: string) => {
    if (!conversationId) return;
    const response = await api.updateCodexGoal(conversationId, {
      objective,
      status: 'active',
    });
    setCodexGoal(response.goal);
  }, [conversationId, setCodexGoal]);

  const handlePauseCodexGoal = useCallback(async () => {
    if (!conversationId) return;
    const response = await api.pauseCodexGoal(conversationId);
    setCodexGoal(response.goal);
  }, [conversationId, setCodexGoal]);

  const handleResumeCodexGoal = useCallback(async () => {
    if (!conversationId) return;
    const response = await api.resumeCodexGoal(conversationId);
    setCodexGoal(response.goal);
  }, [conversationId, setCodexGoal]);

  const handleClearCodexGoal = useCallback(async () => {
    if (!conversationId) return;
    await api.clearCodexGoal(conversationId);
    setCodexGoal(null);
  }, [conversationId, setCodexGoal]);

  useSessionVisibilityRefresh({
    conversationId,
    queryClient,
  });

  // Load insights
  const {
    data: insights,
    isLoading: insightsLoading,
  } = useQuery({
    queryKey: ['insights', conversationId],
    queryFn: () => api.unifiedGetInsights(conversationId!, true),
    enabled: !!conversationId,
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  const { onPerfRender } = useConversationNavigationTelemetry({
    conversationId,
    conversationDetails,
    insights,
    navStartRef,
    navigationDebugEnabled: debugFlags.navigation,
  });

  const {
    pendingQuestions,
    handleAnswerPendingQuestion,
    handleDismissPendingQuestion,
  } = usePendingQuestions({
    conversationId,
    isSessionIdle: isIdle,
    reconnectToStream: harnessReconnect,
  });

  // Claude's question is answered on its own tool card in the thread; the
  // rest (Codex's) have no card there and are shown below the messages.
  const inlineQuestion = pendingQuestions.find((q) => q.id.startsWith(CLAUDE_QUESTION_ID_PREFIX));
  const bannerQuestion = pendingQuestions.find((q) => !q.id.startsWith(CLAUDE_QUESTION_ID_PREFIX)) ?? null;
  const currentQuestionRequest = useMemo<QuestionRequest | null>(() => inlineQuestion ? {
    id: inlineQuestion.id,
    streamingId: inlineQuestion.streamingId,
    toolUseId: inlineQuestion.toolUseId,
    questions: inlineQuestion.questions,
    timestamp: inlineQuestion.createdAt,
    status: 'pending',
  } : null, [inlineQuestion]);

  // Compute sync state for insights panel
  const syncState = useMemo((): SyncState | undefined => {
    if (!insights) return undefined;
    const lastUpdateTime = insights.patchedAt || insights.computedAt || null;

    return { lastUpdateTime };
  }, [insights]);

  // Process conversation details for metadata only — messages come from harness events.
  useEffect(() => {
    if (!conversationDetails) return;
    if (conversationDetails.sessionId !== conversationId) return;

    maybeApplyProposedNextStepsFromConversationDetails({
      conversationDetails,
      currentProposedNextSteps: proposedNextSteps,
      isSessionIdle: isIdle,
      isDismissedThisSession: nextStepsDismissedRef.current,
      setProposedNextSteps: setProposedNextSteps,
    });


    maybeFocusComposerOnInitialConversationLoad({
      hasInitiallyFocusedRef,
      composerRef,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationDetails, proposedNextSteps]);

  useDocumentTitle({
    conversationSummary,
    insights,
    conversationTitle,
  });

  const toggleCrossSessionSidebar = useCallback(() => {
    onToggleSidebar?.();
  }, [onToggleSidebar]);

  // Highlight-a-span-and-note-it annotations for this conversation. Owned here
  // so the chips (above the composer) and the send path see the same list.
  const {
    annotations: pendingAnnotations,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    clearAnnotations,
    getPendingAnnotations,
    sendingCount: sendingAnnotationCount,
    beginSendingAnnotations,
    releaseAnnotations,
    consumeAnnotations,
  } = useMessageAnnotations(conversationId);
  const unsentAnnotationCount = pendingAnnotations.length - sendingAnnotationCount;

  const {
    handleSendMessage,
  } = useConversationSendHandlers({
    conversationId,
    provider: activeProvider,
    conversationPausedReason: conversationSummary?.pausedReason,
    session: sendSession,
    setSessionOptimisticOngoing,
    invalidateConversations,
    restoreDraftFromBackup,
    setSessionFailureError,
    nextStepsDismissedRef,
    getPendingAnnotations,
    onAnnotationsSending: beginSendingAnnotations,
    onAnnotationsReleased: releaseAnnotations,
    onAnnotationsSent: consumeAnnotations,
  });

  // The toolkit composer refuses an empty submit, so "notes with no typed
  // message" needs its own entry point into the same send path.
  const handleSendNotesOnly = useCallback(() => {
    if (getPendingAnnotations().length === 0) return;
    void handleSendMessage('', undefined, undefined, conversationSummary?.permissionMode || undefined);
  }, [handleSendMessage, getPendingAnnotations, conversationSummary?.permissionMode]);

  // Composer status controls are deliberately ordered Notes → Goal → Context.
  // Each control disappears when it has nothing useful to show.
  const renderComposerStatusControls = useCallback(() => (
    <>
      <AnnotationStatusBadge
        annotations={pendingAnnotations}
        onClearAll={clearAnnotations}
        onSendNotesOnly={handleSendNotesOnly}
        sendDisabled={isPermissionDecisionLoading}
        sendingCount={sendingAnnotationCount}
      />
      {activeProviderCapabilities.goals && codexGoal && (
        <ComposerGoalControl
          placement="status"
          objective={codexGoal.objective}
          status={codexGoal.status}
          disabled={isActive}
          onSave={handleSaveCodexGoal}
          onPause={handlePauseCodexGoal}
          onResume={handleResumeCodexGoal}
          onClear={handleClearCodexGoal}
        />
      )}
      <ComposerContextControl
        usage={harnessUsage}
        compaction={harnessCompaction}
        canCompact={isIdle}
        onCompact={harnessCompact}
      />
    </>
  ), [
    activeProviderCapabilities.goals,
    clearAnnotations,
    codexGoal,
    handleClearCodexGoal,
    handlePauseCodexGoal,
    handleResumeCodexGoal,
    handleSaveCodexGoal,
    handleSendNotesOnly,
    harnessCompact,
    harnessCompaction,
    harnessUsage,
    isActive,
    isIdle,
    isPermissionDecisionLoading,
    pendingAnnotations,
    sendingAnnotationCount,
  ]);

  const renderComposerGoalAction = useCallback(() => {
    if (!activeProviderCapabilities.goals || codexGoal || !isIdle) return null;
    return (
      <ComposerGoalControl
        placement="action"
        objective=""
        disabled={!isIdle}
        onSave={handleSaveCodexGoal}
        onClear={handleClearCodexGoal}
      />
    );
  }, [
    activeProviderCapabilities.goals,
    codexGoal,
    handleClearCodexGoal,
    handleSaveCodexGoal,
    isIdle,
  ]);

  const handleSelectNextStep = useCallback((prompt: string) => {
    nextStepsDismissedRef.current = true;
    clearNextSteps();
    const sessionPermissionMode = conversationSummary?.permissionMode;
    void handleSendMessage(prompt, undefined, undefined, sessionPermissionMode || undefined);
  }, [handleSendMessage, conversationSummary?.permissionMode, clearNextSteps]);

  const handleDismissNextSteps = useCallback(() => {
    nextStepsDismissedRef.current = true;
    clearNextSteps();
  }, [clearNextSteps]);

  const handlePermissionDecision = useCallback(async (
    requestId: string,
    action: 'approve' | 'deny',
    denyReason?: string
  ) => {
    if (isPermissionDecisionLoading) return;

    setIsPermissionDecisionLoading(true);
    try {
      await answerPermission(requestId, action, denyReason);
    } catch (err) {
      console.error('Failed to send permission decision:', err);
    } finally {
      setIsPermissionDecisionLoading(false);
    }
  }, [isPermissionDecisionLoading, answerPermission]);

  const handlePermissionPattern = useCallback(async (
    requestId: string,
    pattern: string,
    scope: 'session' | 'global'
  ) => {
    if (isPermissionDecisionLoading) return;

    setIsPermissionDecisionLoading(true);
    try {
      await answerPermissionWithPattern(requestId, pattern, scope);
    } catch (err) {
      console.error(`Failed to add pattern to ${scope} allowlist:`, err);
    } finally {
      setIsPermissionDecisionLoading(false);
    }
  }, [isPermissionDecisionLoading, answerPermissionWithPattern]);

  const handlePermissionPatterns = useCallback(async (
    requestId: string,
    patterns: string[],
    scope: 'session' | 'global'
  ) => {
    if (isPermissionDecisionLoading) return;

    setIsPermissionDecisionLoading(true);
    try {
      await answerPermissionWithPatterns(requestId, patterns, scope);
    } catch (err) {
      console.error(`Failed to add patterns to ${scope} allowlist:`, err);
    } finally {
      setIsPermissionDecisionLoading(false);
    }
  }, [isPermissionDecisionLoading, answerPermissionWithPatterns]);

  const { handleStop } = useConversationStopHandler({
    session: stopSession,
    conversationId,
    setStopRequested: setIsStopRequested,
  });
  // Reset session-level state when navigating between sessions
  useEffect(() => {
    setSessionFailureError(null);
  }, [conversationId]);

  const recoverStuckSessionLoad = useCallback(async (reason: SessionLoadWatchdogReason) => {
    if (!conversationId) return;
    if (loadRecoveryInFlightRef.current) return;

    const attempt = (loadRecoveryAttemptsRef.current[conversationId] || 0) + 1;
    if (attempt > SESSION_LOAD_MAX_RECOVERY_ATTEMPTS) return;
    loadRecoveryAttemptsRef.current[conversationId] = attempt;
    loadRecoveryInFlightRef.current = true;

    const navState = navStartRef.current;
    const elapsedMs = navState.conversationId === conversationId && navState.time
      ? Math.round(performance.now() - navState.time)
      : null;

    logSessionLoadWatchdogTriggered({
      sessionId: conversationId,
      reason,
      attempt,
      elapsedMs,
    });

    try {
      reconnectClaudeStreamIfNeeded({
        streamingId: null,
        isConnected: harnessConnected,
        reconnectToStream: harnessReconnect,
      });

      await reconnectFromConversationStatus({
        sessionId: conversationId,
        reconnectToStream: harnessReconnect,
      });

      await refetchSessionWatchdogQueries({
        queryClient,
        sessionId: conversationId,
      });
    } finally {
      loadRecoveryInFlightRef.current = false;
    }
  }, [
    conversationId,
    harnessConnected,
    harnessReconnect,
    queryClient,
  ]);

  const unifiedHydrating = !detailsError && detailsLoading;
  const isLoading = unifiedHydrating;

  const combinedMessages = useMemo(() => {
    return dedupeNearDuplicateUserMessages(mergedMessages);
  }, [mergedMessages]);

  // Diagnostic: detect duplicate messages and ship telemetry with causal trace
  useDuplicateMessageDetector({
    conversationId: conversationId ?? null,
    messages: combinedMessages,
    actionTrace: harnessActionTrace,
    connected: harnessConnected,
    status: harnessStatus,
  });

  const {
    hasMoreMessages,
    isLoadingMore,
    jumpToMessageId,
    setJumpToMessageId,
    loadMoreMessages,
    handleJumpToTurn,
  } = useMessagePagination({
    conversationId,
    combinedMessages,
    fetchHistory: harnessFetchHistory,
    initialMessageLimit: INITIAL_MESSAGE_LIMIT,
  });
  useDevNoteAutoCheckoff({
    conversationId,
    combinedMessages,
    showToast,
  });

  // Composer display status — derived directly from harness signals.
  // processAlive = keep-alive process connected (from events: turn:end = alive, run:end = dead)
  // isActive/isStreaming = harness status derivation
  const isProviderBusy = isActive;
  // A turn held on its own question card (a Codex request_user_input_async) waits on the user, not on the agent.
  const awaitingAnswer = isProviderBusy && [...harnessDecisions.byId.values()].some((decision) => decision.asked.holdsTurn && isOpenDecision(decision));
  // The open question stays in reach once its card is out of sight: a strip
  // above the composer, and a Needs you row in the panel. Either takes the
  // user back to the card to answer it.
  const [cardInSight, setCardInSight] = useState<{ id: string; inSight: boolean } | null>(null);
  const handleCardInSight = useCallback((id: string, inSight: boolean) => setCardInSight({ id, inSight }), []);
  const openCardOutOfSight = harnessOpenDecision !== null
    && !(cardInSight?.id === harnessOpenDecision.asked.id && cardInSight.inSight);
  const jumpToOpenCard = useCallback(() => {
    if (harnessOpenDecision) setJumpToMessageId(harnessOpenDecision.messageId);
  }, [harnessOpenDecision, setJumpToMessageId]);
  const dismissOpenCard = useCallback(async () => {
    if (harnessOpenDecision && conversationId) await dismissQuestion(conversationId, harnessOpenDecision.asked.id);
  }, [harnessOpenDecision, conversationId]);

  const wasIdleRef = useRef(isIdle);
  useEffect(() => {
    const wasIdle = wasIdleRef.current;
    wasIdleRef.current = isIdle;

    if (!conversationId && isStopRequested) {
      setIsStopRequested(false);
      return;
    }

    // Only clear isStopRequested when the session TRANSITIONS to idle (wasIdle=false → isIdle=true).
    // If the session was already idle when stop was clicked (Connected state),
    // the stop handler's cleanupAll() handles clearing — not this effect.
    if (!isProviderBusy && isIdle && !wasIdle && isStopRequested) {
      setIsStopRequested(false);
    }
  }, [conversationId, isProviderBusy, isIdle, isStopRequested]);

  // Diagnostic: log full status picture on mount (before any transitions)
  const hasLoggedMountRef = useRef(false);
  useEffect(() => {
    hasLoggedMountRef.current = false;
  }, [conversationId]);
  useEffect(() => {
    if (hasLoggedMountRef.current) return;
    hasLoggedMountRef.current = true;
    // eslint-disable-next-line no-console
    console.debug(
      `[status:mount] ${conversationId?.slice(0, 12)}`,
      `alive=${processAlive} busy=${isProviderBusy}`,
      {
        'status.status': sessionStatus.status,
        'status.streamingId': sessionStatus.streamingId?.slice(0, 8) ?? '-',
        'status.isFetching': sessionStatus.isFetching,
        'status.isLoading': sessionStatus.isLoading,
        'status.dataUpdatedAt': sessionStatus.dataUpdatedAt,
        'harnessStatus': harnessStatus,
        'isActive': isActive,
        'harnessConnected': harnessConnected,
        'session.streamingId': '-',
      }
    );
    // `hasLoggedMountRef` is the real guard: it logs once per conversation, and the
    // reset effect above (same dep, declared first, so it commits first) is the only
    // thing that can unblock another log. Depending on the logged values as well would
    // just re-enter and bail, which is what running on every render was already doing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Diagnostic: structured status transition logging for autonomous debugging
  const prevStatusRef = useRef({ isProviderBusy, processAlive });
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev.isProviderBusy !== isProviderBusy || prev.processAlive !== processAlive) {
      // eslint-disable-next-line no-console
      console.debug(
        `[status:view] ${conversationId?.slice(0, 12)}`,
        `busy=${isProviderBusy} (was ${prev.isProviderBusy})`,
        `alive=${processAlive} (was ${prev.processAlive})`,
        {
          'isActive': isActive,
          'harnessConnected': harnessConnected,
          'harnessStatus': harnessStatus,
          'status.isOngoing': sessionStatus.isOngoing,
          'status.isFetching': sessionStatus.isFetching,
        }
      );
      prevStatusRef.current = { isProviderBusy, processAlive };
    }
    // The body is a no-op unless one of these two flipped, so these are the only deps
    // that can produce a log. The other values are read from the same render that
    // flipped them, exactly as before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProviderBusy, processAlive]);

  // Reset watchdog attempt tracking when switching sessions
  useEffect(() => {
    if (!conversationId) return;
    loadRecoveryAttemptsRef.current[conversationId] = 0;
    loadRecoveryInFlightRef.current = false;
  }, [conversationId]);

  // Session-switch watchdog:
  // - "empty-active": active state present but no content arrives
  // - "slow-hydration": data loading hangs for too long
  useEffect(() => {
    if (!conversationId) return;

    const isNotFoundDetailsError = detailsError instanceof Error && detailsError.message.includes('not found');
    if (detailsError && !(isNotFoundDetailsError && processAlive)) return;

    const attempts = loadRecoveryAttemptsRef.current[conversationId] || 0;
    if (attempts >= SESSION_LOAD_MAX_RECOVERY_ATTEMPTS) return;

    const hasActiveSignal = isProviderBusy;
    const noVisibleContent = combinedMessages.length === 0;
    const slowHydration = detailsLoading || detailsFetching;
    const recovery = evaluateSessionLoadWatchdogRecovery({
      hasActiveSignal,
      noVisibleContent,
      slowHydration,
    });
    if (!recovery.shouldRecover) return;

    const timer = setTimeout(() => {
      void recoverStuckSessionLoad(recovery.reason);
    }, recovery.delayMs);

    return () => clearTimeout(timer);
  }, [
    conversationId,
    detailsError,
    detailsLoading,
    detailsFetching,
    isProviderBusy,
    processAlive,
    combinedMessages.length,
    recoverStuckSessionLoad,
  ]);

  // Suppress 404 errors for new sessions that are actively starting/streaming
  // The JSONL file may not exist yet when navigating immediately after session start
  const isNewSessionStarting = isProviderBusy || processAlive;
  const isNotFoundError = detailsError instanceof Error && detailsError.message.includes('not found');
  const queryError = (detailsError && !(isNotFoundError && isNewSessionStarting))
    ? humanizeLoadError((detailsError as Error).message)
    : null;
  // Also suppress error while retrying
  const displayError = sessionError === 'session_limit' ? null
    : sessionError === 'init_timeout' ? null  // Handled by dedicated banner below
    : detailsFetching ? null  // Suppress errors while retrying
    : (sessionFailureError || sessionError || queryError);

  // A worker's request is its coordinator's to decide until it escalates.
  const inlinePermissionPrompt = permissionRequest?.coordinator && !permissionRequest.escalation ? (
    <PermissionWaitingLine permission={permissionRequest} />
  ) : permissionRequest ? (
    <PermissionBanner
      permission={permissionRequest}
      streamingId={undefined}
      workingDirectory={conversationSummary?.workingDirectory}
      onApprove={() => handlePermissionDecision(permissionRequest!.id, 'approve')}
      onApprovePattern={(pattern, scope) => handlePermissionPattern(permissionRequest!.id, pattern, scope)}
      onApprovePatterns={(patterns, scope) => handlePermissionPatterns(permissionRequest!.id, patterns, scope)}
      onDeny={(reason) => handlePermissionDecision(permissionRequest!.id, 'deny', reason)}
      isLoading={isPermissionDecisionLoading}
    />
  ) : null;

  // Plan approval callbacks — bound to current conversationId, passed through to toolkit ToolUseRenderer
  const handlePlanApprove = useCallback(async () => {
    if (!conversationId) return;
    await api.resumeConversation(conversationId, {
      message: 'Approved. Proceed with the plan.',
      permissionMode: 'bypassPermissions',
    });
  }, [conversationId]);

  const handlePlanReject = useCallback(async () => {
    if (!conversationId) return;
    await api.resumeConversation(conversationId, {
      message: 'Plan rejected — please revise or take a different approach.',
      permissionMode: 'plan',
    });
  }, [conversationId]);

  return (
    <Profiler id="ConversationView" onRender={onPerfRender}>
      <TeamColorProvider teamName={conversationSummary?.teamName ?? null}>
      <SenderNamesProvider senders={senders}>
      <ReactionsProvider key={conversationId} sessionId={conversationId ?? undefined} reactions={harnessReactions} agentReactions={harnessAgentReactions}>
      <DecisionsProvider sessionId={conversationId ?? undefined} decisions={harnessDecisions} onCardInSight={handleCardInSight}>
      <ExplainsProvider sessionId={conversationId ?? undefined} explains={harnessExplains}>
      <ToolkitBridge>
      <div className="h-full w-full flex flex-col bg-background relative overflow-hidden" role="main" aria-label="Conversation view">
      <ConversationHeader
        sessionId={conversationId}
        isArchived={isArchived}
        isPinned={conversationSummary?.pinned || false}
        subtitle={conversationSummary ? {
          date: new Date(conversationSummary.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          repo: conversationSummary.workingDirectory.split('/').pop() || 'project',
        } : undefined}
        parentConversationId={parentConversationId}
        insightsPanelOpen={hasInsightsPanel && insightsPanelOpen}
        onToggleInsightsPanel={hasInsightsPanel ? toggleInsightsPanel : undefined}
        crossSessionSidebarOpen={crossSessionSidebarOpen}
        onToggleCrossSessionSidebar={toggleCrossSessionSidebar}
      />

      {displayError && (
        <div
          className="bg-[rgb(var(--color-rose-rgb)/0.1)] border-b border-line text-rose-300 px-4 py-2 text-sm text-center animate-in slide-in-from-top duration-300"
          role="alert"
        >
          {displayError}
        </div>
      )}

      {sessionError === 'init_timeout' && (
        <div
          className="bg-[rgb(var(--color-amber-rgb)/0.1)] border-b border-line text-amber-400 px-4 py-2 text-sm text-center animate-in slide-in-from-top duration-300"
          role="alert"
        >
          Session initialization timed out — the conversation may be too large. Consider starting a fresh session.
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        <div className="flex-1 flex flex-col min-w-0 relative">
          <>
          <Profiler id="MessageList" onRender={onPerfRender}>
            <MessageList
              sessionId={conversationId}
              messages={unifiedHydrating && combinedMessages.length === 0 ? [] : combinedMessages}
              renderItems={threadRenderItems}
              toolResults={toolResults}
              childrenMessages={harnessChildrenMessages}
              expandedTasks={expandedTasks}
              onToggleTaskExpanded={toggleTaskExpanded}
              isLoading={isLoading}
              isStreaming={isStreaming}
              streamingProvider={activeProvider}
              pendingQuestion={bannerQuestion}
              currentQuestionRequest={currentQuestionRequest}
              onAnswerQuestion={handleAnswerPendingQuestion}
              onAnswerPendingQuestion={handleAnswerPendingQuestion}
              onDismissPendingQuestion={handleDismissPendingQuestion}
              hasMore={hasMoreMessages}
              isLoadingMore={isLoadingMore}
              onLoadMore={loadMoreMessages}
              branchLineage={conversationDetails?.sessionInfo?.branched_from_session_id ? {
                parentSessionId: conversationDetails.sessionInfo.branched_from_session_id,
                atTurn: conversationDetails.sessionInfo.branched_at_turn || 0,
                branchPointMessageId: conversationDetails.branchPointMessageId,
              } : undefined}
              onNavigateToSession={(targetSessionId) => navigate(`/c/${targetSessionId}`)}
              isSwitchingProvider={false}
              switchingToProvider={activeProvider}
              jumpToMessageId={jumpToMessageId}
              onJumpHandled={() => setJumpToMessageId(null)}
              inlinePermissionPrompt={inlinePermissionPrompt}
              onPlanApprove={handlePlanApprove}
              onPlanReject={handlePlanReject}
              backgroundTaskStates={backgroundTaskStates}
              actionTrace={harnessActionTrace}
              hydrationPhase={harnessHydrationPhase}
            />
          </Profiler>

          {/* Message debug overlay — activated via ?debug=messages URL param */}
          {showMessageDebug && (
            <MessageDebugOverlay
              messages={combinedMessages}
              toolResults={toolResults}
              childrenMessages={harnessChildrenMessages}
              sessionId={conversationId}
            />
          )}

          {/*
            Persistent per-span markers for pending notes. Portals into each
            annotated assistant message, so its mount point here is arbitrary —
            it only needs to render whenever the transcript does.
          */}
          <AnnotationSpanIcons
            annotations={pendingAnnotations}
            onUpdate={updateAnnotation}
            onRemove={removeAnnotation}
          />

          </>
          {conversationSummary?.importedAt ? (
            <div
              className="flex-shrink-0 z-10 w-full flex justify-center py-3"
              style={{ paddingBottom: 'calc(var(--lattice-composer-dock-bottom-gap) + var(--lattice-safe-area-bottom))' }}
            >
              <div className="inline-flex items-center gap-2 rounded-md bg-surface px-3 py-1.5">
                <Import size={14} className="text-fg-3" />
                <span className="text-xs text-fg-2">
                  Imported session — read-only
                </span>
              </div>
            </div>
          ) : (
            <div
              // Measured by AnnotationSelectionLayer to float the "Add note"
              // pill just above this dock without affecting its layout.
              data-composer-dock="true"
              className="flex-shrink-0 bg-bg z-10 w-full flex flex-col items-center pt-3"
              style={{ paddingBottom: 'calc(var(--app-composer-dock-bottom-gap) + var(--app-safe-area-bottom))' }}
            >
              {/* Proposed next steps from Claude */}
              {proposedNextSteps
                && proposedNextSteps.length > 0
                && isIdle && (
                <div className="w-full max-w-3xl px-4 mb-2">
                  <NextStepsPrompt
                    steps={proposedNextSteps}
                    onSelect={handleSelectNextStep}
                    onDismiss={handleDismissNextSteps}
                  />
                </div>
              )}
              {harnessOpenDecision && openCardOutOfSight && <OpenQuestionStrip key={harnessOpenDecision.asked.id} question={harnessOpenDecision.asked.question} onJump={jumpToOpenCard} onDismiss={dismissOpenCard} />}
              {/* Pending mid-turn injected messages — floating above composer */}
              <QueuedMessages key={conversationId} messages={harnessPendingMessages} />
              {/*
                "Add note" affordance for highlighted spans. Always portalled
                and fixed-position, so it adds nothing to this dock's layout.
                The pending-note count lives in the composer status bar, next
                to the model badge (renderStatusExtra below).
              */}
              <AnnotationSelectionLayer onAdd={addAnnotation} renderDockedActions={(messageId) => <SelectionMessageActions messageId={messageId} />} />
              <div className="w-full max-w-3xl px-4">
                <Composer
                  key={composerMount}
                  ref={composerRef}
                  core={{
                    sessionId: conversationId,
                    onSubmit: handleSendMessage,
                    isLoading: harnessConnected || isPermissionDecisionLoading,
                    // Compaction no longer locks the composer: sends made while
                    // it runs are queued and drained on completion, so a couple
                    // of minutes of compaction is not a couple of minutes of
                    // being unable to type.
                    placeholder: 'Reply',
                    // Pending notes fill the outgoing message on their own, so
                    // the composer may submit empty while any are queued and
                    // not already on a send that has not resolved.
                    allowEmptySubmit: unsentAnnotationCount > 0,
                  }}
                  features={{
                    enableAttachments: supportsAttachments(activeProvider),
                    enableFileAutocomplete: true,
                  }}
                  provider={activeProvider}
                  permissionMode={conversationSummary?.permissionMode || undefined}
                  workingDirectory={conversationSummary?.workingDirectory}
                  permissionConfig={{
                    onStop: handleStop,
                    onInterrupt: forceKill,
                  }}
                  renderStatusExtra={renderComposerStatusControls}
                  renderActionsExtra={renderComposerGoalAction}
                  runtimeConfig={{
                    isSessionActive: isProviderBusy && !isCompactingAfterReply,
                    awaitingAnswer,
                    // While hydrating, status is gated to 'idle' (see
                    // useHarnessSession) but processAlive derives from the
                    // partial event log — the pair reads alive+idle, which the
                    // composer renders as Ready mid-spawn. Gate liveness the
                    // same way so the composer never sees the contradiction.
                    isSessionConnected: processAlive && harnessHydrationPhase === 'ready',
                    isStopRequested,
                    isInitializing: isInitializing,
                    isCompacting,
                    hasBackgroundTasks: pendingWork !== null,
                    backgroundTaskLabel: pendingWork
                      ? PENDING_WORK_STATUS_LABEL[pendingWork]
                      : undefined,
                    sessionStartTime: harnessActiveStartTime ?? undefined,
                    onFetchFileSystem: handleFetchFileSystem,
                    onFetchCommands: handleFetchCommands,
                    sessionModel: harnessSessionModel,
                    sessionModelFallback: harnessSessionModelFallback,
                    ...(activeProviderCapabilities.modelSwitching.model ? {
                      availableModels: activeProvider === 'codex'
                        ? switchableCodexModels
                        : switchableClaudeModels,
                      selectedModel: pendingModel,
                      onModelChange: setPendingModel,
                    } : {}),
                    ...(activeProviderCapabilities.modelSwitching.reasoningEffort ? {
                      availableEfforts: switchableCodexEfforts,
                      selectedEffort: pendingReasoningEffort ?? savedReasoningEffort,
                      onEffortChange: setPendingReasoningEffort,
                    } : {}),
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <Profiler id="InsightsPanel" onRender={onPerfRender}>
          {isCoordinator ? (
          <CoordinatorPanel
            isOpen={insightsPanelOpen}
            onClose={closeInsightsPanel}
            workers={workers}
            project={project}
            coordinatorRunning={harnessStatus === 'streaming' || harnessStatus === 'initializing'}
            onOpenWorker={(workerId) => navigate(`/c/${workerId}`)}
            coordinatorId={conversationId}
            openQuestion={harnessOpenDecision ? { question: harnessOpenDecision.asked.question, thread: harnessOpenDecision.asked.thread } : null}
            onJumpToQuestion={jumpToOpenCard}
            onDismissQuestion={dismissOpenCard}
          />
          ) : isWorkerSession ? null : (
          <InsightsPanel
            insights={insights ?? null}
            isLoading={insightsLoading}
            isOpen={insightsPanelOpen}
            onClose={closeInsightsPanel}
            syncState={syncState}
            isPendingInsightsUpdate={conversationId ? pendingInsightsUpdates.has(conversationId) : false}
            sessionId={conversationId}
            canBranch={activeProviderCapabilities.branching !== 'unsupported'}
            onJumpToTurn={handleJumpToTurn}
            onBranch={async (newSessionId) => {
              await invalidateConversations();
              void navigate(`/c/${newSessionId}`);
            }}
          />
          )}
        </Profiler>
      </div>

      </div>
      </ToolkitBridge>
      </ExplainsProvider>
      </DecisionsProvider>
      </ReactionsProvider>
      </SenderNamesProvider>
      </TeamColorProvider>
    </Profiler>
  );
}
