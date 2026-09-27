import type { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { RequestWithRequestId } from '@/types/express.js';
import {
  LatticeError,
  PERMISSION_MODES,
  asStreamingId,
  type SessionInfo,
  type SessionInsights,
  type SessionUpdateRequest,
} from '@/types/index.js';
import type { ActiveConversationRegistry } from '@/services/process/active-conversation-registry.js';
import type { SessionInfoService } from '@/services/sessions/session-info-service.js';
import type { ConversationService, Provider } from '@/services/sessions/conversation-service.js';
import type { ClaudeHistoryReader } from '@/services/sessions/claude-history-reader.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- future use
import { buildUnifiedUserContent } from '@/services/sessions/unified-user-content.js';
import type { UnifiedContentBlock } from '@/types/unified-messages.js';
import { SessionBranchService } from '@/services/sessions/session-branch-service.js';
import { TurnRepository } from '@/services/sessions/turn-repository.js';
import { SessionAnalysisService } from '@/services/sessions/session-analysis-service.js';
import { pinnedCharacterService } from '@/services/sessions/pinned-character-service.js';
import type { InsightsEngine } from '@/services/insights/insights-engine.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { getEventJournal } from '@/services/infrastructure/event-journal.js';
import { getHarnessSessionManager } from '@/harness/setup.js';
import { appendCustomHarnessEvent } from '@/harness/harness-custom-events.js';
import { getCodexAppServerClient } from '@/services/process/codex-app-server-client.js';
import type { CodexGoalStatus } from '@/services/process/codex-app-server-types.js';

const logger = createLogger('UnifiedConversationControlRoutes');
const CODEX_GOAL_STATUSES: CodexGoalStatus[] = ['active', 'paused', 'budgetLimited', 'complete'];

interface StopInFlightMessagePayload {
  id?: unknown;
  timestamp?: unknown;
  content?: unknown;
}

function normalizeInFlightToolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const textParts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    }
  }
  return textParts.join('\n');
}

function normalizeInFlightContentBlocks(rawContent: unknown): UnifiedContentBlock[] {
  if (!Array.isArray(rawContent)) return [];

  const normalized: UnifiedContentBlock[] = [];

  for (const rawBlock of rawContent) {
    if (!rawBlock || typeof rawBlock !== 'object') continue;
    const block = rawBlock as Record<string, unknown>;
    const type = block.type;

    if (type === 'text') {
      if (typeof block.text !== 'string' || block.text.length === 0) continue;
      normalized.push({ type: 'text', text: block.text });
      continue;
    }

    if (type === 'thinking') {
      const thinkingText = typeof block.thinking === 'string'
        ? block.thinking
        : typeof block.text === 'string'
          ? block.text
          : '';
      if (thinkingText.length === 0) continue;
      normalized.push({ type: 'thinking', text: thinkingText });
      continue;
    }

    if (type === 'tool_use') {
      if (
        typeof block.id !== 'string'
        || block.id.length === 0
        || typeof block.name !== 'string'
        || block.name.length === 0
        || !block.input
        || typeof block.input !== 'object'
        || Array.isArray(block.input)
      ) {
        continue;
      }
      normalized.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
      continue;
    }

    if (type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || block.tool_use_id.length === 0) continue;
      normalized.push({
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        output: normalizeInFlightToolResultOutput(block.content),
        isError: block.is_error === true,
      });
    }
  }

  return normalized;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- future use
function normalizeInFlightAssistantMessage(
  rawMessage: unknown
): { id: string; timestamp: string; content: UnifiedContentBlock[] } | null {
  if (!rawMessage || typeof rawMessage !== 'object') return null;
  const message = rawMessage as StopInFlightMessagePayload;

  const id = typeof message.id === 'string' && message.id.trim().length > 0
    ? message.id
    : null;
  if (!id) return null;

  const content = normalizeInFlightContentBlocks(message.content);
  if (content.length === 0) return null;

  const timestamp = typeof message.timestamp === 'string' && message.timestamp.trim().length > 0
    ? message.timestamp
    : new Date().toISOString();

  return { id, timestamp, content };
}

/**
 * Attempt to terminate a conversation's harness process. On failure, cleans up
 * the stale registry entry so the system doesn't think the session is still active.
 */
