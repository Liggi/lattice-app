import type { Router } from 'express';
import fs from 'fs';
import { asyncHandler } from '@/middleware/error-handler.js';
import { RequestWithRequestId } from '@/types/express.js';
import {
  LatticeError,
  PERMISSION_MODES,
  type ContentBlockParam,
} from '@/types/index.js';
import type { ActiveConversationRegistry } from '@/services/process/active-conversation-registry.js';
import type { SessionInfoService } from '@/services/sessions/session-info-service.js';
import type {
  ConversationService,
  Provider,
} from '@/services/sessions/conversation-service.js';
import { ConfigService } from '@/services/infrastructure/config-service.js';
import { ManagedClaudeHooksService } from '@/services/infrastructure/managed-claude-hooks-service.js';

import { createLogger } from '@/services/infrastructure/logger.js';
import { normalizeWorkingDirectory } from '@/utils/working-directory.js';
import { getHarnessSessionManager } from '@/harness/setup.js';
import { DEFAULT_CODEX_MODEL_ID } from '@/constants/codex-models.js';
import { DEFAULT_OPENCODE_MODEL_ID } from '@/constants/opencode-models.js';
import { supersededModelRefusal } from '@/constants/superseded-models.js';
import { resolveResumeModel } from '@/services/sessions/resume-model.js';
import { coordinatorClaudeModel, coordinatorCodexDefaults, coordinatorProvider } from '@/services/sessions/coordinator-defaults.js';
import {
  currentCodexReasoningEffort,
  knownCodexReasoningEffort,
  resolveCodexReasoningEffort,
} from '@/services/sessions/codex-effort.js';
import { buildCoordinatorPreamble, buildWorkerPreamble, latticeCli } from '@/services/sessions/pickup-prompts.js';
import { installedProviders } from '@/services/sessions/installed-providers.js';
import { appendWorkerEvent } from '@/services/sessions/worker-events.js';
import { readProjectState } from '@/services/sessions/project-state.js';
import { buildProjectOrientation } from '@/services/sessions/project-orientation.js';
import { buildWorkerDriftNote } from '@/services/sessions/worker-drift.js';
import { switchCoordinator } from '@/services/sessions/coordinator-switch.js';
import { unfinishedSwitchRefusal } from '@/services/sessions/coordinator-switch-state.js';

import type { ProjectOpenThread } from '@/types/project-state.js';
import { persistCoordinatorImages } from '@/services/sessions/coordinator-attachments.js';
import { parseAttachmentBlocks } from '@/harness/attachment-blocks.js';
import type { WorkerStartedData } from '@/types/worker-events.js';

const logger = createLogger('UnifiedConversationLifecycleRoutes');
const DEFAULT_CODEX_MODEL = DEFAULT_CODEX_MODEL_ID;
const CODEX_PERMISSION_MODE = 'codex-bypass';
/** opencode's server owns approval policy through its own agent config. */
const OPENCODE_PERMISSION_MODE = 'opencode-managed';

/** Model recorded on a segment when the caller did not name one. */
function defaultModelForProvider(provider: Provider): string {
  if (provider === 'codex') return DEFAULT_CODEX_MODEL;
  if (provider === 'opencode') return DEFAULT_OPENCODE_MODEL_ID;
  return 'unknown';
}

/**
 * Sync Claude hook URLs in ~/.claude/settings.json before each process spawn.
 *
 * Why: ensureManagedClaudeHooks() in lattice-server.ts only runs at startup.
 * If anything overwrites settings.json after that (e.g. preflight tests on
 * port 4200, or another Lattice instance), the hook URLs point to the wrong
 * port and Claude Code silently skips permission prompts (connection refused
 * → hook ignored). Re-syncing before each spawn makes this resilient.
 */
function ensureHooksBeforeSpawn(): void {
  try {
    const config = ConfigService.getInstance().getConfig();
    const port = config.server.port || 3001;
    const service = new ManagedClaudeHooksService();
    const changed = service.ensureHooks({
      baseUrl: `http://localhost:${port}`,
      authToken: config.server.authToken,
    });
    if (changed.permissionRequestChanged || changed.preToolUseChanged) {
      logger.warn(
        'Pre-spawn hook sync: URLs were stale, corrected before Claude launch',
        { port, changed }
      );
    }
  } catch (err) {
    logger.warn('Failed to sync Claude hooks before spawn', { err });
  }
}


