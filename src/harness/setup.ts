/**
 * Harness setup — creates SessionManager and mounts routes onto the Express app.
 *
 * Called from lattice-server.ts during initialization.
 */

import type { Express } from 'express';
import { SessionManager } from '@liggi/agent-ui-harness/server';
import { DaemonProcessAdapter } from './daemon-process-adapter.js';
import { CodexProcessAdapter } from './codex-process-adapter.js';
import { OpencodeProcessAdapter } from './opencode-process-adapter.js';
import { MultiplexingProcessAdapter } from './multiplexing-process-adapter.js';
import { appendCustomHarnessEvent } from './harness-custom-events.js';
import { createHarnessRoutes } from './routes.js';
import { createEventSideEffectsCallback } from './event-side-effects.js';
import { onTurnStarted } from '../services/sessions/session-status-changes.js';
import { SqliteEventStorageAdapter } from './sqlite-event-storage.js';
import { initEventMessageReader } from './event-message-reader.js';
import { runStartupRecoverySweep } from './startup-recovery-sweep.js';
import type { ProcessManagerClient } from '../process-daemon/process-manager-client.js';
import { ConversationService } from '../services/sessions/conversation-service.js';
import { DatabaseProvider } from '../services/infrastructure/database-provider.js';
import { createLogger } from '../services/infrastructure/logger.js';
import type { ActiveConversationRegistry } from '../services/process/active-conversation-registry.js';
import type { PendingQuestionService } from '../services/pending-question-service.js';
import { CodexRequestCoordinator } from '../services/process/codex-request-coordinator.js';
import { recordCodexQuestion } from '../services/sessions/decisions.js';
import { DECISION_ASKED_EVENT, type DecisionAskedData } from '../types/decisions.js';

const logger = createLogger('HarnessSetup');

export interface HarnessSetupDeps {
  app: Express;
  processManagerClient: ProcessManagerClient;
  /** Resolve a conversationId (conv-*) to the JSONL provider session ID for --resume. */
  resolveResumeSessionId: (conversationId: string) => string;
  /** Resolve a conversationId to its working directory. */
  resolveWorkingDirectory: (conversationId: string) => string | undefined;
  /** State of the provider transcript --resume needs. */
  classifyResumeTranscript: (providerSessionId: string) => Promise<'present' | 'missing' | 'unknown'>;
  /** Registry whose streamingId index needs updating when send() spawns a
   *  fresh process for a follow-up turn. The initial spawn is registered by
   *  the conversation routes; follow-up spawns happen inside the harness and
   *  would otherwise leave the index pointing at the dead process. */
  activeConversationRegistry: ActiveConversationRegistry;
  /** Persistence/UI surface used for live Codex request_user_input requests. */
  pendingQuestionService?: PendingQuestionService;
}

export interface HarnessRuntime {
  sessionManager: SessionManager;
  eventStorage: SqliteEventStorageAdapter;
  /** Returns true if the given streamingId was spawned by the harness. */
  isHarnessManaged: (streamingId: string) => boolean;
  /** Returns true if a Codex thread has an active in-memory process handle. */
  isActiveCodexThread: (threadId: string) => boolean;
  /** Completes live Codex request_user_input calls from the pending-question routes. */
  codexRequestCoordinator?: CodexRequestCoordinator;
}

// Module-level reference — allows direct import from lifecycle routes
// without threading through 4 layers of dep injection.
let _sessionManager: SessionManager | null = null;

/** Get the harness SessionManager. Available after setupHarness() runs. */
export function getHarnessSessionManager(): SessionManager | null {
  return _sessionManager;
}

