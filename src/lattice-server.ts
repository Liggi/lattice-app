import express, { Express } from 'express';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { displayServerStartup } from './utils/server-startup.js';
import { AGENT_CLI_PATH, writeAgentCli } from './services/infrastructure/agent-cli.js';
import { AGENT_SKILLS_DIR, writeAgentSkills } from './services/infrastructure/agent-skills.js';
import { latticeCli } from './services/sessions/pickup-prompts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** JSON body ceiling for /api/harness — sized to the composer's attachment cap
 *  (20 files x 5MB, ~134MB base64). See setupMiddleware(). */
const HARNESS_JSON_BODY_LIMIT = '150mb';
import { ClaudeHistoryReader } from './services/sessions/claude-history-reader.js';
import { PermissionTracker } from './services/permission-tracker.js';
import { setupSdkPermissionBridge } from './services/sdk-permission-bridge.js';
import { ClaudeQuestionCoordinator } from './services/process/claude-question-coordinator.js';
import { PendingQuestionService } from './services/pending-question-service.js';
import { FileSystemService } from './services/infrastructure/file-system-service.js';
import { ConfigService } from './services/infrastructure/config-service.js';
import { ClaudeSettingsService } from './services/infrastructure/claude-settings-service.js';
import { ManagedClaudeHooksService } from './services/infrastructure/managed-claude-hooks-service.js';
import { SessionInfoService } from './services/sessions/session-info-service.js';
import { ActiveConversationRegistry } from './services/process/active-conversation-registry.js';
import { WorkingDirectoriesService } from './services/working-directories-service.js';
import { NotificationService } from './services/notification-service.js';
import { WebPushService } from './services/web-push-service.js';
import { geminiService } from './services/gemini-service.js';
import { anthropicService } from './services/insights/anthropic-service.js';
import { startEventLoopMonitor, stopEventLoopMonitor } from './services/infrastructure/event-loop-monitor.js';
import { LatticeError } from './types/index.js';
import { createLogger, type Logger } from './services/infrastructure/logger.js';
import { getTeamWatcherService } from './services/teams/team-watcher-service.js';
import { requestLogger } from './middleware/request-logger.js';
import { createCorsMiddleware } from './middleware/cors-setup.js';
import { queryParser } from './middleware/query-parser.js';
import { describePortInUse, isPortServed } from './utils/port-in-use.js';
import { createAuthMiddleware } from './middleware/auth-token.js';
import { serviceRegistry } from './services/infrastructure/service-registry.js';
import { registerAppRoutes } from './server/register-app-routes.js';
import { setupHarness, type HarnessRuntime } from './harness/setup.js';
import { carryOnAfterDaemonReconnect, rerunCutOffCompactions } from './services/sessions/restart-carry-on.js';
import { migrateLegacyHistoryToEvents } from './harness/legacy-message-migration.js';
import { DatabaseProvider } from './services/infrastructure/database-provider.js';
import { ProcessManagerClient } from './process-daemon/process-manager-client.js';
import { ensureDaemon } from './process-daemon/ensure-daemon.js';
import type { ChildProcess } from 'child_process';
import { ConversationService } from './services/sessions/conversation-service.js';
import { drainAllInboxes } from './services/sessions/session-inbox.js';
import { settleHeldDeliveries } from './services/sessions/held-delivery-settlement.js';
import { wakeRestartWaiters } from './services/sessions/wait-watch.js';
import { servesViteDevClient } from './server/vite-dev-client.js';

// ViteExpress will be imported dynamically in initialize() if needed
let ViteExpress: typeof import('vite-express') | undefined;

/**
 * Main Lattice server class
 */
export class LatticeServer {
  private static creditStatusEventsWired = false;

