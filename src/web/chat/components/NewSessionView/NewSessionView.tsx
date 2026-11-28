/**
 * NewSessionView — Draft composer for creating new sessions.
 *
 * Renders a quiet Start screen: a Project/Session toggle (?coordinator=1), the
 * Composer ready to type, and the work left paused under it. On send, creates
 * the conversation via API and navigates to /c/{conversationId}.
 *
 * Provider and permission mode are read from URL search params
 * (set by the sidebar "New Session" button) or fall back to defaults.
 */

import type { PastedSpan } from '@liggi/agent-ui-harness/protocol';
import React, { type JSX, useState, useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Menu as MenuIcon, MoreHorizontal, PanelLeft, Search, Settings } from 'lucide-react';
import { DEFAULT_OPENCODE_MODEL_ID } from '@/constants/opencode-models.js';
import { ANTIGRAVITY_EFFORT_LABELS, ANTIGRAVITY_MODELS, DEFAULT_ANTIGRAVITY_PICKER_ID, antigravityModelEntry, antigravityModelId } from '@/constants/antigravity-models.js';


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
import { LatticeLogo } from '../shared/LatticeLogo';
import { runUndo, usePendingUndo } from '../ConversationHeader/pending-undo';
import { UndoButton } from '../ConversationHeader/UndoButton';
import { PlanUsageControl, PlanUsageMenuRow, usePlanUsageAlert } from '../ConversationHeader/PlanUsageControl';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { useCommandPalette } from '../CommandPalette/CommandPalette';
import { Contained } from '../ErrorBoundary';
import { useToast } from '../Toast/Toast';
import { TooltipProvider } from '../ui/tooltip';
import { SettingsDialog } from '../SettingsDialog/SettingsDialog';
import { planSignInWaiting } from '../SettingsDialog/ChatGPTPlanCard';
import { useProviderSignIn } from '../../hooks/useProviderSignIn';
import { useInklingStatus } from '../../hooks/useInklingStatus';
import { DEFAULT_INKLING_MODEL_ID, INKLING_MODELS } from '@/constants/inkling-models.js';
import { useClaudeModels } from '../../hooks/useClaudeModels';
import { ProviderSignInStatus } from './ProviderSignInStatus';
import { PausedList } from './PausedList';
import { startKindSearch } from './start-screen';
import { reportMilestone } from '../../utils/timeline-reporter';
import { CLAUDE_EFFORTS, DEFAULT_CLAUDE_EFFORT, effortsForClaudeModel, formatClaudeModelLabel } from '@/constants/claude-models';
import { endpointModelOption } from '@/constants/claude-endpoint';
import { ModelMark } from '../Composer/ModelMark';
import {
  CODEX_MODELS,
  CODEX_EFFORTS,
  DEFAULT_CODEX_MODEL_ID,
  DEFAULT_CODEX_EFFORT,
  effortsForCodexModel,
  formatCodexModelLabel,
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

function createPendingLaunchId(): string {
  return `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function NewSessionView({ sidebarOpen, onToggleSidebar }: NewSessionViewProps): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const pendingUndo = usePendingUndo();
  const pendingArchive = pendingUndo?.action === 'archive' ? pendingUndo : null;
  const { serverConfig, coordinatorConfig, claudeEndpoints, isLoading: preferencesLoading } = usePreferencesContext();
  const {
    addOptimisticSession,
    addPendingLaunch,
    removePendingLaunch,
    invalidateConversations,
  } = useConversations();
  const { data: signIn } = useProviderSignIn();
  const { data: inkling } = useInklingStatus();
  const claudeModels = useClaudeModels();
  const [settingsOpen, setSettingsOpen] = useState(planSignInWaiting);
  const [menuOpen, setMenuOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const usageAlert = usePlanUsageAlert();
  const palette = useCommandPalette();
  const workspaceId = 'main';

  const [isCreating, setIsCreating] = useState(false);
  // Read provider and permission mode from URL params or fall back to defaults
  const _paramProvider = searchParams.get('provider');
  const paramMode = searchParams.get('mode');

  // "New project" (?coordinator=1) starts a coordinator on any model a new
  // session can use, on the configured model unless one is picked; the server prepends the `front` preamble when the create
  // call says so.
  const coordinator = searchParams.get('coordinator') === '1';
  const coordinatorSettings = {
    coordinator: coordinatorConfig ?? undefined,
    server: serverConfig ?? undefined,
  };
  const searchParamProvider: Provider = _paramProvider === 'codex' ? 'codex'
    : _paramProvider === 'claude' ? 'claude'
    : _paramProvider === 'antigravity' ? 'antigravity'
    : _paramProvider === 'inkling' && !coordinator ? 'inkling'
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
  // A pick in the model picker sets its own model, so it skips this reset.
  const keepPickedModelRef = React.useRef(false);
  useEffect(() => {
    if (keepPickedModelRef.current) {
      keepPickedModelRef.current = false;
      return;
    }
    setSelectedModel(null);
    setSelectedEffort(null);
  }, [provider, endpointModel]);

  // A Claude session with no configured model runs on the Claude CLI's own
  // default, which only the CLI knows, so it is shown as that.
  const claudeDefaultModel = coordinator
    ? coordinatorClaudeModelFrom(coordinatorSettings) ?? CLAUDE_CLI_DEFAULT_MODEL
    : serverConfig?.defaultModel?.trim() || CLAUDE_CLI_DEFAULT_MODEL;
  const effectiveDefaultModel = endpoint ? endpoint.model : claudeDefaultModel;
  const coordinatorCodexDefaults = coordinatorCodexDefaultsFrom(coordinatorSettings);
  const codexDefaultModel = coordinator ? coordinatorCodexDefaults.model : DEFAULT_CODEX_MODEL_ID;
  const codexDefaultEffort = coordinator ? coordinatorCodexDefaults.reasoningEffort : DEFAULT_CODEX_EFFORT;

  // Reasoning-effort options depend on the selected model. If the current
  // effort choice isn't offered by the newly-selected model, reset it.
  useEffect(() => {
    if (selectedEffort === null) return;
    const efforts: readonly string[] = provider === 'antigravity'
      ? antigravityModelEntry(selectedModel ?? DEFAULT_ANTIGRAVITY_PICKER_ID)?.efforts ?? []
      : provider === 'codex'
        ? effortsForCodexModel(selectedModel ?? codexDefaultModel)
        : effortsForClaudeModel(selectedModel ?? claudeDefaultModel);
    if (!efforts.includes(selectedEffort)) {
      setSelectedEffort(null);
    }
  }, [provider, selectedModel, selectedEffort, codexDefaultModel, claudeDefaultModel]);

  const claudeAvailableModels = React.useMemo(() => {
    const claudeMark = <ModelMark kind="claude" />;
    const selectable: Array<{ id: string; label: string; description?: string; isDefault: boolean; other?: boolean; icon?: React.ReactNode; group?: string; efforts?: string[]; defaultEffort?: string }> =
      claudeModels.models.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        isDefault: m.id === claudeDefaultModel,
        other: m.other,
        icon: claudeMark,
        group: 'Claude',
        efforts: effortsForClaudeModel(m.id),
        defaultEffort: DEFAULT_CLAUDE_EFFORT,
      }));
    if (!selectable.some((m) => m.id === claudeDefaultModel)) {
      const cliDefaultLabel = claudeModels.cliDefaultModel
        ? claudeModels.models.find((m) => m.id === claudeModels.cliDefaultModel)?.label ?? claudeModels.cliDefaultModel
        : null;
      selectable.unshift({
        id: claudeDefaultModel,
        label: claudeDefaultModel === CLAUDE_CLI_DEFAULT_MODEL
          ? 'Claude Code default'
          : formatClaudeModelLabel(claudeDefaultModel),
        ...(claudeDefaultModel === CLAUDE_CLI_DEFAULT_MODEL
          ? { description: cliDefaultLabel
            ? `Runs ${cliDefaultLabel} for your account`
            : "Runs your Claude CLI's default" }
          : {}),
        isDefault: true,
        icon: claudeMark,
        group: 'Claude',
        efforts: effortsForClaudeModel(claudeDefaultModel),
        defaultEffort: DEFAULT_CLAUDE_EFFORT,
      });
    }
    return selectable;
  }, [claudeDefaultModel, claudeModels]);

  const codexAvailableModels = React.useMemo(() => {
    const openaiMark = <ModelMark kind="openai" />;
    const selectable: Array<{ id: string; label: string; description?: string; isDefault: boolean; other?: boolean; icon?: React.ReactNode; group?: string; efforts?: string[]; defaultEffort?: string }> =
      CODEX_MODELS.filter((m) => m.composerSelectable).map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        isDefault: m.id === codexDefaultModel,
        other: m.other,
        icon: openaiMark,
        group: 'OpenAI',
        efforts: m.efforts,
        defaultEffort: m.efforts.includes(codexDefaultEffort) ? codexDefaultEffort : m.efforts[m.efforts.length - 1],
      }));
    if (!selectable.some((m) => m.id === codexDefaultModel)) {
      const fallbackEfforts = effortsForCodexModel(codexDefaultModel);
      selectable.push({
        id: codexDefaultModel,
        label: formatCodexModelLabel(codexDefaultModel),
        isDefault: true,
        icon: openaiMark,
        group: 'OpenAI',
        efforts: fallbackEfforts,
        defaultEffort: codexDefaultEffort,
      });
    }
    return selectable;
  }, [codexDefaultModel, codexDefaultEffort]);

  // One picker for every model a new session can start on: Claude, OpenAI,
  // Google and the saved endpoints, each under its own mark. A new project
  // offers the same list, with its configured coordinator models as defaults.
  const pickerModels = React.useMemo(() => {
    const endpointMark = <ModelMark kind="endpoint" />;
    const antigravityMark = <ModelMark kind="antigravity" />;
    const inklingMark = <ModelMark kind="inkling" />;
    // Inkling is a local model for sessions, offered when its CLI is installed; a project's coordinator needs more.
    return [
      ...claudeAvailableModels,
      ...codexAvailableModels,
      ...ANTIGRAVITY_MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        isDefault: m.id === DEFAULT_ANTIGRAVITY_PICKER_ID,
        icon: antigravityMark,
        group: 'Google',
        efforts: m.efforts,
        defaultEffort: m.defaultEffort,
      })),
      ...(inkling?.installed && !coordinator ? INKLING_MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        description: inkling.serverReachable ? m.description : `Its model server at ${inkling.baseUrl} is not answering`,
        isDefault: false,
        icon: inklingMark,
        group: 'Local',
      })) : []),
      ...claudeEndpoints.map((option) => ({ ...endpointModelOption(option, false), icon: endpointMark, group: 'Your endpoints' })),
    ];
  }, [claudeAvailableModels, codexAvailableModels, claudeEndpoints, inkling, coordinator]);
  const pickerSelectedModel = endpoint
    ? endpoint.model
    : provider === 'codex' ? selectedModel ?? codexDefaultModel
    : provider === 'antigravity' ? antigravityModelEntry(selectedModel)?.id ?? DEFAULT_ANTIGRAVITY_PICKER_ID
    : provider === 'inkling' ? DEFAULT_INKLING_MODEL_ID
    : selectedModel ?? claudeDefaultModel;

  // Full effort columns per provider group so the 2D pad shows each model's
  // supported subset along one shared horizontal effort axis.
  const availableEffortsByGroup = React.useMemo(() => ({
    Claude: CLAUDE_EFFORTS,
    OpenAI: CODEX_EFFORTS.map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
      isDefault: e.id === codexDefaultEffort,
    })),
    Google: (['low', 'medium', 'high', 'xhigh'] as const).map((effortId) => ({
      id: effortId,
      label: ANTIGRAVITY_EFFORT_LABELS[effortId] ?? effortId,
      isDefault: effortId === 'high',
    })),
  }), [codexDefaultEffort]);

  const permissionMode = resolveInitialLaunchPermissionMode({
    explicit: paramMode ?? undefined,
    fallback: serverConfig?.defaultPermissionMode,
    provider: searchParamProvider,
  });

  // Not the server's own cwd: on a source install that is Lattice's checkout.
  // Every session launches from the one folder set in Settings; the agents
  // find the repos under it that the work involves.
  const workingDirectory = serverConfig?.defaultWorkingDirectory?.trim() || '~';

  const _handleProviderChange = useCallback((nextProvider: Provider) => {
    setProvider(nextProvider);
    setEndpointModel(null);

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set('provider', nextProvider);
    setSearchParams(nextSearchParams, { replace: true });
  }, [searchParams, setSearchParams]);


  // Project and Session are the same screen; the toggle flips ?coordinator=1
  // and lets the new kind pick its own default provider.
  const setStartKind = useCallback((kind: 'project' | 'session') => {
    if ((kind === 'project') === coordinator) return;
    setEndpointModel(null);
    setSearchParams(startKindSearch(searchParams, kind), { replace: true });
  }, [coordinator, searchParams, setSearchParams]);

  const handlePickModel = useCallback((model: string | null, optionId?: string) => {
    const option = pickerModels.find((candidate) => candidate.id === optionId);
    if (!option) return;
    if (option.group === 'Your endpoints') {
      if (provider !== 'claude') _handleProviderChange('claude');
      setEndpointModel(option.id);
      return;
    }
    const nextProvider: Provider = option.group === 'OpenAI' ? 'codex'
      : option.group === 'Google' ? 'antigravity'
      : option.group === 'Local' ? 'inkling'
      : 'claude';
    const providerChanged = nextProvider !== provider;
    if (providerChanged || endpoint) {
      keepPickedModelRef.current = true;
      _handleProviderChange(nextProvider);
    }
    setSelectedModel(model);
    if (providerChanged) {
      setSelectedEffort(null);
    }
  }, [pickerModels, provider, endpoint, _handleProviderChange]);

  const handlePickEffort = useCallback((effort: string | null, group?: string) => {
    if (group === 'Claude' && (provider !== 'claude' || endpoint)) {
      keepPickedModelRef.current = true;
      _handleProviderChange('claude');
      setSelectedModel(null);
      setSelectedEffort(effort);
      return;
    }
    if (group === 'OpenAI' && (provider !== 'codex' || endpoint)) {
      keepPickedModelRef.current = true;
      _handleProviderChange('codex');
      setSelectedModel(null);
      setSelectedEffort(effort);
      return;
    }
    if (group === 'Google' && (provider !== 'antigravity' || endpoint)) {
      keepPickedModelRef.current = true;
      _handleProviderChange('antigravity');
      setSelectedModel(null);
      setSelectedEffort(effort);
      return;
    }
    setSelectedEffort(effort);
  }, [provider, endpoint, _handleProviderChange]);

  const handlePickModelAndEffort = useCallback(
    (model: string | null, effort: string | null, meta: { optionId: string; group?: string }) => {
      const option = pickerModels.find((candidate) => candidate.id === meta.optionId);
      if (!option) return;
      if (option.group === 'Your endpoints') {
        if (provider !== 'claude') _handleProviderChange('claude');
        setEndpointModel(option.id);
        setSelectedEffort(null);
        return;
      }
      const nextProvider: Provider = option.group === 'OpenAI' ? 'codex'
        : option.group === 'Google' ? 'antigravity'
        : 'claude';
      if (nextProvider !== provider || endpoint) {
        keepPickedModelRef.current = true;
        _handleProviderChange(nextProvider);
      }
      setSelectedModel(model);
      setSelectedEffort(effort);
    },
    [pickerModels, provider, endpoint, _handleProviderChange],
  );

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
        : targetProvider === 'antigravity'
          ? DEFAULT_ANTIGRAVITY_PICKER_ID
          : targetProvider === 'inkling'
            ? DEFAULT_INKLING_MODEL_ID
            : effectiveDefaultModel;
    // Antigravity names the model and its thinking level in one id.
    const fallbackModel = targetProvider === 'antigravity'
      ? antigravityModelId(model || providerFallbackModel, effort)
      : model || providerFallbackModel;
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
          : requestProvider === 'claude' && !endpoint && effort && effort !== DEFAULT_CLAUDE_EFFORT
            ? { reasoningEffort: effort }
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
    endpoint,
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

  const phoneMenuItem = 'flex items-center gap-3 w-full px-3 py-2 rounded-sm text-sm text-fg-2 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer';

  return (
    <TooltipProvider>
      <div className={`flex-1 min-w-0 flex flex-col h-full relative overflow-hidden ${sidebarOpen ? 'hidden md:flex' : ''}`}>
      {/* Phone: the same quiet band as a conversation — sidebar, title, Search,
          and a menu holding usage and Settings. */}
      <div className="sm:hidden flex items-center gap-1 h-[52px] px-1.5 bg-bg border-b border-line flex-shrink-0">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Open sessions sidebar"
          className="flex items-center justify-center w-10 h-10 ui-icon-btn touch-manipulation"
        >
          <MenuIcon size={20} />
        </button>
        <h1 data-testid="new-session-title" className="min-w-0 flex-1 truncate text-[14.5px] font-medium leading-[1.25] text-fg">New</h1>
        {pendingArchive && (
          <UndoButton
            pending={pendingArchive}
            onUndo={() => runUndo(() => showToast({ title: 'Could not undo archive', type: 'error' }))}
            variant="icon"
          />
        )}
        <button
          type="button"
          onClick={palette.open}
          aria-label="Search"
          className="flex items-center justify-center w-10 h-10 ui-icon-btn touch-manipulation"
        >
          <Search size={19} />
        </button>
        <Popover open={menuOpen} onOpenChange={(next) => { setMenuOpen(next); if (!next) setUsageOpen(false); }}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={usageAlert ? `More, usage ${usageAlert === 'rose' ? 'used up or nearly' : 'runs out before the reset'}` : 'More'}
              className={`relative flex items-center justify-center w-10 h-10 ui-icon-btn touch-manipulation ${menuOpen ? 'text-fg bg-surface' : ''}`}
            >
              <MoreHorizontal className="size-5" />
              {usageAlert && (
                <span
                  data-testid="usage-alert-dot"
                  aria-hidden
                  className={`absolute right-2 top-2 size-2 rounded-full ring-2 ring-bg ${usageAlert === 'rose' ? 'bg-rose-400' : 'bg-amber-400'}`}
                />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            className="w-64 max-w-[calc(100vw-24px)] p-1.5 bg-surface border border-line rounded-lg shadow-none z-[100]"
          >
            <div className="flex flex-col gap-px">
              <Contained name="PlanUsage"><PlanUsageMenuRow open={usageOpen} onToggle={() => setUsageOpen((v) => !v)} className={`${phoneMenuItem} py-0`} /></Contained>
              <div className="border-t border-line my-1" />
              <button
                type="button"
                onClick={() => { setSettingsOpen(true); setMenuOpen(false); }}
                data-testid="new-session-settings-phone"
                className={phoneMenuItem}
              >
                <Settings size={16} />
                <span>Settings</span>
              </button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Desktop: sidebar toggle and brand on the left, usage and Settings on the right. */}
      <div className="hidden sm:flex relative justify-between items-center gap-3 h-[52px] pl-4 pr-4 bg-bg">
        <div className="flex items-center gap-2.5 min-w-0">
          {!sidebarOpen && (
            <>
              <button
                onClick={onToggleSidebar}
                aria-label="Open sessions sidebar"
                className="p-1.5 ui-icon-btn"
              >
                <PanelLeft size={18} />
              </button>
              <span className="flex items-center gap-2" aria-label="Lattice">
                <LatticeLogo size={24} interactive={true} colorScheme="gradient" />
                <span className="wordmark text-[15px] text-white">lattice</span>
              </span>
            </>
          )}
        </div>

        <div className="flex-1 min-w-0" />

        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Archiving the last open session lands here, so its Undo does too. */}
          {pendingArchive && (
            <UndoButton
              pending={pendingArchive}
              onUndo={() => runUndo(() => showToast({ title: 'Could not undo archive', type: 'error' }))}
              variant="icon"
            />
          )}
          <Contained name="PlanUsage"><PlanUsageControl /></Contained>
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

      {/* A quiet start: Project or Session, the composer, and what was left
          paused. On a phone the composer sits at the bottom, in thumb reach,
          and Paused scrolls above it; on desktop all three stack, centred. */}
      <div className="flex-1 min-h-0 flex justify-center md:overflow-y-auto">
        <div className="flex w-full max-w-[640px] min-h-0 flex-col px-4 pt-4 md:self-start md:pt-[18vh] md:pb-10">
          <div className="mb-3 flex shrink-0 justify-center">
            <div className="flex gap-0.5 rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Start a project or a session">
              {(['project', 'session'] as const).map((kind) => {
                const on = (kind === 'project') === coordinator;
                return (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-testid={`start-${kind}`}
                    onClick={() => setStartKind(kind)}
                    className={`h-10 md:h-7 rounded-md px-4 md:px-3 text-[13px] touch-manipulation transition-colors ${on ? 'bg-surface-2 text-fg' : 'text-fg-3 hover:text-fg-2'}`}
                  >
                    {kind === 'project' ? 'Project' : 'Session'}
                  </button>
                );
              })}
            </div>
          </div>
          {!endpoint && provider !== 'antigravity' && provider !== 'inkling' && (
            <div className="mb-3 flex shrink-0 justify-center empty:hidden">
              <ProviderSignInStatus
                status={signIn}
                provider={provider === 'codex' ? 'codex' : 'claude'}
                onOpenProviders={() => setSettingsOpen(true)}
              />
            </div>
          )}
          <div
            data-testid="new-session-composer"
            className="order-last shrink-0 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] md:order-none md:p-0"
          >
          <div className="rounded-[10px] shadow-[0_16px_60px_rgba(0,0,0,0.35)]">
            <Composer
              core={{
                onSubmit: handleSubmit,
                isLoading: isCreating,
                disabled: isCreating || (coordinator && preferencesLoading),
                placeholder: coordinator ? 'What are we working on?' : 'Start a session',
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
                availableModels: pickerModels,
                modelMenuLayout: 'rail',
                modelMenuNote: claudeModels.note,
                selectedModel: pickerSelectedModel,
                onModelChange: handlePickModel,
                onModelAndEffortChange: handlePickModelAndEffort,
                availableEffortsByGroup,
                selectedEffort,
                onEffortChange: handlePickEffort,
              }}
            />
          </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain md:flex-none md:overflow-visible">
            <PausedList kind={coordinator ? 'project' : 'session'} />
          </div>
        </div>
      </div>
        <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </div>
    </TooltipProvider>
  );
}
