import type { Express } from 'express';
import path from 'path';
import { createSystemRoutes } from '@/routes/system/system.routes.js';
import { createSkillsRoutes } from '@/routes/system/skills.routes.js';
import { createPermissionRoutes } from '@/routes/session/permission.routes.js';
import { createPendingQuestionRoutes } from '@/routes/session/pending-question.routes.js';
import { createFileSystemRoutes } from '@/routes/system/filesystem.routes.js';
import { createLogRoutes } from '@/routes/system/log.routes.js';
import { createWorkingDirectoriesRoutes } from '@/routes/system/working-directories.routes.js';
import { createConfigRoutes } from '@/routes/system/config.routes.js';
import { createDebugRoutes } from '@/routes/debug/debug.routes.js';
import { createConversationDiagnosticsRoutes } from '@/routes/diagnostics/conversation-diagnostics.routes.js';
import type { DiagnosticsRuntimeDeps } from '@/diagnostics/collect-conversation-diagnostics.js';
import { createInsightsRoutes } from '@/routes/insights/insights.routes.js';
import { createTeamsRoutes } from '@/routes/teams.routes.js';
import { createNotificationRoutes } from '@/routes/system/notifications.routes.js';
import { createFeedbackRoutes } from '@/routes/system/feedback.routes.js';
import timelineRouter from '@/routes/debug/timeline.routes.js';
import { createContextTransfersRoutes } from '@/routes/session/context-transfers.routes.js';
import { createUnifiedConversationRoutes } from '@/routes/conversation/unified-conversation.routes.js';
import { createNotesRoutes } from '@/routes/session/notes.routes.js';
import { createProviderAuthRoutes } from '@/routes/integrations/provider-auth.routes.js';
import { createSessionTransferRoutes } from '@/routes/session/session-transfer.routes.js';
import { createSessionStatusRoutes } from '@/routes/session/session-status.routes.js';
import { createSessionHistoryRoutes } from '@/routes/session/session-history.routes.js';
import { createAmbientRoutes } from '@/routes/ambient.routes.js';
import { createKnowledgeMapRoutes } from '@/routes/km.routes.js';
import { createVoiceRoutes } from '@/routes/voice/voice.routes.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { ClaudeHistoryReader } from '@/services/sessions/claude-history-reader.js';
import type { ActiveConversationRegistry } from '@/services/process/active-conversation-registry.js';
import type { ProcessManagerClient } from '@/process-daemon/process-manager-client.js';
import type { PermissionTracker } from '@/services/permission-tracker.js';
import type { PendingQuestionService } from '@/services/pending-question-service.js';
import type { FileSystemService } from '@/services/infrastructure/file-system-service.js';
import type { ConfigService } from '@/services/infrastructure/config-service.js';
import type { SessionInfoService } from '@/services/sessions/session-info-service.js';
import type { ConversationService } from '@/services/sessions/conversation-service.js';
import type { WorkingDirectoriesService } from '@/services/working-directories-service.js';
import type { Logger } from '@/services/infrastructure/logger.js';
import type { CodexRequestCoordinator } from '@/services/process/codex-request-coordinator.js';

export interface RegisterAppRoutesDeps {
  app: Express;
  logger: Logger;
  frontendDir: string;
  historyReader: ClaudeHistoryReader;
  activeConversationRegistry: ActiveConversationRegistry;
  processManagerClient?: ProcessManagerClient;
  conversationService?: ConversationService;
  permissionTracker: PermissionTracker;
  pendingQuestionService: PendingQuestionService;
  codexRequestCoordinator?: CodexRequestCoordinator;
  fileSystemService: FileSystemService;
  configService: ConfigService;
  sessionInfoService: SessionInfoService;
  workingDirectoriesService: WorkingDirectoriesService;
  harnessSessionManager?: DiagnosticsRuntimeDeps['harnessSessionManager'] & {
    getStatus(sessionId: string): string;
  };
}