  private app: Express;
  private server?: import('http').Server;
  private historyReader: ClaudeHistoryReader;
  private permissionTracker: PermissionTracker;
  private pendingQuestionService: PendingQuestionService;
  private claudeQuestionCoordinator?: ClaudeQuestionCoordinator;
  private fileSystemService: FileSystemService;
  private configService: ConfigService;
  private claudeSettingsService: ClaudeSettingsService;
  private managedClaudeHooksService: ManagedClaudeHooksService;
  private sessionInfoService: SessionInfoService;
  private activeConversationRegistry: ActiveConversationRegistry;
  private workingDirectoriesService: WorkingDirectoriesService;
  private notificationService: NotificationService;
  private webPushService: WebPushService;
  private logger: Logger;
  private port: number;
  private host: string;
  private configOverrides?: { port?: number; host?: string; cwd?: string };
  private harnessRuntime?: HarnessRuntime;
  private processManagerClient?: ProcessManagerClient;
  private spawnedDaemonChild: ChildProcess | null = null;
  private summaryTickHandle: NodeJS.Timeout | null = null;
  private autoArchiveTickHandle: NodeJS.Timeout | null = null;
  private idleReapTickHandle: NodeJS.Timeout | null = null;
  private waitWatchTickHandle: NodeJS.Timeout | null = null;

  /**
   * Periodic auto-gen interval for the session-summary index. 30 min — latency
   * to next-session-spawn is non-load-bearing (the index is read at spawn
   * time only), so a tight tick buys nothing. Cost of a no-op tick is one
   * SQL query; cost of an active tick is bounded by the service's per-tick
   * cap and idle-grace filter (see SessionSummaryService for both).
   */
  private static readonly SUMMARY_TICK_INTERVAL_MS = 30 * 60 * 1000;

  /**
   * Auto-archive sweep interval. Hourly against a seven-day cutoff — the
   * boundary a session crosses is a week old, so the difference between
   * noticing it now and noticing it in an hour is invisible. A no-op tick is
   * one indexed query.
   */
  private static readonly AUTO_ARCHIVE_TICK_INTERVAL_MS = 60 * 60 * 1000;
  /**
   * Idle keep-alive processes are checked every 5 minutes and reaped after 30
   * idle minutes (see idle-session-reaper). No boot tick: right after a
   * restart nothing has been idle long enough to qualify.
   */
  private static readonly IDLE_REAP_TICK_INTERVAL_MS = 5 * 60 * 1000;
  /** How often waiting workers are checked for having nothing set up to wake them. */
  private static readonly WAIT_WATCH_TICK_INTERVAL_MS = 2 * 60 * 1000;

  constructor(configOverrides?: { port?: number; host?: string; cwd?: string }) {
    this.app = express();
    this.configOverrides = configOverrides;
    
    this.logger = createLogger('LatticeServer');
    
    this.configService = ConfigService.getInstance();

    this.port = 0;
    this.host = '';

    this.logger.debug('Initializing LatticeServer', {
      nodeEnv: process.env.NODE_ENV,
      configOverrides
    });

    this.logger.debug('Initializing services');
    this.sessionInfoService = SessionInfoService.getInstance();
    this.historyReader = new ClaudeHistoryReader(this.sessionInfoService);
    this.activeConversationRegistry = new ActiveConversationRegistry();
    this.fileSystemService = new FileSystemService();
    this.permissionTracker = new PermissionTracker();
    this.pendingQuestionService = PendingQuestionService.getInstance();
    this.claudeSettingsService = ClaudeSettingsService.getInstance();
    this.managedClaudeHooksService = new ManagedClaudeHooksService(this.claudeSettingsService, this.logger);
    this.workingDirectoriesService = new WorkingDirectoriesService(this.historyReader, this.logger);
    this.notificationService = new NotificationService();
    this.webPushService = WebPushService.getInstance();
    // Wire up services that don't depend on processManager
    this.permissionTracker.setNotificationService(this.notificationService);
    this.permissionTracker.setActiveConversationRegistry(this.activeConversationRegistry);

    this.logger.debug('Services initialized');

    this.setupMiddleware();
    // Routes and processManager integration are set up in initialize()
  }

  /**
   * Get the Express app instance
   */
  getApp(): Express {
    return this.app;
  }

  /**
   * Get the configured port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the configured host
   */
  getHost(): string {
    return this.host;
  }