async function terminateProcess(
  conversationId: string,
  streamingId: string,
  registry: ActiveConversationRegistry,
): Promise<boolean> {
  const harnessManager = getHarnessSessionManager();
  if (!harnessManager) return false;

  try {
    await harnessManager.stop(conversationId);
    return true;
  } catch {
    registry.deregisterByStreamingId(asStreamingId(streamingId));
    logger.warn('[CONV] Stop requested for stale session; cleared active mapping', {
      conversationId,
      streamingId,
    });
    return false;
  }
}

export interface UnifiedConversationControlRoutesContext {
  activeConversationRegistry: ActiveConversationRegistry;
  sessionInfoService: SessionInfoService;
  historyReader: ClaudeHistoryReader;
  insightsEngine: InsightsEngine;
  resolveActiveStreamingId: (conversationId: string) => {
    streamingId: string;
    provider: Provider;
  } | null;
  resolveProviderSessionId: (conversationId: string) => string;
  resolveTranscriptSessionId: (conversationId: string) => string;
  conversationService: ConversationService;
}

export function registerUnifiedConversationControlRoutes(
  router: Router,
  context: UnifiedConversationControlRoutesContext
): void {
  const {
    activeConversationRegistry,
    sessionInfoService,
    historyReader,
    insightsEngine,
    resolveActiveStreamingId,
    resolveProviderSessionId,
    resolveTranscriptSessionId,
    conversationService,
  } = context;

  function resolveCodexThread(conversationId: string): {
    threadId: string;
    cwd: string;
    workspace: string;
  } {
    const conversation = conversationService.getConversation(conversationId);
    if (!conversation) {
      throw new LatticeError('CONVERSATION_NOT_FOUND', `Conversation ${conversationId} not found`, 404);
    }

    const latestSegment = conversationService.getLatestSegment(conversationId);
    const registryEntry = activeConversationRegistry.get(conversationId);
    const threadId = registryEntry?.segment.providerSessionId ?? latestSegment?.providerSessionId;

    if (latestSegment?.provider !== 'codex' && registryEntry?.segment.provider !== 'codex') {
      throw new LatticeError('NOT_CODEX_CONVERSATION', 'Goal controls are only available for Codex conversations', 400);
    }
    if (!threadId || threadId.startsWith('pending-') || threadId === conversationId) {
      throw new LatticeError('CODEX_THREAD_NOT_READY', 'Codex thread is not ready yet', 409);
    }

    return {
      threadId,
      cwd: conversation.workingDirectory,
      workspace: conversation.workspace || conversation.workingDirectory,
    };
  }

  function appendGoalEvent(conversationId: string, type: 'goal:updated' | 'goal:cleared', data: unknown): void {
    const manager = getHarnessSessionManager();
    if (!manager) return;
    appendCustomHarnessEvent(manager, conversationId, type, data);
  }

  function validateGoalStatus(value: unknown): CodexGoalStatus | undefined {
    if (typeof value !== 'string') return undefined;
    return (CODEX_GOAL_STATUSES as string[]).includes(value) ? value as CodexGoalStatus : undefined;
  }

  // ==========================================================================
  // /goal lifecycle — Codex app-server thread/goal/{get,set,clear}
  // ==========================================================================
  router.get('/:conversationId/goal', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }

    // Reading the goal of a thread that doesn't exist yet has a truthful
    // answer: there is no goal. The 409 stays on the mutating routes (you
    // can't SET a goal before the thread exists), but here it only produced
    // noise — the client queries on every Codex conversation open, and an
    // idle conversation whose thread hasn't started answered 409 four times
    // (React Query retries) per open.
    let resolved: ReturnType<typeof resolveCodexThread>;
    try {
      resolved = resolveCodexThread(conversationId);
    } catch (error) {
      if (error instanceof LatticeError && error.code === 'CODEX_THREAD_NOT_READY') {
        res.json({ goal: null });
        return;
      }
      throw error;
    }
    const client = getCodexAppServerClient(resolved.workspace, resolved.cwd);
    const result = await client.getGoal(resolved.threadId);
    res.json(result);
  }));

  router.put('/:conversationId/goal', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }

    const body = req.body as {
      objective?: unknown;
      status?: unknown;
      tokenBudget?: unknown;
    };
    const objective = typeof body.objective === 'string' ? body.objective.trim() : undefined;
    const status = validateGoalStatus(body.status);
    const tokenBudget = typeof body.tokenBudget === 'number' && Number.isFinite(body.tokenBudget)
      ? body.tokenBudget
      : body.tokenBudget === null
        ? null
        : undefined;

    if (body.status !== undefined && !status) {
      res.status(400).json({ error: 'invalid_goal_status', supportedStatuses: CODEX_GOAL_STATUSES });
      return;
    }
    if (!objective && status === undefined && tokenBudget === undefined) {
      res.status(400).json({ error: 'empty_goal_update' });
      return;
    }

    const resolved = resolveCodexThread(conversationId);
    const client = getCodexAppServerClient(resolved.workspace, resolved.cwd);
    const result = await client.setGoal({
      threadId: resolved.threadId,
      ...(objective ? { objective } : {}),
      ...(status ? { status } : {}),
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    });
    appendGoalEvent(conversationId, 'goal:updated', { goal: result.goal });
    res.json(result);
  }));

  router.post('/:conversationId/goal/pause', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    const resolved = resolveCodexThread(conversationId);
    const client = getCodexAppServerClient(resolved.workspace, resolved.cwd);
    const result = await client.setGoal({ threadId: resolved.threadId, status: 'paused' });
    appendGoalEvent(conversationId, 'goal:updated', { goal: result.goal });
    res.json(result);
  }));

  router.post('/:conversationId/goal/resume', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    const resolved = resolveCodexThread(conversationId);
    const client = getCodexAppServerClient(resolved.workspace, resolved.cwd);
    const result = await client.setGoal({ threadId: resolved.threadId, status: 'active' });
    appendGoalEvent(conversationId, 'goal:updated', { goal: result.goal });
    res.json(result);
  }));

  router.delete('/:conversationId/goal', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    const resolved = resolveCodexThread(conversationId);
    const client = getCodexAppServerClient(resolved.workspace, resolved.cwd);
    const result = await client.clearGoal(resolved.threadId);
    appendGoalEvent(conversationId, 'goal:cleared', { threadId: resolved.threadId });
    res.json(result);
  }));

  // ==========================================================================
  // POST /:conversationId/force-kill — Immediate SIGKILL
  // The frontend's stop sequence escalates to this after the harness-level
  // stop fails to terminate the turn.
  // ==========================================================================
  router.post('/:conversationId/force-kill', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;

    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }

    const active = resolveActiveStreamingId(conversationId);
    if (!active) {
      res.json({ success: false, error: 'No active process found for conversation' });
      return;
    }

    logger.info('[CONV] Force kill conversation', {
      conversationId,
      streamingId: active.streamingId,
      provider: active.provider,
    });

    const success = await terminateProcess(conversationId, active.streamingId, activeConversationRegistry);
    res.json({ success });
  }));

  // ==========================================================================
  // PUT /:conversationId/update — Update metadata (name, archived, pinned, etc.)
  // ==========================================================================
  router.put('/:conversationId/update', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    const updates = req.body as SessionUpdateRequest;

    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }

    if (updates.customName !== undefined && updates.customName.length > 200) {
      res.status(400).json({
        success: false,
        sessionId: conversationId,
        updatedFields: {} as SessionInfo,
        error: 'Custom name must be 200 characters or less',
      });
      return;
    }

    const sessionUpdates: Partial<SessionInfo> = {};
    if (updates.customName !== undefined) sessionUpdates.custom_name = updates.customName.trim();
    if (updates.pinned !== undefined) sessionUpdates.pinned = updates.pinned;
    if (updates.archived !== undefined) sessionUpdates.archived = updates.archived;
    if (updates.continuationSessionId !== undefined) sessionUpdates.continuation_session_id = updates.continuationSessionId;
    if (updates.initialCommitHead !== undefined) sessionUpdates.initial_commit_head = updates.initialCommitHead;
    if (updates.permissionMode !== undefined) {
      if (!PERMISSION_MODES.includes(updates.permissionMode as typeof PERMISSION_MODES[number])) {
        res.status(400).json({
          success: false,
          sessionId: conversationId,
          updatedFields: {} as SessionInfo,
          error: `Permission mode must be one of: ${PERMISSION_MODES.join(', ')}`,
        });
        return;
      }
      sessionUpdates.permission_mode = updates.permissionMode;
    }
    if (updates.pausedReason !== undefined) {
      sessionUpdates.paused_reason = updates.pausedReason || '';
    }

    let existingInfo = sessionInfoService.getSessionInfoSync(conversationId);
    const isMissingPinnedCharacter = updates.pinned === true
      && !(existingInfo?.pin_character_name && existingInfo.pin_character_image);
    const shouldCreatePinnedCharacter = isMissingPinnedCharacter
      && pinnedCharacterService.isAvailable();

    let updatedFields: SessionInfo;
    if (shouldCreatePinnedCharacter) {
      const conversation = conversationService.getConversation(conversationId);
      if (!conversation) {
        throw new LatticeError(
          'CONVERSATION_NOT_FOUND',
          `Conversation ${conversationId} not found`,
          404
        );
      }

      // Very old conversations can predate their canonical session-info row.
      // Establish the row while leaving it unpinned so a failed model call does
      // not produce a successful-looking partial pin.
      if (!existingInfo) {
        existingInfo = await sessionInfoService.updateSessionInfo(conversationId, {});
      }

      const cachedInsights = await insightsEngine
        .getCachedInsightsForSessions([conversationId])
        .catch((error) => {
          logger.debug('[CONV] Character generation has no cached insights', {
            conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
          return new Map<string, SessionInsights>();
        });
      const insights = cachedInsights.get(conversationId);
      const character = await pinnedCharacterService.generate(
        conversationId,
        {
          mission: existingInfo.custom_name || insights?.context?.mission,
          currentAim: insights?.purpose,
          initialPrompt: conversation.initialPrompt,
          project: insights?.context?.project,
          workingDirectory: conversation.workingDirectory,
          theme: insights?.theme,
        },
        sessionInfoService.getPinnedCharacterNames(),
      );

      updatedFields = await sessionInfoService.attachPinnedCharacterAndPin(
        conversationId,
        character,
      );

      // Apply any metadata sent alongside the pin after the character+pin
      // transaction; the normal update statement deliberately leaves the
      // character columns untouched.
      const remainingUpdates = { ...sessionUpdates };
      delete remainingUpdates.pinned;
      if (Object.keys(remainingUpdates).length > 0) {
        updatedFields = await sessionInfoService.updateSessionInfo(conversationId, remainingUpdates);
      }
    } else {
      updatedFields = await sessionInfoService.updateSessionInfo(conversationId, sessionUpdates);
    }

    const providerSessionId = resolveProviderSessionId(conversationId);
    if (providerSessionId !== conversationId) {
      await sessionInfoService.updateSessionInfo(providerSessionId, sessionUpdates).catch((err) => {
        logger.warn('[CONV] Failed to propagate update to provider session', {
          conversationId,
          providerSessionId: providerSessionId.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    let analysisEligibility: { eligible: boolean; reason?: string } | undefined;
    if (updates.archived === true) {
      getEventJournal().record({
        event: 'session.archived',
        component: 'UnifiedConversationControlRoutes',
        sessionId: conversationId,
        requestId: req.requestId,
      });
      try {
        const analysisService = SessionAnalysisService.getInstance();
        await analysisService.initialize();
        analysisEligibility = await analysisService.isEligible(conversationId);
      } catch (error) {
        logger.debug('[CONV] Failed to check analysis eligibility', {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

    }

    logger.info('[CONV] Conversation updated', {
      conversationId,
      updatedFields: Object.keys(updatedFields),
      pinCharacterCreated: shouldCreatePinnedCharacter,
    });

    res.json({
      success: true,
      sessionId: conversationId,
      updatedFields,
      ...(updates.pinned === true && {
        pinCharacterStatus: shouldCreatePinnedCharacter
          ? 'created'
          : updatedFields.pin_character_name && updatedFields.pin_character_image
            ? 'existing'
            : 'gemini_not_configured',
      }),
      ...(analysisEligibility && { analysisEligibility }),
    });
  }));

  // ==========================================================================
  // POST /:conversationId/branch — Create branch from a specific turn
  // ==========================================================================
  router.post('/:conversationId/branch', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    const { afterTurn, timestamp } = req.body as { afterTurn: number; timestamp?: string };

    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }

    if (typeof afterTurn !== 'number' || afterTurn < 1) {
      throw new LatticeError('INVALID_TURN_NUMBER', 'afterTurn must be a positive integer', 400);
    }

    const parentConversation = conversationService.getConversation(conversationId);
    if (!parentConversation) {
      throw new LatticeError(
        'CONVERSATION_NOT_FOUND',
        `Parent conversation ${conversationId} not found`,
        500,
      );
    }

    const parentLatestSegment = conversationService.getLatestSegment(conversationId);
    if (parentLatestSegment?.provider === 'codex') {
      throw new LatticeError(
        'CODEX_BRANCH_UNSUPPORTED',
        'Branching Codex conversations is not supported yet',
        400,
      );
    }

    const providerSessionId = resolveProviderSessionId(conversationId);

    logger.info('[CONV] Branch conversation', {
      conversationId,
      providerSessionId: providerSessionId.slice(0, 8),
      afterTurn,
      timestamp,
    });

    const branchService = SessionBranchService.getInstance();
    const result = await branchService.branchAfterTurn(providerSessionId, afterTurn, timestamp);

    // Eagerly create a conv-* record for the branch, mirroring the /create pattern.
    // This avoids the fragile lazy-adoption path which can fail with 409 if
    // workingDirectory can't be resolved from the JSONL.
    const { conversationId: newConvId } = conversationService.createConversation({
      workingDirectory: parentConversation.workingDirectory,
      provider: 'claude',
      providerSessionId: result.newSessionId,
      workspace: parentConversation.workspace,
    });

    // Prime session_info for the new conv-* with branch lineage
    await sessionInfoService.updateSessionInfo(newConvId, {
      archived: false,
      workspace: parentConversation.workspace,
      branched_from_session_id: conversationId,
      branched_at_turn: afterTurn,
    });

    // Link the raw UUID back to the new conv-* and set canonical branch lineage
    await sessionInfoService.updateSessionInfo(result.newSessionId, {
      conversation_id: newConvId,
      branched_from_session_id: conversationId,
    });

    logger.info('[CONV] Eagerly created conv-* for branch session', {
      parentConversationId: conversationId.slice(0, 8),
      newConvId,
      newSessionId: result.newSessionId.slice(0, 8),
      afterTurn,
    });

    // Copy canonical turn history to both the raw UUID and the new conv-*
    if (conversationId !== providerSessionId) {
      try {
        const turnRepository = TurnRepository.getInstance();
        {
          const [branchRawTurnCount, canonicalParentTurnCount] = await Promise.all([
            turnRepository.getCount(result.newSessionId),
            turnRepository.getCount(conversationId),
          ]);

          if (canonicalParentTurnCount > 0) {
            // Copy to raw UUID if branch service didn't already
            if (branchRawTurnCount === 0) {
              sessionInfoService.copyTurnsForBranch(conversationId, result.newSessionId, afterTurn);
            }
            // Always copy to new conv-* (just created, always empty)
            sessionInfoService.copyTurnsForBranch(conversationId, newConvId, afterTurn);

            logger.info('[CONV] Copied canonical turn history for branch session', {
              parentConversationId: conversationId.slice(0, 8),
              newSessionId: result.newSessionId.slice(0, 8),
              newConvId,
              afterTurn,
              copiedToRaw: branchRawTurnCount === 0,
            });
          }
        }
      } catch (error) {
        logger.warn('[CONV] Failed canonical turn/mark copy during branch', {
          parentConversationId: conversationId.slice(0, 8),
          newSessionId: result.newSessionId.slice(0, 8),
          newConvId,
          afterTurn,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    res.json({
      success: true,
      conversationId: newConvId,
      newSessionId: result.newSessionId,
      turnCount: result.turnCount,
      messageCount: result.messageCount,
    });
  }));

  // ==========================================================================
  // GET /:conversationId/insights — Get session insights
  // ==========================================================================
  router.get('/:conversationId/insights', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    const quick = String(req.query.quick) === 'true';

    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }

    const providerSessionId = resolveProviderSessionId(conversationId);
    const targetSessionId = providerSessionId !== conversationId ? providerSessionId : conversationId;

    const insights = quick
      ? await insightsEngine.getInsightsQuick(targetSessionId)
      : await insightsEngine.getInsights(targetSessionId);

    logger.debug('[CONV] Insights retrieved', {
      conversationId,
      targetSessionId: targetSessionId.slice(0, 8),
      hasMission: !!insights.context?.mission,
      theme: insights.theme,
    });

    res.json(insights);
  }));

  // ==========================================================================
  // POST /:conversationId/insights/refresh — Force refresh insights
  // ==========================================================================
  router.post('/:conversationId/insights/refresh', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;

    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }

    const providerSessionId = resolveProviderSessionId(conversationId);
    const sourceSessionId = providerSessionId !== conversationId ? providerSessionId : conversationId;

    logger.info('[CONV] Refresh insights', {
      conversationId,
      sourceSessionId: sourceSessionId.slice(0, 8),
    });

    const insights = await insightsEngine.computeInsights(sourceSessionId);

    const cacheTargets = new Set<string>([sourceSessionId]);
    if (conversationId !== sourceSessionId) {
      cacheTargets.add(conversationId);
    }

    await Promise.all(Array.from(cacheTargets).map(async (targetSessionId) => {
      await insightsEngine.cacheInsights(targetSessionId, {
        ...insights,
        sessionId: targetSessionId,
      });
    }));

    res.json({
      success: true,
      conversationId,
      mission: insights.context?.mission || null,
    });
  }));

  // ==========================================================================
  // POST /activity-check — Lightweight heartbeat with mtime tracking
  // ==========================================================================
  router.post('/activity-check', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { sessionIds, knownMtimes, previouslyActiveSessionIds } = req.body as {
      sessionIds: string[];
      knownMtimes?: Record<string, number>;
      previouslyActiveSessionIds?: string[];
    };

    if (!sessionIds || !Array.isArray(sessionIds)) {
      res.status(400).json({ error: 'sessionIds array required' });
      return;
    }

    const resolvedIds = sessionIds.map((id) => {
      if (id.startsWith('conv-')) {
        // Transcript files are named by provider session UUID for every
        // provider. The API-facing resolver keeps conv-* for Claude, which
        // made this lookup miss on all Claude conversations.
        return resolveTranscriptSessionId(id);
      }
      return id;
    });

    const mtimes = await historyReader.getSessionFileMtimes(resolvedIds);
    const mtimesResult: Record<string, number> = {};

    for (let i = 0; i < sessionIds.length; i += 1) {
      const originalId = sessionIds[i];
      const resolvedId = resolvedIds[i];
      const mtime = mtimes.get(resolvedId);
      if (mtime !== undefined) {
        mtimesResult[originalId] = mtime;
      }
    }

    const requestedSessionIdSet = new Set(sessionIds);
    const activeSessionIds = Array.from(new Set(
      activeConversationRegistry
        .getAll()
        .map((ac) => ac.conversationId)
        .filter((conversationId): conversationId is string => (
          conversationId !== null && requestedSessionIdSet.has(conversationId)
        ))
    ));

    if (previouslyActiveSessionIds && previouslyActiveSessionIds.length > 0) {
      const currentActiveSet = new Set(activeSessionIds);
      const justBecameInactive: string[] = [];
      for (const sessionId of previouslyActiveSessionIds) {
        if (!currentActiveSet.has(sessionId)) {
          justBecameInactive.push(sessionId);
        }
      }
      if (justBecameInactive.length > 0) {
        logger.info('[CONV] Sessions just became inactive', {
          count: justBecameInactive.length,
          sessionIds: justBecameInactive.map((id) => id.slice(0, 8)),
        });
      }
    }

    const changedSessionIds = sessionIds.filter((id) => {
      const newMtime = mtimesResult[id];
      const oldMtime = knownMtimes?.[id];
      return newMtime !== undefined && (oldMtime === undefined || newMtime !== oldMtime);
    });

    const changedResolvedIds = changedSessionIds.map((id) => {
      if (id.startsWith('conv-')) return resolveProviderSessionId(id);
      return id;
    });

    const allCachedInsights = await insightsEngine.getCachedInsightsForSessions(changedResolvedIds);
    const insightMtimes: Record<string, number> = {};

    const allResolvedForInsights = resolvedIds.filter((_, i) => mtimesResult[sessionIds[i]] !== undefined);
    const allInsightCache = changedResolvedIds.length > 0
      ? allCachedInsights
      : await insightsEngine.getCachedInsightsForSessions(allResolvedForInsights);

    for (let i = 0; i < sessionIds.length; i += 1) {
      const originalId = sessionIds[i];
      const resolvedId = resolvedIds[i];
      const cached = allInsightCache.get(resolvedId);
      if (cached) {
        const timestamp = cached.patchedAt || cached.computedAt;
        if (timestamp) {
          insightMtimes[originalId] = new Date(timestamp).getTime();
        }
      }
    }

    logger.debug('[CONV] Activity check', {
      sessionCount: sessionIds.length,
      changedCount: changedSessionIds.length,
      activeCount: activeSessionIds.length,
    });

    res.json({ mtimes: mtimesResult, activeSessionIds, insightMtimes });
  }));
}