export function setupHarness(deps: HarnessSetupDeps): HarnessRuntime {
  const claudeAdapter = new DaemonProcessAdapter(deps.processManagerClient);
  const codexRequestCoordinator = deps.pendingQuestionService
    ? new CodexRequestCoordinator(deps.pendingQuestionService)
    : undefined;
  const codexAdapter = new CodexProcessAdapter((event) => {
    const manager = _sessionManager;
    if (!manager) {
      logger.warn('Dropped Codex lifecycle event before harness manager was ready', {
        sessionId: event.sessionId,
        type: event.type,
      });
      return;
    }
    if (event.type === DECISION_ASKED_EVENT) {
      recordCodexQuestion(event.sessionId, event.data as DecisionAskedData).catch((err) => {
        logger.error('Failed to record a Codex question', err instanceof Error ? err : new Error(String(err)), { sessionId: event.sessionId });
      });
      return;
    }
    appendCustomHarnessEvent(manager, event.sessionId, event.type, event.data);
  }, undefined, codexRequestCoordinator, ({ sessionId, reasoningEffort }) => {
    // The effort a Codex thread or turn actually started with, recorded beside
    // the segment's model so the next process replacement resumes on it rather
    // than on whichever default the route that replaced it happens to supply.
    if (!sessionId.startsWith('conv-')) return;
    try {
      if (ConversationService.getInstance().updateLatestSegmentReasoningEffort(sessionId, reasoningEffort)) {
        logger.info('Recorded applied Codex reasoning effort', { sessionId, reasoningEffort });
      }
    } catch (err) {
      logger.warn('Failed to record applied Codex reasoning effort', {
        sessionId,
        reasoningEffort,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  const opencodeAdapter = new OpencodeProcessAdapter();
  const adapter = new MultiplexingProcessAdapter(
    claudeAdapter,
    codexAdapter,
    opencodeAdapter,
  );

  // Persistent event storage — events survive restarts and in-memory eviction
  const db = DatabaseProvider.getInstance().getDb();
  const eventStorage = new SqliteEventStorageAdapter(db);
  initEventMessageReader(eventStorage);

  const registry = deps.activeConversationRegistry;
  onTurnStarted((sessionId) => registry.notifyActive(sessionId));
  _sessionManager = new SessionManager(adapter, {
    logger: {
      debug: (msg, data) => logger.debug(msg, data),
      info: (msg, data) => logger.info(msg, data),
      warn: (msg, data) => logger.warn(msg, data),
      error: (msg, data) => logger.error(msg, data),
    },
    maxLogSize: 2000,
    storage: eventStorage,
    onEvent: createEventSideEffectsCallback(registry),
    onFollowUpSpawn: ({ sessionId, runId, processId }) => {
      // send() spawned a fresh process for a follow-up turn. The registry's
      // byStreamingId index still points at the dead process — update it so
      // permission lookups, SSE scoping, and status polling resolve to the
      // new run. The new providerSessionId arrives later via run:ready and
      // is handled in event-side-effects.handleRunReady.
      if (!processId) {
        logger.warn('Follow-up spawn fired without processId — skipping registry update', {
          sessionId, runId,
        });
        return;
      }
      const existing = registry.get(sessionId);
      if (!existing) {
        logger.warn('Follow-up spawn for conversation not in registry', { sessionId });
        return;
      }
      registry.updateRun(sessionId, {
        streamingId: processId,
        runVersion: registry.allocateRunVersion(sessionId),
        startedAt: new Date().toISOString(),
      });
      logger.info('Registry updated for follow-up spawn', {
        sessionId,
        streamingId: processId.slice(0, 8),
      });
    },
  });

  // Close any sessions left in non-terminal status by the previous server
  // lifetime (mid-stream or mid-stop when the previous process went down).
  // Without this, those sessions stay wedged at "stopping"/"streaming"
  // forever — `/send` returns 400 and the UI shows perpetual "WORKING".
  // See startup-recovery-sweep.ts for the full diagnosis.
  try {
    runStartupRecoverySweep(_sessionManager, eventStorage);
  } catch (err) {
    // Sweep failures must not block server startup — degrade gracefully.
    logger.error('Startup recovery sweep threw unexpectedly', err);
  }

  const conversationService = ConversationService.getInstance();

  const sessionManager = _sessionManager;
  const router = createHarnessRoutes(sessionManager, {
    resolveResumeSessionId: deps.resolveResumeSessionId,
    resolveProvider: (conversationId: string) => {
      const conversation = conversationService.getConversation(conversationId);
      const latest = conversation?.segments[conversation.segments.length - 1];
      return latest?.provider ?? 'claude';
    },
    resolveWorkingDirectory: deps.resolveWorkingDirectory,
    classifyResumeTranscript: deps.classifyResumeTranscript,
    onSessionStarted: ({ sessionId, processId, model, permissionMode }) => {
      if (!sessionId.startsWith('conv-') || registry.has(sessionId)) return;

      const conversation = conversationService.getConversation(sessionId);
      const latest = conversation?.segments[conversation.segments.length - 1];
      if (!conversation || !latest) {
        logger.warn('Direct harness start has no conversation segment for registry seed', {
          sessionId,
          hasConversation: Boolean(conversation),
        });
        return;
      }

      if (processId) {
        conversationService.updateSegmentStreamingId(latest.segmentId, processId);
      }

      registry.register({
        conversationId: sessionId,
        segment: {
          segmentId: latest.segmentId,
          provider: latest.provider,
          providerSessionId: latest.providerSessionId,
          model: model ?? latest.model ?? undefined,
          transitionReason: 'conversation_start',
        },
        run: processId ? {
          streamingId: processId,
          runVersion: registry.allocateRunVersion(sessionId),
          startedAt: new Date().toISOString(),
        } : null,
        workingDirectory: conversation.workingDirectory,
        permissionMode: permissionMode ?? 'default',
      });
    },
  });
  deps.app.use('/api/harness', router);

  logger.info('Harness routes mounted at /api/harness');

  return {
    sessionManager,
    eventStorage,
    isHarnessManaged: (streamingId: string) => adapter.managedStreamingIds.has(streamingId),
    isActiveCodexThread: (threadId: string) => adapter.hasActiveCodexThread(threadId),
    ...(codexRequestCoordinator ? { codexRequestCoordinator } : {}),
  };
}