  /**
   * Initialize services without starting the HTTP server
   */
  async initialize(): Promise<void> {
    this.logger.debug('Initialize method called');
    try {
      this.registerServiceDependencies();
      const config = await this.initializeConfigAndGetConfig();
      await this.initializePersistenceServices();
      this.initializeProcessSupportServices();
      await this.initializeAiServicesAndInsights();
      this.applyResolvedServerConfig(config);
      // Before anything below points shared state (Claude hooks, the agent
      // CLI) at this port.
      if (this.port !== 0 && await isPortServed(this.host, this.port)) {
        throw new LatticeError('PORT_IN_USE', await describePortInUse(this.host, this.port), 500);
      }
      await this.setupRoutesAndStateLogging();
      // Must run after setupRoutesAndStateLogging() — that path wires up
      // SqliteEventStorageAdapter, which is what creates the harness_events
      // table. The summary scheduler prepares a statement against that
      // table at init time, so on a pristine DB it has to come second.
      await this.initializeSessionSummaryScheduler();
      // Same ordering constraint: the sweep's candidate query joins
      // harness_events, so it has to be prepared after that table exists.
      this.initializeAutoArchiveSweep();
      this.initializeIdleSessionReaper();
      this.initializeWaitWatch();
      this.ensureManagedClaudeHooks();
      startEventLoopMonitor();

    } catch (error) {
      // The throwing layer already logged full detail. Note the failure path
      // at debug so the chain is traceable without triple-logging the same error.
      this.logger.debug('Server initialization threw — rethrowing', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof LatticeError) {
        throw error;
      } else {
        throw new LatticeError('SERVER_INIT_FAILED', `Server initialization failed: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }
  }

  private registerServiceDependencies(): void {
    serviceRegistry.register('ConfigService');
    serviceRegistry.register('SessionInfoService', { dependsOn: ['ConfigService'] });
    serviceRegistry.register('PendingQuestionService', { dependsOn: ['SessionInfoService'] });
    serviceRegistry.register('GeminiService', { dependsOn: ['ConfigService'] });
    serviceRegistry.register('AnthropicService', { dependsOn: ['ConfigService'] });
    serviceRegistry.register('CostTracker', { dependsOn: ['ConfigService'] });
    serviceRegistry.register('InsightsCoordinator', {
      dependsOn: ['SessionInfoService', 'AnthropicService']
    });
  }

  private async initializeConfigAndGetConfig(): Promise<ReturnType<ConfigService['getConfig']>> {
    this.logger.debug('Initializing configuration');
    await this.configService.initialize();
    serviceRegistry.markInitialized('ConfigService');

    // Set the invocation cwd if provided via CLI.
    if (this.configOverrides?.cwd) {
      this.configService.setInvocationCwd(this.configOverrides.cwd);
    }

    return this.configService.getConfig();
  }

  private async initializePersistenceServices(): Promise<void> {
    this.logger.debug('Initializing session info service');
    await this.sessionInfoService.initialize();
    serviceRegistry.markInitialized('SessionInfoService');
    this.logger.debug('Session info service initialized successfully');

    this.logger.debug('Initializing pending question service');
    await this.pendingQuestionService.initialize();
    serviceRegistry.markInitialized('PendingQuestionService');
    this.logger.debug('Pending question service initialized successfully');
  }

  private initializeProcessSupportServices(): void {
    // Message lifecycle (archival) removed — harness_events is the single store.
  }

  private async initializeAiServicesAndInsights(): Promise<void> {
    this.logger.debug('Initializing Gemini service');
    await geminiService.initialize();
    serviceRegistry.markInitialized('GeminiService');
    this.logger.debug('Gemini service initialized successfully');

    this.logger.debug('Initializing Anthropic service');
    await anthropicService.initialize();
    serviceRegistry.markInitialized('AnthropicService');
    this.logger.debug('Anthropic service initialized successfully');

    this.wireCreditStatusEvents();
    await this.initializeCostTracker();
  }

  private applyResolvedServerConfig(config: ReturnType<ConfigService['getConfig']>): void {
    // Apply overrides if provided (for tests and CLI options).
    this.port = this.configOverrides?.port ?? config.server.port;
    this.host = this.configOverrides?.host ?? config.server.host;
    this.configService.setRuntimeServerPort(this.port);

    this.logger.info('Configuration loaded', {
      port: this.port,
      host: this.host,
      overrides: this.configOverrides ? Object.keys(this.configOverrides) : []
    });
  }

  private async setupRoutesAndStateLogging(): Promise<void> {
    this.logger.debug('Setting up routes');
    await this.setupHarness();
    await this.initializeInsightsAndQueueDispatch();
    this.setupRoutes();
  }

  /**
   * Stop every Claude process a daemon that outlived the previous server still
   * runs. This server has no subscription to any of them, so one mid-turn
   * would go on reading files, running commands and committing with nothing
   * reaching its transcript (seen 2026-09-26: a fixture wrote its marker file
   * a minute after a restart, invisible in its thread). The recovery sweep
   * then closes the sessions, and the ones cut off mid-turn are carried on by
   * a fresh process that resumes from the provider's own history.
   */
  private async stopOrphanedDaemonProcesses(client: ProcessManagerClient): Promise<void> {
    const orphans = await client.getActiveSessions();
    if (orphans.length === 0) return;
    const results = await Promise.allSettled(orphans.map((o) => client.stopConversation(o.streamingId)));
    const failed = orphans.filter((_, i) => results[i].status === 'rejected');
    this.logger.info('Stopped Claude processes left from the previous server', {
      stopped: orphans.length - failed.length,
      failed: failed.map((o) => o.streamingId),
      sessions: orphans.map((o) => o.sessionId),
    });
  }

  private async setupHarness(): Promise<void> {
    const { socketPath, spawned, child } = await ensureDaemon();
    this.spawnedDaemonChild = child;
    this.logger.info('Daemon reachable', { socketPath, spawned });

    // The daemon can die under a running server (2026-09-27: an uncaught
    // spawn error stopped it); without a new one every session stays down.
    const client = new ProcessManagerClient(socketPath, {
      revive: async () => {
        const revived = await ensureDaemon();
        if (!revived.spawned) return;
        this.spawnedDaemonChild = revived.child;
        this.logger.warn('Process daemon had stopped; started a new one', { socketPath: revived.socketPath, pid: revived.child?.pid });
      },
    });
    await client.connect();
    this.processManagerClient = client;
    this.logger.info('Harness daemon client connected');
    if (!spawned) await this.stopOrphanedDaemonProcesses(client);
    // A daemon restart under a running server ends every Claude process; the
    // sessions it cut off are carried on once it answers again.
    client.on('daemon-reconnected', () => { void carryOnAfterDaemonReconnect(); });

    // Install the SDK permission bridge so `can_use_tool` control requests
    // (emitted by the CLI in non-default permission modes — see
    // process-daemon.ts#applyPermissionMode) get routed through the
    // existing PermissionTracker / banner / allowlist machinery instead
    // of being silently auto-denied. See services/sdk-permission-bridge.ts
    // for the rationale.
    this.claudeQuestionCoordinator = new ClaudeQuestionCoordinator(client, this.pendingQuestionService, this.permissionTracker);
    setupSdkPermissionBridge(client, this.permissionTracker, this.claudeQuestionCoordinator);

    const conversationService = ConversationService.getInstance();
    this.harnessRuntime = setupHarness({
      app: this.app,
      processManagerClient: client,
      resolveResumeSessionId: (conversationId: string) => {
        const conversation = conversationService.getConversation(conversationId);
        if (!conversation || conversation.segments.length === 0) return conversationId;
        const latest = conversation.segments[conversation.segments.length - 1];
        const psid = latest.providerSessionId;
        if (!psid || psid.startsWith('pending-')) {
          this.logger.warn('[RESUME] Segment has stale pending- providerSessionId', {
            conversationId: conversationId.slice(0, 12),
            providerSessionId: psid?.slice(0, 16) ?? 'null',
            segmentId: latest.segmentId,
          });
          return conversationId;
        }
        this.logger.debug('[RESUME] Resolved provider session ID', {
          conversationId: conversationId.slice(0, 12),
          providerSessionId: psid.slice(0, 8),
        });
        return psid;
      },
      resolveWorkingDirectory: (conversationId: string) => {
        const conversation = conversationService.getConversation(conversationId);
        return conversation?.workingDirectory;
      },
      classifyResumeTranscript: (providerSessionId: string) =>
        this.historyReader.classifyTranscript(providerSessionId),
      activeConversationRegistry: this.activeConversationRegistry,
      pendingQuestionService: this.pendingQuestionService,
    });
    this.logger.info('Harness integration initialized');

    // Pre-cutover conversations have no harness events and would render empty.
    // Awaited here, before the HTTP listener starts, so no request can observe
    // a half-migrated store.
    await migrateLegacyHistoryToEvents(
      DatabaseProvider.getInstance().getDb(),
      this.harnessRuntime.eventStorage,
    );

    // Drain accumulated WAL debt while blocking is still harmless (no HTTP
    // listener yet). The 30s PASSIVE timer alone cannot keep up once the WAL
    // has ballooned — see drainWal() for the full rationale.
    DatabaseProvider.getInstance().drainWal();
  }

  private ensureManagedClaudeHooks(): void {
    const baseUrl = `http://localhost:${this.port}`;
    const authToken = this.configService.getConfig().server.authToken;
    const changed = this.managedClaudeHooksService.ensureHooks({
      baseUrl,
      authToken,
    });

    // Loud warning if hooks were pointing to wrong port — this is the #1 cause
    // of ASK mode permissions silently not working. See memory/permission-delivery.md.
    if (changed.permissionRequestChanged || changed.preToolUseChanged) {
      this.logger.warn(
        'Claude hook URLs were stale and have been corrected. ' +
        'ASK mode permissions would have silently failed without this fix.',
        { baseUrl, changed }
      );
    } else {
      this.logger.debug('Ensured managed Claude hook registration', { baseUrl, changed });
    }
  }


  private wireCreditStatusEvents(): void {
    if (LatticeServer.creditStatusEventsWired) {
      this.logger.debug('Credit status events already wired; skipping duplicate listeners');
      return;
    }
    LatticeServer.creditStatusEventsWired = true;

    // Wire credit status changes to SSE broadcast.
    anthropicService.on('credits-exhausted', (data: { since: string }) => {
      void import('./services/sessions/session-activity-watcher.js').then(({ getSessionActivityWatcher }) => {
        getSessionActivityWatcher().emitApiHealth({ creditsExhausted: true, since: data.since });
      });
    });
    anthropicService.on('credits-available', () => {
      void import('./services/sessions/session-activity-watcher.js').then(({ getSessionActivityWatcher }) => {
        getSessionActivityWatcher().emitApiHealth({ creditsExhausted: false });
      });
    });
  }

  private async initializeCostTracker(): Promise<void> {
    this.logger.debug('Initializing cost tracker');
    const { getCostTracker } = await import('./services/infrastructure/cost-tracker.js');
    await getCostTracker().initialize();
    serviceRegistry.markInitialized('CostTracker');
    this.logger.debug('Cost tracker initialized successfully');
  }

  private async initializeSessionSummaryScheduler(): Promise<void> {
    this.logger.debug('Initializing session summary scheduler');
    const { SessionSummaryService } = await import('./services/sessions/session-summary-service.js');
    const service = SessionSummaryService.getInstance();
    await service.initialize();

    // Fire one tick immediately so a server restart picks up any backlog from
    // sessions that ended during downtime. Subsequent ticks via setInterval.
    // Both paths are guarded by the service's tickInFlight flag — overlapping
    // ticks no-op rather than queue up.
    void service.runScheduledTick().catch((err) => {
      this.logger.error('Initial session-summary tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.summaryTickHandle = setInterval(() => {
      void service.runScheduledTick().catch((err) => {
        this.logger.error('Session-summary tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, LatticeServer.SUMMARY_TICK_INTERVAL_MS);

    this.logger.info('Session summary scheduler started', {
      intervalMin: LatticeServer.SUMMARY_TICK_INTERVAL_MS / 60_000,
    });
  }

  private initializeAutoArchiveSweep(): void {
    this.logger.debug('Initializing auto-archive sweep');

    const runSweep = async (label: string): Promise<void> => {
      const { AutoArchiveService } = await import('./services/sessions/auto-archive-service.js');
      const archived = AutoArchiveService.getInstance().runSweep();
      this.logger.debug('Auto-archive sweep completed', { label, archived });
    };

    // Sweep once on boot so sessions that crossed the cutoff while the server
    // was down are archived immediately rather than up to an hour later.
    void runSweep('boot').catch((err) => {
      this.logger.error('Initial auto-archive sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.autoArchiveTickHandle = setInterval(() => {
      void runSweep('interval').catch((err) => {
        this.logger.error('Auto-archive sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, LatticeServer.AUTO_ARCHIVE_TICK_INTERVAL_MS);

    this.logger.info('Auto-archive sweep started', {
      intervalMin: LatticeServer.AUTO_ARCHIVE_TICK_INTERVAL_MS / 60_000,
    });
  }

  /**
   * Waiting workers whose process has exited, or that armed nothing, would
   * otherwise sleep until someone noticed. The report-time check catches most;
   * this catches a process that dies later. See wait-watch.ts.
   */
  private initializeWaitWatch(): void {
    this.waitWatchTickHandle = setInterval(() => {
      void (async () => {
        const { checkAllWaitingWorkers } = await import('./services/sessions/wait-watch.js');
        await checkAllWaitingWorkers();
      })().catch((err) => {
        this.logger.error('Wait watch failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, LatticeServer.WAIT_WATCH_TICK_INTERVAL_MS);
  }

  private initializeIdleSessionReaper(): void {
    this.idleReapTickHandle = setInterval(() => {
      void (async () => {
        const { reapIdleSessions } = await import('./services/sessions/idle-session-reaper.js');
        const result = await reapIdleSessions(this.sessionInfoService);
        if (result.reaped.length > 0) {
          this.logger.info('Idle session reap completed', {
            examined: result.examined,
            reaped: result.reaped,
          });
        }
      })().catch((err) => {
        this.logger.error('Idle session reap failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, LatticeServer.IDLE_REAP_TICK_INTERVAL_MS);

    this.logger.info('Idle session reaper started', {
      intervalMin: LatticeServer.IDLE_REAP_TICK_INTERVAL_MS / 60_000,
    });
  }

  private async initializeInsightsAndQueueDispatch(): Promise<void> {
    // InsightsEngine is a singleton — it reads harness events directly from the shared DB.
    // No initialization needed; turn:end events call InsightsEngine.getInstance().onTurnEnd()
    // via the event-persistence callback.
    this.logger.debug('InsightsEngine available (harness-event-driven via event-persistence callback)');
    serviceRegistry.markInitialized('InsightsCoordinator');

    const teamWatcher = getTeamWatcherService();
    teamWatcher.start();
    this.logger.debug('Team watcher service started at server boot');
  }


  /**
   * Start the server
   */
  async start(): Promise<void> {
    this.logger.debug('Start method called');
    try {
      // Initialize all services
      await this.initialize();

      // Start Express server
      const isDev = servesViteDevClient;
      this.logger.debug('Creating HTTP server listener', { 
        useViteExpress: isDev,
        environment: process.env.NODE_ENV 
      });

      await this.ensureViteExpressLoaded(isDev);
      await this.startHttpListener(isDev);

      // Anything the previous process left unread in a session's inbox (a
      // worker's report, a user's message to a mid-turn Codex session) goes
      // out now that the send route is reachable.
      // First the held deliveries whose processes the restart ended are
      // settled from the transcripts, and the compactions it cut off start
      // again, so the drain neither skips a lost message nor sends into a
      // context that was about to be compacted. Then workers whose report
      // waits on a restart (this one) get a note, which the drain delivers.
      void settleHeldDeliveries()
        .then(() => rerunCutOffCompactions())
        .then(() => wakeRestartWaiters())
        .then(() => drainAllInboxes());

    } catch (error) {
      this.logger.error('Failed to start server:', error, {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      
      // Attempt cleanup on startup failure
      await this.cleanup();
      
      if (error instanceof LatticeError) {
        throw error;
      } else {
        throw new LatticeError('SERVER_START_FAILED', `Server startup failed: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }
  }

  private async ensureViteExpressLoaded(isDev: boolean): Promise<void> {
    if (!isDev || ViteExpress) {
      return;
    }

    const viteExpressModule = await import('vite-express');
    ViteExpress = viteExpressModule.default;
  }

  private async startHttpListener(isDev: boolean): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (isDev && ViteExpress) {
        this.listenInDevelopmentMode(resolve, reject);
      } else {
        this.listenInStandardMode(resolve);
      }

      this.attachStartupErrorHandler(reject);
    });
  }

  private listenInDevelopmentMode(resolve: () => void, reject: (error: unknown) => void): void {
    try {
      this.server = this.app.listen(this.port, this.host, () => {
        this.logger.debug('Server successfully bound to port (dev mode)', {
          port: this.port,
          host: this.host,
          address: this.server?.address()
        });

        this.logServerStartup();
        this.writeAgentCli();
        this.configureViteExpressBinding();
        this.logger.info(`Lattice development server running on http://${this.host}:${this.port}`);
        resolve();
      });
    } catch (error) {
      this.logger.error('Failed to start ViteExpress server', error);
      reject(error);
    }
  }

  private listenInStandardMode(resolve: () => void): void {
    this.server = this.app.listen(this.port, this.host, () => {
      this.logger.debug('Server successfully bound to port', {
        port: this.port,
        host: this.host,
        address: this.server?.address(),
        mode: process.env.NODE_ENV || 'production'
      });

      this.logServerStartup();
      this.writeAgentCli();
      resolve();
    });
  }

  /** The `lattice` command agents dispatch with (agent-cli.ts), and the skills that name it (agent-skills.ts). */
  private writeAgentCli(): void {
    try {
      writeAgentSkills(latticeCli());
    } catch (error) {
      this.logger.error('Failed to write the skills Lattice ships to sessions', error, { path: AGENT_SKILLS_DIR });
    }
    if (process.env.LATTICE_CLI?.trim()) return;
    const address = this.server?.address();
    const port = address && typeof address === 'object' ? address.port : this.port;
    try {
      if (writeAgentCli({ host: this.host, port })) {
        this.logger.info('Agent CLI written', { path: AGENT_CLI_PATH, port });
      } else {
        this.logger.warn('Agent CLI not written: a file Lattice did not generate is already there', { path: AGENT_CLI_PATH });
      }
    } catch (error) {
      this.logger.error('Failed to write the agent CLI; coordinators cannot dispatch workers', error, { path: AGENT_CLI_PATH });
    }
  }

  private configureViteExpressBinding(): void {
    ViteExpress!.config({
      mode: 'development',
      viteConfigFile: 'vite.config.mts'
    });
    void ViteExpress!.bind(this.app, this.server!);
  }

  private logServerStartup(): void {
    displayServerStartup({
      host: this.host,
      port: this.port,
      tailscaleIp: this.configService.getConfig().server.tailscaleIp,
      tailscaleServe: this.configService.getConfig().server.tailscaleServe,
      logger: this.logger
    });
  }

  private attachStartupErrorHandler(reject: (error: unknown) => void): void {
    if (!this.server) {
      return;
    }

    this.server.on('error', (error: Error) => {
      this.logger.error('Failed to start HTTP server:', error, {
        errorCode: (error as NodeJS.ErrnoException).code,
        errorSyscall: (error as NodeJS.ErrnoException).syscall,
        port: this.port,
        host: this.host
      });
      reject(new LatticeError('HTTP_SERVER_START_FAILED', `Failed to start HTTP server: ${error.message}`, 500));
    });
  }

  /**
   * Stop the server gracefully
   */
  async stop(): Promise<void> {
    this.logger.debug('Stop method called', {
      hasServer: !!this.server,
    });

    this.stopBackgroundServices();
    await this.closeHttpServer();
    this.stopSpawnedDaemon();
  }

  private stopSpawnedDaemon(): void {
    const child = this.spawnedDaemonChild;
    if (!child) return;
    this.spawnedDaemonChild = null;
    try {
      child.kill('SIGTERM');
      this.logger.info('Sent SIGTERM to spawned daemon child', { pid: child.pid });
    } catch (err) {
      this.logger.warn('Failed to stop spawned daemon child', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private stopBackgroundServices(): void {
    getTeamWatcherService().stop();
    if (this.summaryTickHandle) {
      clearInterval(this.summaryTickHandle);
      this.summaryTickHandle = null;
    }
    if (this.autoArchiveTickHandle) {
      clearInterval(this.autoArchiveTickHandle);
      this.autoArchiveTickHandle = null;
    }
    if (this.waitWatchTickHandle) {
      clearInterval(this.waitWatchTickHandle);
      this.waitWatchTickHandle = null;
    }
    if (this.idleReapTickHandle) {
      clearInterval(this.idleReapTickHandle);
      this.idleReapTickHandle = null;
    }
  }

  private async closeHttpServer(): Promise<void> {
    if (!this.server) {
      return;
    }

    this.logger.debug('Closing HTTP server');

    // Force close all connections after ending SSE streams.
    // This ensures we don't wait for clients that haven't acknowledged the close.
    if (typeof this.server.closeAllConnections === 'function') {
      this.server.closeAllConnections();
    }

    // Close with timeout - don't block shutdown forever.
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.warn('HTTP server close timed out after 2s, forcing shutdown');
        resolve();
      }, 2000);

      this.server!.close(() => {
        clearTimeout(timeout);
        this.logger.info('HTTP server closed successfully');
        resolve();
      });
    });
  }

  /**
   * Cleanup resources during failed startup
   */
  private async cleanup(): Promise<void> {
    this.logger.info('Performing cleanup after startup failure...');
    this.logger.debug('Cleanup initiated', {
      hasServer: !!this.server,
    });

    try {
      stopEventLoopMonitor();
      getTeamWatcherService().stop();

      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server!.close(() => {
            this.logger.info('HTTP server closed during cleanup');
            resolve();
          });
        });
      }

      this.logger.info('Cleanup completed');
    } catch (error) {
      this.logger.error('Error during cleanup:', error, {
        errorType: error instanceof Error ? error.constructor.name : typeof error
      });
    }
  }

  private setupMiddleware(): void {
    this.app.use(createCorsMiddleware());
    // Harness start/send carry composer attachments as base64 inside the JSON
    // body. The toolkit composer caps a message at 20 files x 5MB, which is
    // ~134MB once base64-encoded, so anything the client can legitimately
    // produce fits under this ceiling and never surfaces as an opaque 413.
    // Registered before the global parser because body-parser skips a second
    // parse once req._body is set — the narrower limit would win otherwise.
    this.app.use('/api/harness', express.json({ limit: HARNESS_JSON_BODY_LIMIT }));
    this.app.use(express.json({ limit: '10mb' }));

    // Static file serving
    if (!servesViteDevClient) {
      // In production/test, serve built static files
      // In production, __dirname will be /path/to/node_modules/lattice-app/dist
      // We need to serve from dist/web
      const staticPath = path.join(__dirname, 'web');
      this.logger.debug('Serving static files from', { path: staticPath });
      this.app.use(express.static(staticPath));
    }
    // In development, ViteExpress handles static file serving
    
    // Request logging
    this.app.use(requestLogger);

    // Query parameter parsing - convert strings to proper types
    this.app.use(queryParser);

    // Bearer token auth — only active when server.authToken is set in config.
    // Cloud deployments inject a token; local users are unaffected.
    this.app.use(createAuthMiddleware());

  }

  private setupRoutes(): void {
    registerAppRoutes({
      app: this.app,
      logger: this.logger,
      frontendDir: path.join(__dirname, 'web'),
      historyReader: this.historyReader,
      activeConversationRegistry: this.activeConversationRegistry,
      processManagerClient: this.processManagerClient,
      conversationService: ConversationService.getInstance(),
      permissionTracker: this.permissionTracker,
      pendingQuestionService: this.pendingQuestionService,
      codexRequestCoordinator: this.harnessRuntime?.codexRequestCoordinator,
      claudeQuestionCoordinator: this.claudeQuestionCoordinator,
      fileSystemService: this.fileSystemService,
      configService: this.configService,
      sessionInfoService: this.sessionInfoService,
      workingDirectoriesService: this.workingDirectoriesService,
      harnessSessionManager: this.harnessRuntime?.sessionManager,
    });
  }

}