export function registerAppRoutes(deps: RegisterAppRoutesDeps): void {
  const { app } = deps;

  // System
  app.use('/api/system', createSystemRoutes());
  app.use('/api/skills', createSkillsRoutes({ conversationService: deps.conversationService }));
  app.use('/api/permissions', createPermissionRoutes(deps.permissionTracker));
  app.use('/api/filesystem', createFileSystemRoutes(deps.fileSystemService));
  app.use('/api/logs', createLogRoutes());
  app.use('/api/working-directories', createWorkingDirectoriesRoutes(deps.workingDirectoriesService));
  app.use('/api/config', createConfigRoutes(deps.configService));
  app.use('/api/provider-auth', createProviderAuthRoutes({ processManagerClient: deps.processManagerClient }));
  app.use('/api/notifications', createNotificationRoutes());
  app.use('/api/feedback', createFeedbackRoutes());
  app.use('/api/pending-questions', createPendingQuestionRoutes(
    deps.pendingQuestionService,
    deps.historyReader,
    deps.codexRequestCoordinator,
  ));

  // Debug
  app.use('/api/debug', createDebugRoutes(deps.activeConversationRegistry));
  app.use('/api/timeline', timelineRouter);

  // Diagnostics — runtime diagnostics endpoint (additive foundation, Move 1).
  // See docs/runtime-diagnostics-and-authority-collapse.md.
  app.use('/api/diagnostics', createConversationDiagnosticsRoutes({
    activeConversationRegistry: deps.activeConversationRegistry,
    conversationService: deps.conversationService,
    processManagerClient: deps.processManagerClient,
    harnessSessionManager: deps.harnessSessionManager,
  }));

  // Conversations
  app.use('/api/conv', createUnifiedConversationRoutes({
    historyReader: deps.historyReader,
    activeConversationRegistry: deps.activeConversationRegistry,
    sessionInfoService: deps.sessionInfoService,
    permissionTracker: deps.permissionTracker,
  }));

  // Insights
  app.use('/api/insights', createInsightsRoutes());

  // Sessions
  app.use('/api/sessions', createSessionStatusRoutes({
    activeConversationRegistry: deps.activeConversationRegistry,
    sessionInfoService: deps.sessionInfoService,
    harnessSessionManager: deps.harnessSessionManager,
  }));
  app.use('/api/sessions', createSessionTransferRoutes({ historyReader: deps.historyReader }));
  app.use('/api/sessions', createSessionHistoryRoutes());

  // Misc
  app.use('/api/context-transfers', createContextTransfersRoutes());
  app.use('/api/notes', createNotesRoutes());
  app.use('/api/teams', createTeamsRoutes());
  app.use('/api/voice', createVoiceRoutes({
    conversationService: deps.conversationService,
    sessionInfoService: deps.sessionInfoService,
  }));

  // Learning map — agent write path for typed article nodes.
  // See docs/learning-map-api.md.
  app.use('/api/km', createKnowledgeMapRoutes());

  // Ambient portfolio (root-level, not under /api)
  app.use('/', createAmbientRoutes());

  // Unknown API paths stop here. Nothing registered below answers /api or
  // /ambient, so a request still unmatched at this point is an endpoint this
  // server does not have — and it must say so itself. In development the
  // Express app is bound to vite-express, which appends Vite's middleware
  // stack after these routes; that stack includes the proxy from
  // vite.config.mts, which forwards /api and /ambient to LATTICE_API_TARGET
  // (http://localhost:3001 by default). Without this terminator a route
  // deleted from this checkout keeps answering 200 from whichever server is
  // listening there, reading a different database. The proxy itself stays, so
  // running the frontend on its own with `vite` still reaches a real API.
  app.use(['/api', '/ambient'], (req, res) => {
    res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
  });

  // Frontend SPA fallback + error handler (must be last)
  if (process.env.NODE_ENV !== 'development') {
    app.get('*', (req, res) => {
      if (/\.(js|css|map|png|jpg|svg|ico|woff2?|ttf|eot)$/i.test(req.path)) {
        res.status(404).end();
        return;
      }
      res.sendFile(path.join(deps.frontendDir, 'index.html'));
    });
  }
  app.use(errorHandler);
}
