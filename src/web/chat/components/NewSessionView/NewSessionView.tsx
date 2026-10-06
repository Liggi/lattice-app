/**
 * NewSessionView — Draft composer for creating new sessions.
 *
 * Renders a minimal view with the Composer ready to type. On send,
 * creates the conversation via API and navigates to /c/{conversationId}.
 *
 * Provider and permission mode are read from URL search params
 * (set by the sidebar "New Session" button) or fall back to defaults.
 */

import type { PastedSpan } from '@liggi/agent-ui-harness/protocol';
import React, { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Bot, Code2, PanelLeft, Boxes, Server, Settings } from 'lucide-react';
import { DEFAULT_OPENCODE_MODEL_ID } from '@/constants/opencode-models.js';

/** Toggle icon per provider. Keep in step with the Provider union. */
const PROVIDER_ICONS = {
  claude: Bot,
  codex: Code2,
  opencode: Boxes,
} as const;

/** Display names; the Provider values themselves stay lowercase for tests and routing. */
const PROVIDER_LABELS: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Providers a new session can start on. OpenCode stays wired but is not offered yet. */
const NEW_SESSION_PROVIDERS = ['claude', 'codex'] as const;

import {
  coordinatorClaudeModelFrom,
  coordinatorCodexDefaultsFrom,
  coordinatorProviderFor,
} from '@/constants/coordinator-defaults';
import { Composer } from '@/web/chat/components/Composer';
import { ComposerGoalControl } from '@/web/chat/components/Composer/ComposerGoalControl';
import { api } from '../../services/api';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { useConversations } from '../../contexts/ConversationsContext';
import type { Provider } from '@/types/unified-messages';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { resolveInitialLaunchPermissionMode } from '../../utils/session-launch-permissions';
import { ActionQueueDialog } from '../DevNotesDialog/DevNotesDialog';
import { LatticeLogo } from '../shared/LatticeLogo';
import { HeaderNotesButton } from '../ConversationHeader/HeaderControls';
import { launchQueueSession } from '../ConversationHeader/queue-session';
import type { DevNote, StoredRecommendation } from '../../types';
import { TooltipProvider } from '../ui/tooltip';
import { SettingsDialog } from '../SettingsDialog/SettingsDialog';
import { planSignInWaiting } from '../SettingsDialog/ChatGPTPlanCard';
import { useProviderSignIn } from '../../hooks/useProviderSignIn';
import { ProviderSignInStatus } from './ProviderSignInStatus';
import { reportMilestone } from '../../utils/timeline-reporter';
import {
  CLAUDE_MODELS,
  formatClaudeModelLabel,
} from '@/constants/claude-models';
import { endpointModelOption } from '@/constants/claude-endpoint';
import {
  CODEX_MODELS,
  CODEX_EFFORTS,
  DEFAULT_CODEX_MODEL_ID,
  DEFAULT_CODEX_EFFORT,
  effortsForCodexModel,
} from '@/constants/codex-models';

/**
 * Stands for "no --model" in the picker. Choosing the default row sends no
 * model, so this id never reaches the server.
 */
const CLAUDE_CLI_DEFAULT_MODEL = 'claude-cli-default';

interface NewSessionViewProps {
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
}

/** Header attention count refresh cadence; pauses while the tab is hidden. */
const HEADER_ATTENTION_POLL_MS = 15_000;