function resolveExistingConversationPermissionMode(params: {
  provider: Provider;
  requestedMode?: string;
  storedMode?: string | null;
}): string {
  if (params.provider === 'codex') {
    return CODEX_PERMISSION_MODE;
  }

  if (params.requestedMode !== undefined) {
    return params.requestedMode;
  }

  if (params.storedMode) {
    return params.storedMode;
  }

  const serverDefault = ConfigService.getInstance().getConfig().server.defaultPermissionMode;
  return serverDefault || 'bypassPermissions';
}

export interface UnifiedConversationLifecycleRoutesContext {
  activeConversationRegistry: ActiveConversationRegistry;
  sessionInfoService: SessionInfoService;
  conversationService: ConversationService;
  generateTraceId: (prefix: string) => string;
}

export function registerUnifiedConversationLifecycleRoutes(
  router: Router,
  context: UnifiedConversationLifecycleRoutesContext
): void {
  const {
    activeConversationRegistry,
    sessionInfoService,
    conversationService,
    generateTraceId,
  } = context;

  router.post('/create', asyncHandler(async (req: RequestWithRequestId, res) => {
    const body = req.body as {
      /** May be omitted for a coordinator, which then takes coordinatorProvider(). */
      provider: Provider;
      message: string;
      workingDirectory: string;
      model?: string;
      permissionMode?: string;
      workspace?: string;
      reasoningEffort?: string;
      systemPrompt?: string;
      initialContent?: ContentBlockParam[];
      goalObjective?: string;
      goalTokenBudget?: number;
      /** No longer offered: Claude runs only through the user's installed CLI. A true here is refused, not silently rerouted. */
      useSdkAdapter?: boolean;
      /** Coordinator that dispatched this conversation as a worker. */
      pickedUpFrom?: string;
      /** One line saying what the worker is to find out or do; shown on its card and in the thread. */
      task?: string;
      /** The coordinator's open thread this worker is being put on (the seq `session state` shows). */
      thread?: number;
      /** Start this conversation as a coordinator (front persona). */
      coordinator?: boolean;
      /**
       * Create it already archived, so it never appears in the sidebar. For
       * verification fixtures: a coordinator is a project as soon as its row
       * exists and is not archived, so creating one and archiving it after is
       * a visible race, not a clean-up.
       */
      archived?: boolean;
    };

    // A worker picked up from a coordinator lands in the parent's working
    // directory and workspace unless the caller names them. Resolved before
    // the required-fields guard so `--from` alone is a complete request.
    const parentConversation = body.pickedUpFrom
      ? conversationService.getConversation(body.pickedUpFrom)
      : null;
    if (body.pickedUpFrom && !parentConversation) {
      throw new LatticeError('CONVERSATION_NOT_FOUND', `Conversation ${body.pickedUpFrom} not found`, 404);
    }
    // Dispatching onto a thread is what links this worker's later reports and
    // questions to a piece of the project, so the thread has to be one that
    // is actually open on the parent rather than a number the caller guessed.
    let threadAssignment: ProjectOpenThread | null = null;
    if (body.thread !== undefined) {
      if (!parentConversation) {
        throw new LatticeError('INVALID_REQUEST', 'thread needs pickedUpFrom: it names an open thread of the dispatching coordinator', 400);
      }
      const open = readProjectState(parentConversation.conversationId).open;
      threadAssignment = open.find((candidate) => candidate.seq === body.thread) ?? null;
      if (!threadAssignment) {
        throw new LatticeError(
          'INVALID_REQUEST',
          `thread must be an open thread of ${parentConversation.conversationId}: ${open.map((candidate) => candidate.seq).join(', ') || 'none open'}`,
          400,
        );
      }
    }
    if (parentConversation) {
      body.workingDirectory ||= parentConversation.workingDirectory;
      body.workspace ||= parentConversation.workspace;
    }
    // Whatever a hidden fixture dispatches is part of the fixture, so it is
    // created hidden too; otherwise the fixture's worker lands in the sidebar.
    const archived = Boolean(body.archived)
      || (parentConversation !== null && conversationService.wasCreatedHidden(parentConversation.conversationId));

    const normalizedWorkingDirectory = normalizeWorkingDirectory(body.workingDirectory);
    const { message, permissionMode: requestedMode, workspace } = body;
    const provider: Provider = body.provider ?? (body.coordinator ? await coordinatorProvider() : body.provider);
    // A coordinator the caller did not pin runs on the coordinator defaults
    // rather than the general Codex ones (coordinator-defaults.ts). Resolved
    // here so the segment records the model a resume will keep it on.
    const coordinatorDefaults = body.coordinator && provider === 'codex' ? coordinatorCodexDefaults() : null;
    const model = body.model
      ?? coordinatorDefaults?.model
      ?? (body.coordinator && provider === 'claude' ? coordinatorClaudeModel() : undefined);
    const supersededCreate = supersededModelRefusal(model);
    if (supersededCreate) throw new LatticeError('SUPERSEDED_MODEL', supersededCreate, 400);
    // New conversation, so a creation default is the right fallback — there is
    // no earlier choice for it to overwrite (codex-effort.ts).
    const reasoningEffort = provider === 'codex'
      ? resolveCodexReasoningEffort({
          requested: body.reasoningEffort,
          fallback: coordinatorDefaults?.reasoningEffort,
        }).effort
      : undefined;
    const workingDirectory = normalizedWorkingDirectory || body.workingDirectory;
    const traceId = generateTraceId('conv');

    const hasAttachments = Array.isArray(body.initialContent) && body.initialContent.length > 0;
    if (!provider || (!message && !hasAttachments) || !workingDirectory) {
      throw new LatticeError('INVALID_REQUEST', 'provider, workingDirectory, and either message or initialContent are required', 400);
    }
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'opencode') {
      res.status(400).json({
        error: 'unsupported_provider',
        supportedProviders: ['claude', 'codex', 'opencode'],
      });
      return;
    }
    // Refused before the conversation row exists, so a mistyped folder leaves no project behind.
    if (!fs.statSync(workingDirectory, { throwIfNoEntry: false })?.isDirectory()) {
      throw new LatticeError('WORKING_DIRECTORY_NOT_FOUND', `Folder not found: ${workingDirectory}`, 400);
    }
    // Capture timestamp BEFORE spawning process — ensures user prompt is always
    // ordered before any response the process produces (race condition fix)
    const _promptTimestamp = new Date().toISOString();

    if (body.useSdkAdapter === true) {
      throw new LatticeError('SDK_TRANSPORT_REMOVED', 'Claude runs only through the Claude Code CLI installed on this machine; useSdkAdapter is no longer offered', 400);
    }
    if (provider === 'claude' && requestedMode && !PERMISSION_MODES.includes(requestedMode as typeof PERMISSION_MODES[number])) {
      throw new LatticeError('INVALID_PERMISSION_MODE', `permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`, 400);
    }

    // Default to server-configured permission mode when not provided.
    // Agents often omit this or pass 'default' — the server config is the source of truth.
    const serverConfig = ConfigService.getInstance().getConfig().server;
    const workerDefault = parentConversation && !body.coordinator ? serverConfig.workerPermissionMode ?? 'auto' : undefined;
    const permissionMode = provider === 'codex'
      ? CODEX_PERMISSION_MODE
      : provider === 'opencode'
        ? OPENCODE_PERMISSION_MODE
        : requestedMode || workerDefault || serverConfig.defaultPermissionMode || 'bypassPermissions';

    logger.info('[CONV] Creating new conversation', {
      provider,
      workingDirectory: workingDirectory.slice(-40),
      model,
      promptPreview: message ? message.slice(0, 80) : '(file-only)',
    });

    {
      // Sync hook URLs before spawn (resilient against external overwrites)
      if (provider === 'claude') {
        ensureHooksBeforeSpawn();
      }

      // Create conversation record FIRST — harness resolvers need it to exist.
      // Segment starts with a pending- placeholder; the real provider session ID
      // arrives via run:ready and is written by the event persistence handler.
      const { conversationId, segmentId } = conversationService.createConversation({
        workingDirectory,
        provider,
        providerSessionId: `pending-${Date.now()}`,
        model: model ?? defaultModelForProvider(provider),
        reasoningEffort,
        workspace,
        initialPrompt: message,
        pickedUpFrom: parentConversation?.conversationId,
        coordinator: Boolean(body.coordinator),
        archived,
      });

      // The row is a project in the sidebar from here on. If the session
      // cannot start (a CLI that is missing or signed out), archive it so the
      // failed attempt does not sit in the sidebar as a project that never ran.
      let spawnResult: Awaited<ReturnType<NonNullable<ReturnType<typeof getHarnessSessionManager>>['start']>>;
      try {
        // The harness gets the preamble plus the caller's text; the record
        // above keeps only the caller's text as initial_prompt.
        const prompt = parentConversation
          ? buildWorkerPreamble({
              conversationId,
              parentConversationId: parentConversation.conversationId,
              parentProvider: parentConversation.latestProvider,
              parentModel: conversationService.getLatestSegment(parentConversation.conversationId)?.model ?? null,
              workingDirectory,
              cli: latticeCli(),
              thread: threadAssignment ? { seq: threadAssignment.seq, text: threadAssignment.text } : null,
            }) + message
          : body.coordinator
            ? buildCoordinatorPreamble({ conversationId, workingDirectory, cli: latticeCli(), installedProviders: installedProviders() }) + message
            : message;

        // Prime conversation metadata
        await sessionInfoService.updateSessionInfo(conversationId, {
          archived,
          ...(permissionMode && { permission_mode: permissionMode }),
          workspace: workspace || 'main',
        });

        // Spawn via harness SessionManager — single pipeline.
        // Events flow: daemon → harness EventLog → SSE + SqliteEventStorage.
        const harnessSessionManager = getHarnessSessionManager();
        if (!harnessSessionManager) {
          throw new LatticeError('HARNESS_UNAVAILABLE', 'Harness session manager not available', 500);
        }


        // A coordinator's first-turn images are kept on disk for its workers
        // (see coordinator-attachments.ts); the adapters validate the blocks
        // again downstream, so a malformed payload still fails there.
        let initialContent = body.initialContent;
        if (body.coordinator && hasAttachments) {
          const parsed = parseAttachmentBlocks(body.initialContent);
          if (parsed.ok) initialContent = persistCoordinatorImages(conversationId, parsed.blocks);
        }

        spawnResult = await harnessSessionManager.start(conversationId, {
          prompt,
          cwd: workingDirectory,
          args: [
            ...(model ? [`--model=${model}`]
              : provider === 'claude' ? [] : [`--model=${defaultModelForProvider(provider)}`]),
            ...(provider === 'claude' && permissionMode ? [`--permission-mode=${permissionMode}`] : []),
          ],
          extra: {
            sessionId: conversationId,
            provider,
            workspace: workspace || 'main',
            ...(provider === 'codex' ? {
              model: model ?? DEFAULT_CODEX_MODEL,
              reasoningEffort,
              goalObjective: body.goalObjective,
              goalTokenBudget: body.goalTokenBudget,
            } : {}),
            ...(provider === 'opencode' ? {
              model: model ?? DEFAULT_OPENCODE_MODEL_ID,
            } : {}),
            systemPrompt: body.systemPrompt,
            initialContent,
            // Same blocks, second key: `initialContent` is the daemon adapter's
            // spelling, `attachments` is what the SDK adapter reads and what the
            // harness copies onto the input:sent event so the transcript renders
            // them. Same array reference, so no payload duplication.
            ...(hasAttachments ? { attachments: initialContent } : {}),
          },
        });
      } catch (error) {
        logger.warn('[CONV] Create failed after the conversation row existed; archiving it', {
          conversationId,
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
        await sessionInfoService.updateSessionInfo(conversationId, { archived: true });
        throw error;
      }

      const streamingId = spawnResult.processId ?? `harness-${Date.now()}`;

      // The coordinator's transcript records the dispatch as a worker event
      // (its thread block and panel card). The task line comes from --task;
      // without one, the brief's first non-empty line stands in.
      if (parentConversation) {
        const task = body.task?.trim()
          || (message ?? '').split('\n').map((line) => line.trim()).find((line) => line.length > 0)
          || 'Worker';
        appendWorkerEvent(parentConversation.conversationId, 'worker:started', {
          worker: conversationId,
          provider,
          model: model ?? defaultModelForProvider(provider),
          task,
          ...(threadAssignment ? { thread: threadAssignment.seq } : {}),
        } satisfies WorkerStartedData);
      }

      // Register with ActiveConversationRegistry
      activeConversationRegistry.register({
        conversationId,
        segment: {
          segmentId,
          provider,
          providerSessionId: conversationId,
          model: model ?? defaultModelForProvider(provider),
          transitionReason: 'conversation_start',
        },
        run: {
          streamingId,
          runVersion: activeConversationRegistry.allocateRunVersion(conversationId),
          startedAt: new Date().toISOString(),
        },
        workingDirectory,
        permissionMode,
      });

      sessionInfoService.recordSessionEvent({
        sessionId: conversationId,
        traceId,
        eventType: 'conversation_created',
        provider,
        streamingId,
        source: 'server',
        metadata: { conversationId, segmentId },
      });

      logger.info('[CONV] Conversation created (harness pipeline)', {
        conversationId,
        segmentId,
        streamingId: streamingId.slice(0, 8),
      });

      const codexThreadId = provider === 'codex' && streamingId.startsWith('codex-')
        ? streamingId.slice('codex-'.length)
        : undefined;

      res.json({
        conversationId,
        segmentId,
        streamingId,
        streamUrl: `/api/harness/${conversationId}/events`,
        sessionId: conversationId,
        provider,
        cwd: workingDirectory,
        model: model ?? defaultModelForProvider(provider),
        permissionMode,
        transitionReason: 'conversation_start',
        ...(codexThreadId ? { threadId: codexThreadId } : {}),
      });
    }
  }));

  // ==========================================================================
  // POST /:conversationId/resume — Resume latest segment with a new message
  // ==========================================================================
  router.post('/:conversationId/resume', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;

    // Block writes to imported (read-only) sessions
    const resumeSessionInfo = sessionInfoService.getSessionInfoSync(conversationId);
    if (resumeSessionInfo?.imported_at) {
      throw new LatticeError('IMPORTED_READ_ONLY', 'Imported sessions are read-only', 403);
    }

    const body = req.body as {
      message: string;
      model?: string;
      reasoningEffort?: string;
      permissionMode?: string;
      initialContent?: ContentBlockParam[];
    };

    const { message, model, permissionMode: requestedMode, initialContent } = body;
    const traceId = generateTraceId('resume');
    // Only a model the caller names: a conversation already on a superseded one keeps running.
    const supersededResume = supersededModelRefusal(model);
    if (supersededResume) throw new LatticeError('SUPERSEDED_MODEL', supersededResume, 400);

    const hasAttachments = Array.isArray(initialContent) && initialContent.length > 0;
    if (!message && !hasAttachments) {
      throw new LatticeError('INVALID_REQUEST', 'message or initialContent is required', 400);
    }
    // The same block a send gets (coordinator-switch.ts): a resume would start
    // whichever provider the segment names, which is what is in doubt.
    const unfinishedSwitch = unfinishedSwitchRefusal(conversationId, conversationService, latticeCli());
    if (unfinishedSwitch) throw new LatticeError('SWITCH_UNFINISHED', unfinishedSwitch, 409);

    // Capture timestamp BEFORE spawning process — ensures user prompt is always
    // ordered before any response the process produces (race condition fix)
    const _promptTimestamp = new Date().toISOString();

    const conversation = conversationService.getConversation(conversationId);
    if (!conversation) {
      throw new LatticeError('CONVERSATION_NOT_FOUND', `Conversation ${conversationId} not found`, 404);
    }

    const latestSegment = conversationService.getLatestSegment(conversationId);
    if (!latestSegment) {
      throw new LatticeError('NO_SEGMENTS', `Conversation ${conversationId} has no segments`, 500);
    }

    const permissionMode = resolveExistingConversationPermissionMode({
      provider: latestSegment.provider,
      requestedMode,
      storedMode: resumeSessionInfo?.permission_mode || null,
    });
    const resumeModel = resolveResumeModel({
      provider: latestSegment.provider,
      requestedModel: model,
      storedModel: latestSegment.model,
    });
    // Symmetric with the model: what this request asks for, else what the
    // conversation is actually running at. A resume no longer substitutes a
    // default, which is what made a restart lose the user's choice.
    const resumeEffort = latestSegment.provider === 'codex'
      ? currentCodexReasoningEffort(conversationId, body.reasoningEffort)
      : null;
    const knownResumeEffort = knownCodexReasoningEffort(resumeEffort);

    logger.info('[CONV] Resuming conversation', {
      conversationId,
      provider: latestSegment.provider,
      segmentId: latestSegment.segmentId,
      model: resumeModel,
      modelSource: model ? 'request' : latestSegment.model && latestSegment.model !== 'unknown' ? 'segment' : 'provider-default',
      ...(resumeEffort ? { reasoningEffort: resumeEffort.effort, effortSource: resumeEffort.source } : {}),
      promptPreview: message ? message.slice(0, 80) : '(file-only)',
    });

    if (latestSegment.provider !== 'claude'
      && latestSegment.provider !== 'codex'
      && latestSegment.provider !== 'opencode') {
      res.status(400).json({
        error: 'unsupported_provider',
        supportedProviders: ['claude', 'codex', 'opencode'],
      });
      return;
    }

    {
      if (latestSegment.provider === 'claude') {
        ensureHooksBeforeSpawn();
      }

      // Spawn via harness SessionManager — single pipeline.
      const harnessSessionManager = getHarnessSessionManager();
      if (!harnessSessionManager) {
        throw new LatticeError('HARNESS_UNAVAILABLE', 'Harness session manager not available', 500);
      }


      // A cold resume is the case with the least in context and, until now,
      // the only delivery path that carried no project record at all: the
      // message went to a respawned process as itself. A project session
      // coming back this way gets the same active projection every other turn
      // gets. Never fatal — the message goes either way.
      let resumeOrientation = '';
      try {
        resumeOrientation = buildProjectOrientation(conversationId, latticeCli())
          + buildWorkerDriftNote(conversationId, latticeCli());
      } catch (err) {
        logger.warn('[CONV] Project orientation skipped on resume', {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const spawnResult = await harnessSessionManager.start(conversationId, {
        prompt: resumeOrientation ? resumeOrientation + (message ?? '') : message,

        cwd: conversation.workingDirectory,
        resume: latestSegment.providerSessionId,
        args: [
          ...(resumeModel ? [`--model=${resumeModel}`] : []),
          ...(latestSegment.provider === 'claude' && permissionMode ? [`--permission-mode=${permissionMode}`] : []),
        ],
        extra: {
          sessionId: conversationId,
          provider: latestSegment.provider,
          workspace: conversation.workspace,
          ...(latestSegment.provider === 'codex' ? {
            model: resumeModel,
            ...(knownResumeEffort ? { reasoningEffort: knownResumeEffort } : {}),
          } : {}),
          ...(latestSegment.provider === 'opencode' ? {
            model: resumeModel,
          } : {}),
          initialContent,
          ...(hasAttachments ? { attachments: initialContent } : {}),
        },
      });

      const streamingId = spawnResult.processId ?? `harness-${Date.now()}`;

      conversationService.updateSegmentStreamingId(latestSegment.segmentId, streamingId);
      conversationService.touchConversation(conversationId);

      activeConversationRegistry.register({
        conversationId,
        segment: {
          segmentId: latestSegment.segmentId,
          provider: latestSegment.provider,
          providerSessionId: latestSegment.providerSessionId,
          model: resumeModel,
          transitionReason: 'resume',
        },
        run: {
          streamingId,
          runVersion: activeConversationRegistry.allocateRunVersion(conversationId),
          startedAt: new Date().toISOString(),
        },
        workingDirectory: conversation.workingDirectory,
        permissionMode,
      });

      await sessionInfoService.updateSessionInfo(conversationId, {
        archived: false,
        ...(permissionMode && { permission_mode: permissionMode }),
      });

      sessionInfoService.recordSessionEvent({
        sessionId: conversationId,
        traceId,
        eventType: 'conversation_resumed',
        provider: latestSegment.provider,
        streamingId,
        source: 'server',
        metadata: { conversationId, segmentId: latestSegment.segmentId },
      });

      logger.info('[CONV] Conversation resumed (harness pipeline)', {
        conversationId,
        streamingId: streamingId.slice(0, 8),
      });

      const codexThreadId = latestSegment.provider === 'codex' && streamingId.startsWith('codex-')
        ? streamingId.slice('codex-'.length)
        : undefined;

      res.json({
        conversationId,
        segmentId: latestSegment.segmentId,
        streamingId,
        streamUrl: `/api/harness/${conversationId}/events`,
        sessionId: conversationId,
        provider: latestSegment.provider,
        cwd: conversation.workingDirectory,
        model: resumeModel,
        transitionReason: 'resume',
        ...(codexThreadId ? { threadId: codexThreadId } : {}),
      });
    }
  }));

  // Move a coordinator to another provider in place: same conversation id,
  // log, project record and workers (coordinator-switch.ts). Refuses unless
  // it is idle; `status` in the body says which of switched / unchanged /
  // refused / failed happened.
  router.post('/:conversationId/switch', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    const body = (req.body ?? {}) as { provider?: string; model?: string };
    if (body.provider !== 'claude' && body.provider !== 'codex') {
      throw new LatticeError('INVALID_REQUEST', 'provider must be claude or codex', 400);
    }
    if (typeof body.model !== 'string' || body.model.trim() === '') {
      throw new LatticeError('INVALID_REQUEST', 'model is required', 400);
    }
    const harnessSessionManager = getHarnessSessionManager();
    if (!harnessSessionManager) {
      throw new LatticeError('HARNESS_UNAVAILABLE', 'Harness session manager not available', 500);
    }
    const conversation = conversationService.getConversation(conversationId);
    const claudePermissionMode = resolveExistingConversationPermissionMode({ provider: 'claude' });
    const result = await switchCoordinator(conversationId, { provider: body.provider, model: body.model.trim() }, {
      sessionManager: harnessSessionManager,
      conversationService,
      registry: activeConversationRegistry,
      cli: latticeCli(),
      claudeSpawn: () => {
        ensureHooksBeforeSpawn();
        return { permissionMode: claudePermissionMode };
      },
      // What a lifecycle resume of the Codex segment would start, minus a
      // message: the thread is resumed and waits.
      codexResumeConfig: (id, segment) => {
        const resumeModel = resolveResumeModel({ provider: 'codex', storedModel: segment.model });
        const effort = knownCodexReasoningEffort(currentCodexReasoningEffort(id));
        return {
          prompt: '',
          cwd: conversation?.workingDirectory,
          resume: segment.providerSessionId,
          args: resumeModel ? [`--model=${resumeModel}`] : [],
          extra: {
            sessionId: id,
            provider: 'codex',
            workspace: conversation?.workspace,
            model: resumeModel,
            ...(effort ? { reasoningEffort: effort } : {}),
          },
        };
      },
    });
    // The stored mode is what a later start passes to the CLI, and Claude
    // rejects the Codex one the conversation was created with.
    if (result.status === 'switched' && result.to.provider === 'claude') {
      await sessionInfoService.updateSessionInfo(conversationId, { permission_mode: claudePermissionMode });
    }
    const httpStatus = result.status === 'refused'
      ? (result.code === 'not-found' ? 404 : result.code === 'unknown-model' || result.code === 'unsupported' || result.code === 'not-coordinator' ? 400 : 409)
      : result.status === 'failed' ? 502 : 200;
    res.status(httpStatus).json(result);
  }));

}