function createPendingLaunchId(): string {
  return `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function NewSessionView({ sidebarOpen, onToggleSidebar }: NewSessionViewProps): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { serverConfig, coordinatorConfig, claudeEndpoints, isLoading: preferencesLoading } = usePreferencesContext();
  const {
    addOptimisticSession,
    addPendingLaunch,
    removePendingLaunch,
    invalidateConversations,
  } = useConversations();
  const { data: signIn } = useProviderSignIn();
  const [settingsOpen, setSettingsOpen] = useState(planSignInWaiting);
  const workspaceId = 'main';

  const [isCreating, setIsCreating] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  // Read provider and permission mode from URL params or fall back to defaults
  const _paramProvider = searchParams.get('provider');
  const paramMode = searchParams.get('mode');

  // "New project" (?coordinator=1) starts a coordinator on Claude or Codex with
  // no model to pick; the server prepends the `front` preamble when the create
  // call says so.
  const coordinator = searchParams.get('coordinator') === '1';
  const coordinatorSettings = {
    coordinator: coordinatorConfig ?? undefined,
    server: serverConfig ?? undefined,
  };
  const searchParamProvider: Provider = _paramProvider === 'codex' ? 'codex'
    : _paramProvider === 'claude' ? 'claude'
    : coordinator ? coordinatorProviderFor(coordinatorSettings, signIn) : 'claude';
  const [provider, setProvider] = useState<Provider>(searchParamProvider);
  const [goalObjective, setGoalObjective] = useState('');
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // A saved endpoint picked beside Claude and Codex: a Claude session on that
  // server's model. Null is Claude on the sign-in.
  const [endpointModel, setEndpointModel] = useState<string | null>(null);
  const endpoint = claudeEndpoints.find((candidate) => candidate.model === endpointModel) ?? null;
  const [selectedEffort, setSelectedEffort] = useState<string | null>(null);

  useEffect(() => {
    setProvider(searchParamProvider);
  }, [searchParamProvider]);

  // On provider switch, both model and effort selections are provider-specific,
  // so drop them back to their respective defaults.
  useEffect(() => {
    setSelectedModel(null);
    setSelectedEffort(null);
  }, [provider, endpointModel]);

  // A Claude session with no configured model runs on the Claude CLI's own
  // default, which only the CLI knows, so it is shown as that.
  const effectiveDefaultModel = endpoint
    ? endpoint.model
    : coordinator
    ? coordinatorClaudeModelFrom(coordinatorSettings) ?? CLAUDE_CLI_DEFAULT_MODEL
    : serverConfig?.defaultModel?.trim() || CLAUDE_CLI_DEFAULT_MODEL;
  const coordinatorCodexDefaults = coordinatorCodexDefaultsFrom(coordinatorSettings);
  const codexDefaultModel = coordinator ? coordinatorCodexDefaults.model : DEFAULT_CODEX_MODEL_ID;
  const codexDefaultEffort = coordinator ? coordinatorCodexDefaults.reasoningEffort : DEFAULT_CODEX_EFFORT;

  // Codex only: reasoning-effort options depend on the selected model. If the
  // current effort choice isn't offered by the newly-selected model, reset it.
  useEffect(() => {
    if (provider !== 'codex' || selectedEffort === null) return;
    const efforts = effortsForCodexModel(selectedModel ?? codexDefaultModel);
    if (!efforts.includes(selectedEffort)) {
      setSelectedEffort(null);
    }
  }, [provider, selectedModel, selectedEffort, codexDefaultModel]);

  const claudeAvailableModels = React.useMemo(() => {
    if (endpoint) return [endpointModelOption(endpoint, true)];
    const selectable: Array<{ id: string; label: string; description?: string; isDefault: boolean }> =
      CLAUDE_MODELS.filter((m) => m.composerSelectable).map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        isDefault: m.id === effectiveDefaultModel,
      }));
    if (!selectable.some((m) => m.id === effectiveDefaultModel)) {
      selectable.push({
        id: effectiveDefaultModel,
        label: effectiveDefaultModel === CLAUDE_CLI_DEFAULT_MODEL
          ? 'Claude Code default'
          : formatClaudeModelLabel(effectiveDefaultModel),
        ...(effectiveDefaultModel === CLAUDE_CLI_DEFAULT_MODEL
          ? { description: 'Whatever the Claude CLI on this machine defaults to for your account' }
          : {}),
        isDefault: true,
      });
    }
    return selectable;
  }, [effectiveDefaultModel, endpoint]);

  const codexAvailableModels = React.useMemo(() => {
    const selectable: Array<{ id: string; label: string; description?: string; isDefault: boolean }> =
      CODEX_MODELS.filter((m) => m.composerSelectable).map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        isDefault: m.id === codexDefaultModel,
      }));
    if (!selectable.some((m) => m.id === codexDefaultModel)) {
      selectable.push({ id: codexDefaultModel, label: codexDefaultModel, isDefault: true });
    }
    return selectable;
  }, [codexDefaultModel]);

  // Codex effort options follow the currently-effective codex model.
  const codexAvailableEfforts = React.useMemo(() => {
    const effortIds = effortsForCodexModel(selectedModel ?? codexDefaultModel);
    return effortIds.map((effortId) => {
      const meta = CODEX_EFFORTS.find((e) => e.id === effortId);
      return {
        id: effortId,
        label: meta?.label ?? effortId,
        description: meta?.description,
        isDefault: effortId === codexDefaultEffort,
      };
    });
  }, [selectedModel, codexDefaultModel, codexDefaultEffort]);

  const permissionMode = resolveInitialLaunchPermissionMode({
    explicit: paramMode ?? undefined,
    fallback: serverConfig?.defaultPermissionMode,
    provider: searchParamProvider,
  });

  // Not the server's own cwd: on a source install that is Lattice's checkout.
  // Every session launches from the one folder set in Settings; the agents
  // find the repos under it that the work involves.
  const workingDirectory = serverConfig?.defaultWorkingDirectory?.trim() || '~';

  // Header attention count (dev notes + pending recommendations). React Query owns the
  // cadence so a backgrounded tab stops polling — refetchIntervalInBackground defaults
  // to false, where the old raw setInterval kept firing two requests every 15s forever.
  const {
    data: queueCount = 0,
    refetch: refetchHeaderAttention,
  } = useQuery({
    queryKey: ['new-session-header-attention'],
    queryFn: async (): Promise<number> => {
      try {
        const [notesRes, recsRes] = await Promise.all([
          api.getDevNotes(),
          api.getPendingRecommendations(),
        ]);
        return notesRes.notes.length + recsRes.recommendations.length;
      } catch (error) {
        console.error('Failed to refresh new-session header state:', error);
        throw error;
      }
    },
    refetchInterval: HEADER_ATTENTION_POLL_MS,
    staleTime: HEADER_ATTENTION_POLL_MS,
    // One attempt per tick, as the old interval did; the next tick is the retry.
    retry: false,
  });

  const refreshHeaderAttention = useCallback(async () => {
    await refetchHeaderAttention();
  }, [refetchHeaderAttention]);

  const _handleProviderChange = useCallback((nextProvider: Provider) => {
    setProvider(nextProvider);
    setEndpointModel(null);

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set('provider', nextProvider);
    setSearchParams(nextSearchParams, { replace: true });
  }, [searchParams, setSearchParams]);


  const handleQueueClose = useCallback(() => {
    setQueueOpen(false);
    void refreshHeaderAttention();
  }, [refreshHeaderAttention]);

  const handleLaunchQueueSession = useCallback(async (
    notes: DevNote[],
    recommendations: StoredRecommendation[],
    nextProvider?: Provider,
    nextPermissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  ) => {
    if (notes.length === 0 && recommendations.length === 0) return;

    const effectiveProvider = nextProvider || 'claude';
    const response = await launchQueueSession(
      api,
      notes,
      recommendations,
      workingDirectory,
      {
        workspace: workspaceId,
        provider: effectiveProvider,
        model: serverConfig?.defaultModel,
        permissionMode: nextPermissionMode || permissionMode,
      }
    );

    if (!response) return null;

    await invalidateConversations();
    return { sessionId: response.conversationId };
  }, [
    invalidateConversations,
    permissionMode,
    serverConfig?.defaultModel,
    workingDirectory,
  ]);

  const handleSubmit = useCallback(async (
    message: string,
    _workingDirectory?: string,
    model?: string,
    _permissionMode?: string,
    attachments?: ContentBlockParam[],
    effort?: string,
    pastes?: PastedSpan[],
  ) => {
    // A bare screenshot paste with no typed text is a valid first message —
    // /api/conv/create accepts message-or-initialContent.
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if ((!message.trim() && !hasAttachments) || isCreating || (coordinator && preferencesLoading)) return;

    setIsCreating(true);

    const requestProvider = provider;
    const targetProvider = requestProvider;
    const providerFallbackModel = targetProvider === 'codex'
      ? codexDefaultModel
      : targetProvider === 'opencode'
        ? DEFAULT_OPENCODE_MODEL_ID
        : effectiveDefaultModel;
    const fallbackModel = model || providerFallbackModel;
    // No --model at all lets the Claude CLI pick its own default.
    const requestModel = fallbackModel === CLAUDE_CLI_DEFAULT_MODEL ? undefined : fallbackModel;
    const requestedEffort = effort ?? (coordinator ? codexDefaultEffort : undefined);
    // Always use the permission mode from URL params (set by sidebar controls),
    // not the Composer's internal selectedPermissionMode.
    const effectiveMode = permissionMode;
    const pendingLaunchId = createPendingLaunchId();

    addPendingLaunch({
      tempId: pendingLaunchId,
      workingDirectory: _workingDirectory || workingDirectory,
      initialPrompt: message,
      // The server records 'unknown' for a Claude run on the CLI's default.
      model: requestModel ?? 'unknown',
      permissionMode: effectiveMode,
      workspace: workspaceId,
      provider: targetProvider,
    });

    try {
      const response = await api.createConversation({
        provider: requestProvider,
        ...(requestModel ? { model: requestModel } : {}),
        message,
        workingDirectory: _workingDirectory || workingDirectory,
        permissionMode: effectiveMode,
        workspace: workspaceId,
        // Composer attachments for the first turn. The provider adapter validates
        // the concrete block types it supports and fails visibly on a mismatch.
        ...(hasAttachments ? { initialContent: attachments } : {}),
        ...(pastes && pastes.length > 0 ? { pastes } : {}),
        ...(requestProvider === 'codex' && goalObjective.trim()
          ? { goalObjective: goalObjective.trim() }
          : {}),
        ...(requestProvider === 'codex' && requestedEffort
          ? { reasoningEffort: requestedEffort }
          : {}),
        ...(coordinator ? { coordinator: true } : {}),
      });

      // Persist last provider
      try {
        localStorage.setItem(`lattice:last-provider:${response.conversationId}`, response.provider);
      } catch { /* ignore */ }

      // Add optimistic session
      addOptimisticSession({
        conversationId: response.conversationId,
        streamingId: response.streamingId,
        workingDirectory: response.cwd,
        model: response.model,
        permissionMode: response.permissionMode || effectiveMode,
        initialPrompt: message,
        workspace: workspaceId,
        provider: response.provider,
      });

      // Navigate to the new conversation
      reportMilestone(response.conversationId, 'client.navigate_to_conversation');
      void navigate(`/c/${response.conversationId}`);

      // Refresh sidebar in background
      void invalidateConversations();
    } catch (error) {
      console.error('Failed to create session:', error);
      alert(`Failed to create session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      removePendingLaunch(pendingLaunchId);
      setIsCreating(false);
    }
  }, [
    isCreating,
    preferencesLoading,
    provider,
    coordinator,
    permissionMode,
    workingDirectory,
    workspaceId,
    goalObjective,
    codexDefaultModel,
    codexDefaultEffort,
    effectiveDefaultModel,
    addOptimisticSession,
    addPendingLaunch,
    removePendingLaunch,
    invalidateConversations,
    navigate,
  ]);

  const renderGoalStatus = useCallback(() => {
    if (provider !== 'codex' || !goalObjective.trim()) return null;
    return (
      <ComposerGoalControl
        placement="status"
        objective={goalObjective}
        disabled={isCreating}
        onSave={setGoalObjective}
        onClear={() => setGoalObjective('')}
      />
    );
  }, [goalObjective, isCreating, provider]);

  const renderGoalAction = useCallback(() => {
    if (provider !== 'codex' || goalObjective.trim()) return null;
    return (
      <ComposerGoalControl
        placement="action"
        objective=""
        disabled={isCreating}
        onSave={setGoalObjective}
        onClear={() => setGoalObjective('')}
      />
    );
  }, [goalObjective, isCreating, provider]);

  return (
    <TooltipProvider>
      <div className={`flex-1 min-w-0 flex flex-col h-full relative overflow-hidden ${sidebarOpen ? 'hidden md:flex' : ''}`}>
      <div className="relative flex justify-between items-center gap-3 h-[52px] pl-4 pr-4 bg-bg">
        {/* Left: the sessions sidebar. On desktop the brand follows the
            toggle; on mobile it is centred on the viewport (below), the same
            arrangement as a conversation header. */}
        <div className="flex items-center gap-1 sm:gap-2.5 min-w-0">
          {!sidebarOpen && (
            <>
              <button
                type="button"
                onClick={onToggleSidebar}
                aria-label="Open sessions sidebar"
                className="flex sm:hidden items-center justify-center w-10 h-10 ui-icon-btn touch-manipulation"
              >
                <PanelLeft size={20} />
              </button>
              <button
                onClick={onToggleSidebar}
                aria-label="Open sessions sidebar"
                className="hidden sm:block p-1.5 ui-icon-btn"
              >
                <PanelLeft size={18} />
              </button>
              <span className="hidden sm:flex items-center gap-2" aria-label="Lattice">
                <LatticeLogo size={24} interactive={true} colorScheme="gradient" />
                <span className="wordmark text-[15px] text-white">lattice</span>
              </span>
            </>
          )}
          <span className="hidden sm:inline text-sm text-fg-2">{coordinator ? 'New project' : 'New session'}</span>
        </div>

        {/* Mobile brand: centred against the band, which spans the viewport
            here, so the controls on either side do not shift it. */}
        <span
          className="sm:hidden absolute left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-none"
          aria-label="Lattice"
        >
          <LatticeLogo size={22} interactive={false} colorScheme="gradient" />
          <span className="wordmark text-[15px] text-white">lattice</span>
        </span>

        <div className="flex-1 min-w-0" />

        <div className="flex items-center gap-2 flex-shrink-0">
          <HeaderNotesButton count={queueCount} onClick={() => setQueueOpen(true)} />
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            data-testid="new-session-settings"
            className="p-1.5 ui-icon-btn"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>

      {/* Empty area + composer at bottom */}
      <div className="flex-1 flex flex-col justify-end">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="flex flex-col items-center gap-2">
            <div className="flex flex-wrap items-center justify-center rounded-md border border-line bg-surface p-0.5">
              {NEW_SESSION_PROVIDERS.map((providerOption) => {
                const isActive = provider === providerOption && !endpoint;
                const Icon = PROVIDER_ICONS[providerOption];
                return (
                  <button
                    key={providerOption}
                    type="button"
                    data-testid={`provider-option-${providerOption}`}
                    onClick={() => _handleProviderChange(providerOption)}
                    disabled={isCreating}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs font-medium transition-colors duration-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                      isActive
                        ? 'bg-surface-2 text-fg'
                        : 'text-fg-3 hover:text-fg-2'
                    }`}
                  >
                    <Icon size={12} />
                    {PROVIDER_LABELS[providerOption]}
                  </button>
                );
              })}
              {claudeEndpoints.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-testid="provider-option-endpoint"
                  onClick={() => { _handleProviderChange('claude'); setEndpointModel(option.model); }}
                  disabled={isCreating}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs font-medium transition-colors duration-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                    endpoint?.id === option.id
                      ? 'bg-surface-2 text-fg'
                      : 'text-fg-3 hover:text-fg-2'
                  }`}
                >
                  <Server size={12} />
                  {option.model}
                </button>
              ))}
            </div>
            {coordinator && (
              <div className="px-4 text-center text-xs text-fg-3" data-testid="new-project-summary">
                Coordinator on {provider === 'codex'
                  ? CODEX_MODELS.find((m) => m.id === codexDefaultModel)?.label ?? codexDefaultModel
                  : formatClaudeModelLabel(effectiveDefaultModel)}
              </div>
            )}
            {!endpoint && <ProviderSignInStatus
              status={signIn}
              provider={provider === 'codex' ? 'codex' : 'claude'}
              onOpenProviders={() => setSettingsOpen(true)}
            />}
            </div>
          </div>
        </div>
        <div
          className="flex-shrink-0 bg-bg z-10 w-full flex flex-col items-center pt-3"
          style={{ paddingBottom: 'calc(var(--app-composer-dock-bottom-gap) + var(--app-safe-area-bottom))' }}
        >
          <div className="w-full max-w-3xl px-4">
            <Composer
              core={{
                onSubmit: handleSubmit,
                isLoading: isCreating,
                disabled: isCreating || (coordinator && preferencesLoading),
                placeholder: coordinator ? 'Describe the outcome you want' : 'Start a session',
              }}
              features={{
                enableAttachments: true,
                enableFileAutocomplete: true,
              }}
              provider={provider}
              permissionMode={permissionMode}
              workingDirectory={workingDirectory}
              renderStatusExtra={renderGoalStatus}
              renderActionsExtra={renderGoalAction}
              runtimeConfig={{
                isInitializing: isCreating,
                ...(coordinator
                  ? {}
                  : provider === 'claude'
                  ? {
                      availableModels: claudeAvailableModels,
                      selectedModel,
                      onModelChange: setSelectedModel,
                    }
                  : {
                      availableModels: codexAvailableModels,
                      selectedModel,
                      onModelChange: setSelectedModel,
                      availableEfforts: codexAvailableEfforts,
                      selectedEffort,
                      onEffortChange: setSelectedEffort,
                    }),
              }}
            />
          </div>
        </div>
      </div>
        <ActionQueueDialog
          isOpen={queueOpen}
          onClose={handleQueueClose}
          onLaunchSession={handleLaunchQueueSession}
          defaultProvider={'claude'}
          defaultPermissionMode={permissionMode}
          initialProvider={provider}
          initialPermissionMode={permissionMode}
        />
        <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </div>
    </TooltipProvider>
  );
}
