import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../infrastructure/logger.js';
import { parseJson } from '../../utils/json.js';

interface TeamMember {
  agentId: string;
  name: string;
  agentType: string;
  model: string;
  joinedAt: number;
  tmuxPaneId: string;
  cwd: string;
  subscriptions: string[];
  backendType?: string;
  prompt?: string;
  color?: string;
  planModeRequired?: boolean;
}

interface TeamConfig {
  name: string;
  description?: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: TeamMember[];
}

interface TaskStatus {
  pending: number;
  in_progress: number;
  completed: number;
}

interface InboxMessage {
  from: string;
  text: string;
  summary?: string;
  timestamp?: string;
  color?: string;
  read?: boolean;
}

interface InboxSummary {
  agentName: string;
  messageCount: number;
  unreadCount: number;
  latestTimestamp: string | null;
}

interface AgentCompletion {
  agentName: string;
  /** Whether this agent has sent a message to the lead (reliable completion signal) */
  deliveredToLead: boolean;
  /** Number of messages this agent sent to the lead */
  messagesDelivered: number;
}

interface TeamUpdate {
  teamName: string;
  leadSessionId: string;
  memberCount: number;
  tasks: TaskStatus;
  config: TeamConfig;
  inboxSummaries?: InboxSummary[];
  /** Per-agent completion derived from lead inbox messages (not task files) */
  agentCompletions?: AgentCompletion[];
  timestamp: number;
}

interface TeamRemoved {
  teamName: string;
  timestamp: number;
}

interface TeamInboxUpdate {
  teamName: string;
  agentName: string;
  newMessages: InboxMessage[];
  newMessageCount: number;
  totalMessages: number;
  unreadCount: number;
  latestTimestamp: string | null;
  timestamp: number;
}

function isTeamConfig(value: unknown): value is TeamConfig {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === 'string'
    && typeof record.leadSessionId === 'string'
    && Array.isArray(record.members)
  );
}

function isInboxMessage(value: unknown): value is InboxMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;

  if (typeof record.from !== 'string' || typeof record.text !== 'string') {
    return false;
  }
  if (record.summary !== undefined && typeof record.summary !== 'string') {
    return false;
  }
  if (record.timestamp !== undefined && typeof record.timestamp !== 'string') {
    return false;
  }
  if (record.color !== undefined && typeof record.color !== 'string') {
    return false;
  }
  if (record.read !== undefined && typeof record.read !== 'boolean') {
    return false;
  }

  return true;
}

/**
 * Watches ~/.claude/teams/ and ~/.claude/tasks/ for Agent Teams activity.
 * Emits events when teams are created, updated, removed, or receive inbox updates.
 */
export class TeamWatcherService extends EventEmitter {
  private logger = createLogger('TeamWatcherService');
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private teamsDir: string;
  private tasksDir: string;
  private isWatching = false;
  private inboxMessageCounts: Map<string, number> = new Map();
  private lastPollSnapshot: Map<string, number> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  /** Track which teams we've already emitted a zombie event for (avoid repeat kills). */
  private zombieEmitted: Set<string> = new Set();
  /** Remember completed team lead sessions so zombie check works after TeamDelete removes files. */
  private completedTeamLeads: Map<string, { leadSessionId: string; completedAt: number }> = new Map();
  private projectsDir: string;

  /** Consecutive ticks that found no teams and no pending zombie checks. */
  private emptyPollTicks = 0;
  /** Interval the poll timer is currently running at. */
  private currentPollIntervalMs = 0;

  // Debounce file changes to avoid rapid-fire updates.
  private readonly DEBOUNCE_MS = 100;
  // Poll fallback for environments where fs.watch misses events (e.g. WSL2).
  private readonly POLL_INTERVAL_MS = 5000;
  /**
   * Backoff interval used once the poll has found nothing for a while. Agent
   * Teams are rare; without this the watcher walked ~/.claude/teams, every
   * team inbox, and (via the zombie check) ~/.claude/projects every 5s for the
   * life of the server even on machines that have never created a team.
   */
  private readonly IDLE_POLL_INTERVAL_MS = 60_000;
  /** Empty ticks tolerated at the fast interval before backing off. */
  private readonly IDLE_POLL_THRESHOLD = 3;
  // How long a lead session's JSONL must be idle before we consider it a zombie.
  private readonly ZOMBIE_STALE_MS = 30_000;

  constructor() {
    super();
    this.teamsDir = path.join(os.homedir(), '.claude', 'teams');
    this.tasksDir = path.join(os.homedir(), '.claude', 'tasks');
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');

    // An SSE consumer subscribing to team events wants fresh state now, not up
    // to a minute from now. 'newListener' fires before the listener is added.
    this.on('newListener', (event: string | symbol) => {
      if (event === 'team-updated' || event === 'team-removed' || event === 'team-inbox-update') {
        this.resumeFastPolling();
      }
    });
  }

  /**
   * Start watching for team and task changes.
   */
  start(): void {
    if (this.isWatching) return;

    this.logger.info('Starting team watcher service', {
      teamsDir: this.teamsDir,
      tasksDir: this.tasksDir
    });

    try {
      // Ensure directories exist.
      if (!fs.existsSync(this.teamsDir)) {
        fs.mkdirSync(this.teamsDir, { recursive: true });
        this.logger.debug('Created teams directory', { dir: this.teamsDir });
      }
      if (!fs.existsSync(this.tasksDir)) {
        fs.mkdirSync(this.tasksDir, { recursive: true });
        this.logger.debug('Created tasks directory', { dir: this.tasksDir });
      }

      // Scan existing teams and emit initial state.
      this.scanExistingTeams();

      // Watch top-level directories.
      this.watchDirectory(this.teamsDir, 'teams');
      this.watchDirectory(this.tasksDir, 'tasks');

      // Watch existing team directories for config/inbox changes.
      if (fs.existsSync(this.teamsDir)) {
        const teams = fs.readdirSync(this.teamsDir);
        for (const team of teams) {
          const teamPath = path.join(this.teamsDir, team);
          if (!this.isDirectory(teamPath)) continue;
          this.watchTeamDirectory(teamPath, team);
          this.scanExistingInboxes(team);
        }
      }

      // Watch existing task directories for task file changes.
      if (fs.existsSync(this.tasksDir)) {
        const taskDirs = fs.readdirSync(this.tasksDir);
        for (const taskDir of taskDirs) {
          const taskPath = path.join(this.tasksDir, taskDir);
          if (!this.isDirectory(taskPath)) continue;
          this.watchTaskDirectory(taskPath, taskDir);
        }
      }

      this.startPolling();
      this.isWatching = true;
      this.logger.info('Team watcher service started', {
        watcherCount: this.watchers.size
      });
    } catch (error) {
      this.logger.error('Failed to start team watcher service', error);
    }
  }

  /**
   * Stop watching.
   */
  stop(): void {
    this.logger.info('Stopping team watcher service');

    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.currentPollIntervalMs = 0;
    this.emptyPollTicks = 0;

    this.lastPollSnapshot.clear();
    this.isWatching = false;
  }

  /**
   * Scan existing teams and emit initial state for each.
   */
  private scanExistingTeams(): void {
    if (!fs.existsSync(this.teamsDir)) return;

    try {
      const teams = fs.readdirSync(this.teamsDir);
      for (const team of teams) {
        const teamPath = path.join(this.teamsDir, team);
        if (!this.isDirectory(teamPath)) continue;
        this.scanExistingInboxes(team);
        void this.emitTeamUpdate(team);
      }
    } catch (error) {
      this.logger.warn('Failed to scan existing teams', { error });
    }
  }

  /**
   * Watch a top-level directory for changes.
   */
  private watchDirectory(dirPath: string, label: string): void {
    if (this.watchers.has(dirPath)) return;

    try {
      const watcher = fs.watch(dirPath, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;

        const fullPath = path.join(dirPath, filename);

        if (label === 'teams') {
          if (fs.existsSync(fullPath) && this.isDirectory(fullPath)) {
            this.logger.debug('New team directory detected', { teamName: filename });
            this.watchTeamDirectory(fullPath, filename);
            this.scanExistingInboxes(filename);
            void this.emitTeamUpdate(filename);
          } else if (!fs.existsSync(fullPath)) {
            this.logger.debug('Team directory removed', { teamName: filename });
            void this.emitTeamRemoved(filename);
          }
          return;
        }

        if (label === 'tasks' && fs.existsSync(fullPath) && this.isDirectory(fullPath)) {
          this.logger.debug('New task directory detected', { teamName: filename });
          this.watchTaskDirectory(fullPath, filename);
          void this.emitTeamUpdate(filename);
        }
      });

      this.watchers.set(dirPath, watcher);
      this.logger.debug(`Watching ${label} directory`, { dirPath });
    } catch (error) {
      this.logger.warn(`Failed to watch ${label} directory`, { dirPath, error });
    }
  }

  /**
   * Watch a specific team directory for config and inbox-directory changes.
   */
  private watchTeamDirectory(teamPath: string, teamName: string): void {
    const watchKey = `team-${teamPath}`;
    if (this.watchers.has(watchKey)) return;

    try {
      const watcher = fs.watch(teamPath, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;

        if (filename === 'config.json') {
          this.logger.debug('Team config changed', { teamName, filename });
          this.handleTeamChange(teamName);
          return;
        }

        if (filename === 'inboxes') {
          const inboxDir = path.join(teamPath, 'inboxes');
          if (this.isDirectory(inboxDir)) {
            this.logger.debug('Team inbox directory changed', { teamName });
            this.watchInboxDirectory(inboxDir, teamName);
            this.scanExistingInboxes(teamName);
          }
        }
      });

      this.watchers.set(watchKey, watcher);
      this.logger.debug('Watching team directory', { teamPath, teamName });

      const inboxDir = path.join(teamPath, 'inboxes');
      if (this.isDirectory(inboxDir)) {
        this.watchInboxDirectory(inboxDir, teamName);
      }
    } catch (error) {
      this.logger.warn('Failed to watch team directory', { teamPath, error });
    }
  }

  /**
   * Watch a specific task directory for task file changes.
   */
  private watchTaskDirectory(taskPath: string, teamName: string): void {
    const watchKey = `task-${taskPath}`;
    if (this.watchers.has(watchKey)) return;

    try {
      const watcher = fs.watch(taskPath, { persistent: false }, (_eventType, filename) => {
        if (!filename || !filename.endsWith('.json')) return;

        this.logger.debug('Task file changed', { teamName, filename });
        this.handleTeamChange(teamName);
      });

      this.watchers.set(watchKey, watcher);
      this.logger.debug('Watching task directory', { taskPath, teamName });
    } catch (error) {
      this.logger.warn('Failed to watch task directory', { taskPath, error });
    }
  }

  /**
   * Watch a team inbox directory for inbox message changes.
   */
  private watchInboxDirectory(inboxPath: string, teamName: string): void {
    const watchKey = `inbox-${inboxPath}`;
    if (this.watchers.has(watchKey)) return;

    try {
      const watcher = fs.watch(inboxPath, { persistent: false }, (_eventType, filename) => {
        if (!filename || !filename.endsWith('.json')) return;

        const agentName = path.basename(filename, '.json');
        if (!agentName) return;

        this.logger.debug('Inbox file changed', { teamName, agentName, filename });
        this.handleInboxChange(teamName, agentName);
      });

      this.watchers.set(watchKey, watcher);
      this.logger.debug('Watching inbox directory', { inboxPath, teamName });
    } catch (error) {
      this.logger.warn('Failed to watch inbox directory', { inboxPath, teamName, error });
    }
  }

  /**
   * Scan existing inbox files for a team and initialize message counts.
   */
  private scanExistingInboxes(teamName: string): void {
    const inboxDir = path.join(this.teamsDir, teamName, 'inboxes');
    if (!this.isDirectory(inboxDir)) return;

    this.watchInboxDirectory(inboxDir, teamName);

    try {
      const inboxFiles = fs.readdirSync(inboxDir).filter(file => file.endsWith('.json'));
      for (const inboxFile of inboxFiles) {
        const agentName = path.basename(inboxFile, '.json');
        if (!agentName) continue;
        void this.readAndEmitInbox(teamName, agentName, { emitExisting: true });
      }
    } catch (error) {
      this.logger.debug('Failed to scan existing inboxes', { teamName, error });
    }
  }

  /**
   * Handle a team change with debouncing.
   */
  private handleTeamChange(teamName: string): void {
    this.scheduleDebounced(`team:${teamName}`, () => {
      void this.emitTeamUpdate(teamName);
    });
  }

  /**
   * Handle an inbox change with debouncing.
   */
  private handleInboxChange(teamName: string, agentName: string): void {
    const inboxKey = this.getInboxKey(teamName, agentName);
    this.scheduleDebounced(`inbox:${inboxKey}`, () => {
      void this.readAndEmitInbox(teamName, agentName).then(() => {
        this.handleTeamChange(teamName);
      });
    });
  }

  /**
   * Schedule a debounced callback under a key.
   */
  private scheduleDebounced(key: string, callback: () => void): void {
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      callback();
    }, this.DEBOUNCE_MS));
  }

  /**
   * Read an inbox file and emit a delta event when new messages appear.
   */
  private async readAndEmitInbox(
    teamName: string,
    agentName: string,
    options: { emitExisting?: boolean } = {}
  ): Promise<void> {
    try {
      const messages = await this.getInboxMessages(teamName, agentName);
      const inboxKey = this.getInboxKey(teamName, agentName);
      const currentCount = messages.length;
      const previousCount = this.inboxMessageCounts.get(inboxKey);
      const baseline = previousCount === undefined
        ? (options.emitExisting ? 0 : currentCount)
        : previousCount;

      this.inboxMessageCounts.set(inboxKey, currentCount);

      if (currentCount <= baseline) {
        return;
      }

      const newMessages = messages.slice(baseline);
      const unreadCount = messages.filter((message) => message.read !== true).length;
      const latestTimestamp = this.getLatestTimestamp(messages);

      const update: TeamInboxUpdate = {
        teamName,
        agentName,
        newMessages,
        newMessageCount: newMessages.length,
        totalMessages: currentCount,
        unreadCount,
        latestTimestamp,
        timestamp: Date.now(),
      };

      this.logger.info('Emitting team-inbox-update event', {
        teamName,
        agentName,
        newMessageCount: update.newMessageCount,
        totalMessages: update.totalMessages,
        listenerCount: this.listenerCount('team-inbox-update'),
      });

      this.emit('team-inbox-update', update);
    } catch (error) {
      this.logger.debug('Failed to read and emit inbox update', { teamName, agentName, error });
    }
  }

  /**
   * Start poll-based fallback for environments where fs.watch is unreliable.
   */
  private startPolling(): void {
    if (this.pollingInterval) return;

    this.emptyPollTicks = 0;
    this.schedulePolling(this.POLL_INTERVAL_MS);

    this.logger.debug('Started poll fallback for team watcher', {
      intervalMs: this.POLL_INTERVAL_MS,
    });
  }

  /** (Re)arm the poll timer at a given interval. */
  private schedulePolling(intervalMs: number): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.currentPollIntervalMs = intervalMs;
    this.pollingInterval = setInterval(() => {
      this.pollForChanges();
    }, intervalMs);

    if (typeof this.pollingInterval.unref === 'function') {
      this.pollingInterval.unref();
    }
  }

  /**
   * Snap back to the fast interval — a team appeared, or a consumer subscribed.
   */
  private resumeFastPolling(): void {
    this.emptyPollTicks = 0;
    if (!this.pollingInterval) return;
    if (this.currentPollIntervalMs === this.POLL_INTERVAL_MS) return;

    this.logger.debug('Team watcher poll returning to fast interval', {
      intervalMs: this.POLL_INTERVAL_MS,
    });
    this.schedulePolling(this.POLL_INTERVAL_MS);
  }

  /** Count an idle tick and back off once enough of them pile up. */
  private noteEmptyPollTick(): void {
    this.emptyPollTicks++;
    if (!this.pollingInterval) return;
    if (this.currentPollIntervalMs === this.IDLE_POLL_INTERVAL_MS) return;
    if (this.emptyPollTicks < this.IDLE_POLL_THRESHOLD) return;

    this.logger.debug('No teams found; backing off team watcher poll', {
      emptyTicks: this.emptyPollTicks,
      intervalMs: this.IDLE_POLL_INTERVAL_MS,
    });
    this.schedulePolling(this.IDLE_POLL_INTERVAL_MS);
  }

  /**
   * Cheap probe: does ~/.claude/teams contain at least one team directory?
   * One readdir, no per-team stat calls.
   */
  private hasTeamDirectories(): boolean {
    try {
      const entries = fs.readdirSync(this.teamsDir, { withFileTypes: true });
      return entries.some(entry => entry.isDirectory() || entry.isSymbolicLink());
    } catch {
      return false;
    }
  }

  /**
   * Poll team config and inbox files for mtime changes.
   */
  private pollForChanges(): void {
    // Early-out before any per-team work. On a machine with no teams the rest
    // of this tick is pure waste: a teams readdir, an inbox readdir + statSync
    // per team, and a zombie check that walks ~/.claude/projects.
    const hasTeams = this.hasTeamDirectories();
    if (hasTeams) {
      this.resumeFastPolling();
    } else {
      // A team that TeamDelete removed still needs its post-delete zombie
      // check, so keep ticking — just at the backed-off rate.
      this.noteEmptyPollTick();
      if (this.completedTeamLeads.size === 0) return;
    }

    if (!fs.existsSync(this.teamsDir)) {
      return;
    }

    try {
      const teams = fs.readdirSync(this.teamsDir);
      for (const teamName of teams) {
        const teamPath = path.join(this.teamsDir, teamName);
        if (!this.isDirectory(teamPath)) continue;

        const teamWatchKey = `team-${teamPath}`;
        if (!this.watchers.has(teamWatchKey)) {
          this.watchTeamDirectory(teamPath, teamName);
          this.scanExistingInboxes(teamName);
          void this.emitTeamUpdate(teamName);
        }

        const taskPath = path.join(this.tasksDir, teamName);
        if (this.isDirectory(taskPath)) {
          this.watchTaskDirectory(taskPath, teamName);
        }

        const configPath = path.join(teamPath, 'config.json');
        if (this.checkFileChanged(configPath)) {
          this.logger.debug('Poll detected team config change', { teamName });
          this.handleTeamChange(teamName);
        }

        const inboxDir = path.join(teamPath, 'inboxes');
        if (!this.isDirectory(inboxDir)) continue;

        this.watchInboxDirectory(inboxDir, teamName);

        const inboxFiles = fs.readdirSync(inboxDir).filter(file => file.endsWith('.json'));
        for (const inboxFile of inboxFiles) {
          const inboxPath = path.join(inboxDir, inboxFile);
          const agentName = path.basename(inboxFile, '.json');
          if (!agentName) continue;

          if (this.checkFileChanged(inboxPath)) {
            this.logger.debug('Poll detected inbox change', { teamName, agentName });
            this.handleInboxChange(teamName, agentName);
          }
        }
      }
      // After scanning all teams, check for zombie lead sessions.
      for (const teamName of teams) {
        const teamPath = path.join(this.teamsDir, teamName);
        if (!this.isDirectory(teamPath)) continue;
        this.checkForZombieLeadSession(teamName);
      }

      // Also check teams that completed and were deleted (TeamDelete removed files).
      for (const [teamName, info] of this.completedTeamLeads) {
        if (this.zombieEmitted.has(teamName)) continue;
        // Only check if team files are gone (otherwise the above loop handles it).
        const teamPath = path.join(this.teamsDir, teamName);
        if (this.isDirectory(teamPath)) continue;
        this.checkForZombieLeadSessionByMemory(teamName, info.leadSessionId);
      }
    } catch (error) {
      this.logger.debug('Poll fallback failed to scan team state', { error });
    }
  }

  /**
   * Detect when a team's lead session is a zombie: all agents have delivered
   * results but the lead process is still alive with no recent JSONL output.
   * Emits 'team-session-zombie' so the server can force-kill the process.
   */
  private checkForZombieLeadSession(teamName: string): void {
    if (this.zombieEmitted.has(teamName)) return;

    try {
      const configPath = path.join(this.teamsDir, teamName, 'config.json');
      if (!fs.existsSync(configPath)) return;

      const configData = fs.readFileSync(configPath, 'utf-8');
      const parsedConfig: unknown = parseJson(configData);
      if (!isTeamConfig(parsedConfig)) return;
      const config = parsedConfig;

      // Check if all agents have delivered to the lead's inbox.
      const completions = this.getAgentCompletions(teamName, config);
      const nonLeadAgents = completions.length;
      if (nonLeadAgents === 0) return;

      const allDelivered = completions.every(a => a.deliveredToLead);
      if (!allDelivered) return;

      // All agents delivered. Check if the lead's JSONL is stale.
      const leadSessionId = config.leadSessionId;
      const jsonlPath = this.findSessionJsonl(leadSessionId);
      if (!jsonlPath) return;

      const mtimeMs = fs.statSync(jsonlPath).mtimeMs;
      const staleMs = Date.now() - mtimeMs;
      if (staleMs < this.ZOMBIE_STALE_MS) return;

      // Lead JSONL is stale and all agents delivered. This is a zombie.
      this.zombieEmitted.add(teamName);
      this.logger.warn('Detected zombie lead session — all agents delivered but lead process stale', {
        teamName,
        leadSessionId: leadSessionId.slice(0, 8),
        staleMs,
        agentsDelivered: nonLeadAgents,
      });

      this.emit('team-session-zombie', {
        teamName,
        leadSessionId,
        staleMs,
        agentsCompleted: nonLeadAgents,
        timestamp: Date.now(),
      });
    } catch (error) {
      this.logger.debug('Failed to check for zombie lead session', { teamName, error });
    }
  }

  /**
   * Memory-based zombie check for teams that were already deleted by TeamDelete.
   * Uses saved completion state instead of reading team config from disk.
   */
  private checkForZombieLeadSessionByMemory(teamName: string, leadSessionId: string): void {
    try {
      const jsonlPath = this.findSessionJsonl(leadSessionId);
      if (!jsonlPath) return;

      const mtimeMs = fs.statSync(jsonlPath).mtimeMs;
      const staleMs = Date.now() - mtimeMs;
      if (staleMs < this.ZOMBIE_STALE_MS) return;

      this.zombieEmitted.add(teamName);
      this.logger.warn('Detected zombie lead session (post-TeamDelete) — team completed but process still alive', {
        teamName,
        leadSessionId: leadSessionId.slice(0, 8),
        staleMs,
      });

      this.emit('team-session-zombie', {
        teamName,
        leadSessionId,
        staleMs,
        agentsCompleted: 0, // Unknown after deletion
        timestamp: Date.now(),
      });

      // Clean up the saved state after emitting.
      this.completedTeamLeads.delete(teamName);
    } catch (error) {
      this.logger.debug('Failed memory-based zombie check', { teamName, error });
    }
  }

  /**
   * Find the JSONL file for a session ID across all project directories.
   */
  private findSessionJsonl(sessionId: string): string | null {
    try {
      if (!fs.existsSync(this.projectsDir)) return null;

      const projectDirs = fs.readdirSync(this.projectsDir);
      for (const projDir of projectDirs) {
        const projPath = path.join(this.projectsDir, projDir);
        if (!this.isDirectory(projPath)) continue;

        // Try exact match first, then prefix match.
        const exactPath = path.join(projPath, `${sessionId}.jsonl`);
        if (fs.existsSync(exactPath)) return exactPath;

        // Prefix match for short IDs.
        try {
          const files = fs.readdirSync(projPath);
          const match = files.find(f => f.startsWith(sessionId) && f.endsWith('.jsonl'));
          if (match) return path.join(projPath, match);
        } catch { /* skip unreadable dirs */ }
      }
    } catch (error) {
      this.logger.debug('Failed to find session JSONL', { sessionId, error });
    }
    return null;
  }

  /**
   * Track file mtimes and return true only on subsequent changes.
   */
  private checkFileChanged(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    try {
      const mtimeMs = fs.statSync(filePath).mtimeMs;
      const previous = this.lastPollSnapshot.get(filePath);
      this.lastPollSnapshot.set(filePath, mtimeMs);

      if (previous === undefined) {
        return false;
      }

      return previous !== mtimeMs;
    } catch (error) {
      this.logger.debug('Failed to check file mtime', { filePath, error });
      return false;
    }
  }

  private isDirectory(dirPath: string): boolean {
    try {
      return fs.statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  }

  private getInboxKey(teamName: string, agentName: string): string {
    return `${teamName}/${agentName}`;
  }

  private getLatestTimestamp(messages: InboxMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const timestamp = messages[i]?.timestamp;
      if (typeof timestamp === 'string' && timestamp.length > 0) {
        return timestamp;
      }
    }
    return null;
  }

  private readInboxFile(filePath: string): InboxMessage[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed: unknown = parseJson(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(isInboxMessage);
    } catch (error) {
      this.logger.debug('Failed to read inbox file', { filePath, error });
      return [];
    }
  }

  /**
   * List teams currently present on disk.
   */
  async listTeams(): Promise<string[]> {
    try {
      if (!fs.existsSync(this.teamsDir)) {
        return [];
      }

      const entries = fs.readdirSync(this.teamsDir);
      return entries
        .filter((teamName) => this.isDirectory(path.join(this.teamsDir, teamName)))
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      this.logger.error('Failed to list teams', { error });
      return [];
    }
  }

  /**
   * Get full inbox messages for one team member.
   */
  async getInboxMessages(teamName: string, agentName: string): Promise<InboxMessage[]> {
    const inboxPath = path.join(this.teamsDir, teamName, 'inboxes', `${agentName}.json`);
    return this.readInboxFile(inboxPath);
  }

  /**
   * Get inbox summaries for all members in a team.
   */
  async getInboxSummaries(teamName: string): Promise<InboxSummary[]> {
    const inboxDir = path.join(this.teamsDir, teamName, 'inboxes');
    if (!this.isDirectory(inboxDir)) {
      return [];
    }

    try {
      const inboxFiles = fs.readdirSync(inboxDir)
        .filter(file => file.endsWith('.json'))
        .sort((a, b) => a.localeCompare(b));
      const summaries: InboxSummary[] = [];

      for (const inboxFile of inboxFiles) {
        const agentName = path.basename(inboxFile, '.json');
        if (!agentName) continue;

        const filePath = path.join(inboxDir, inboxFile);
        const messages = this.readInboxFile(filePath);
        const unreadCount = messages.filter((message) => message.read !== true).length;
        const latestTimestamp = this.getLatestTimestamp(messages);

        summaries.push({
          agentName,
          messageCount: messages.length,
          unreadCount,
          latestTimestamp,
        });
      }

      return summaries;
    } catch (error) {
      this.logger.error('Failed to get inbox summaries', { teamName, error });
      return [];
    }
  }

  /**
   * Derive per-agent completion status from the lead's inbox.
   * Agents send their results TO the lead's inbox. The `from` field identifies
   * which agent sent the message. If an agent has sent any message to the lead,
   * we consider that agent done (regardless of task file status).
   */
  private getAgentCompletions(teamName: string, config: TeamConfig): AgentCompletion[] {
    // Find the lead member name
    const leadMember = config.members.find(m => m.agentType === 'team-lead');
    const leadName = leadMember?.name;

    // Also check for messages in the lead's inbox by agentId or name
    const leadInboxName = leadName || 'team-lead';
    const leadMessages = this.readInboxFile(
      path.join(this.teamsDir, teamName, 'inboxes', `${leadInboxName}.json`)
    );

    // Build a set of agent names that have sent messages to the lead
    const senderMessageCounts = new Map<string, number>();
    for (const msg of leadMessages) {
      const from = msg.from?.trim();
      if (from) {
        senderMessageCounts.set(from, (senderMessageCounts.get(from) || 0) + 1);
      }
    }

    // Map each non-lead member to their completion status
    return config.members
      .filter(m => m.agentType !== 'team-lead')
      .map(m => {
        const count = senderMessageCounts.get(m.name) || 0;
        return {
          agentName: m.name,
          deliveredToLead: count > 0,
          messagesDelivered: count,
        };
      });
  }

  /**
   * Read team config and emit update.
   */
  private async emitTeamUpdate(teamName: string): Promise<void> {
    try {
      const configPath = path.join(this.teamsDir, teamName, 'config.json');

      // Check if config exists (team might have been deleted).
      if (!fs.existsSync(configPath)) {
        this.logger.debug('Team config not found, skipping update', { teamName });
        return;
      }

      const configData = fs.readFileSync(configPath, 'utf-8');
      const parsedConfig: unknown = parseJson(configData);
      if (!isTeamConfig(parsedConfig)) {
        this.logger.debug('Invalid team config shape, skipping update', { teamName });
        return;
      }
      const config = parsedConfig;

      // Count tasks by status.
      const tasks = this.countTasks(teamName);
      const inboxSummaries = await this.getInboxSummaries(teamName);
      const agentCompletions = this.getAgentCompletions(teamName, config);

      const update: TeamUpdate = {
        teamName,
        leadSessionId: config.leadSessionId,
        memberCount: config.members.length,
        tasks,
        config,
        inboxSummaries,
        agentCompletions,
        timestamp: Date.now()
      };

      const completedCount = agentCompletions.filter(a => a.deliveredToLead).length;
      this.logger.info('Emitting team-updated event', {
        teamName,
        leadSessionId: config.leadSessionId.slice(0, 8),
        memberCount: config.members.length,
        taskTotal: tasks.pending + tasks.in_progress + tasks.completed,
        agentsCompleted: `${completedCount}/${agentCompletions.length}`,
        listenerCount: this.listenerCount('team-updated')
      });

      this.emit('team-updated', update);

      // Remember completion state so zombie check works after TeamDelete removes files.
      if (agentCompletions.length > 0 && agentCompletions.every(a => a.deliveredToLead)) {
        if (!this.completedTeamLeads.has(teamName)) {
          this.completedTeamLeads.set(teamName, {
            leadSessionId: config.leadSessionId,
            completedAt: Date.now(),
          });
        }
      }

      // Auto-link team to session in database.
      await this.linkTeamToSession(teamName, config.leadSessionId);
    } catch (error) {
      this.logger.debug('Failed to emit team update', {
        teamName,
        error
      });
    }
  }

  /**
   * Link a team to its lead session in the database.
   */
  private async linkTeamToSession(teamName: string, leadSessionId: string): Promise<void> {
    try {
      // Dynamically import to avoid circular dependency.
      const { SessionInfoService } = await import('../sessions/session-info-service.js');
      const sessionInfoService = SessionInfoService.getInstance();

      // Update the session with team info.
      await sessionInfoService.updateSessionInfo(leadSessionId, {
        team_name: teamName,
        team_role: 'lead'
      });

      this.logger.info('Linked team to session', {
        teamName,
        leadSessionId: leadSessionId.slice(0, 8)
      });
    } catch (error) {
      this.logger.warn('Failed to link team to session', {
        teamName,
        leadSessionId: leadSessionId.slice(0, 8),
        error
      });
    }
  }

  /**
   * Emit team removed event.
   */
  private async emitTeamRemoved(teamName: string): Promise<void> {
    const removed: TeamRemoved = {
      teamName,
      timestamp: Date.now()
    };

    this.logger.info('Emitting team-removed event', {
      teamName,
      listenerCount: this.listenerCount('team-removed')
    });

    this.emit('team-removed', removed);
    this.clearTeamState(teamName);
    this.clearTeamInboxState(teamName);

    // Keep team_name/team_role in the session DB — it's historical context
    // that shouldn't be lost when the team files are cleaned up.
  }

  private clearTeamState(teamName: string): void {
    this.zombieEmitted.delete(teamName);
  }

  private clearTeamInboxState(teamName: string): void {
    const prefix = `${teamName}/`;
    for (const key of this.inboxMessageCounts.keys()) {
      if (key.startsWith(prefix)) {
        this.inboxMessageCounts.delete(key);
      }
    }
  }

  /**
   * Clear team fields from a session when team is removed.
   */
  private async unlinkTeamFromSession(teamName: string): Promise<void> {
    try {
      // Dynamically import to avoid circular dependency.
      const { SessionInfoService } = await import('../sessions/session-info-service.js');
      const sessionInfoService = SessionInfoService.getInstance();

      // Find the session that had this team.
      const allSessions = await sessionInfoService.getAllSessionInfo();
      const sessionId = Object.keys(allSessions).find(id =>
        allSessions[id].team_name === teamName
      );

      if (sessionId) {
        await sessionInfoService.updateSessionInfo(sessionId, {
          team_name: undefined,
          team_role: undefined
        });

        this.logger.info('Unlinked team from session', {
          teamName,
          sessionId: sessionId.slice(0, 8)
        });
      }
    } catch (error) {
      this.logger.warn('Failed to unlink team from session', {
        teamName,
        error
      });
    }
  }

  /**
   * Count tasks by status for a team.
   */
  private countTasks(teamName: string): TaskStatus {
    const status: TaskStatus = {
      pending: 0,
      in_progress: 0,
      completed: 0
    };

    try {
      const taskDirPath = path.join(this.tasksDir, teamName);
      if (!fs.existsSync(taskDirPath)) {
        return status;
      }

      const files = fs.readdirSync(taskDirPath);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const taskPath = path.join(taskDirPath, file);
          const taskData = fs.readFileSync(taskPath, 'utf-8');
          const task = parseJson(taskData) as { status?: string };

          if (task.status === 'pending') {
            status.pending++;
          } else if (task.status === 'in_progress') {
            status.in_progress++;
          } else if (task.status === 'completed') {
            status.completed++;
          }
        } catch (error) {
          this.logger.debug('Failed to read task file', { file, error });
        }
      }
    } catch (error) {
      this.logger.debug('Failed to count tasks', { teamName, error });
    }

    return status;
  }

  /**
   * Get current team info (for API endpoint).
   */
  async getTeamInfo(teamName: string): Promise<TeamUpdate | null> {
    try {
      const configPath = path.join(this.teamsDir, teamName, 'config.json');

      if (!fs.existsSync(configPath)) {
        return null;
      }

      const configData = fs.readFileSync(configPath, 'utf-8');
      const parsedConfig: unknown = parseJson(configData);
      if (!isTeamConfig(parsedConfig)) {
        this.logger.debug('Invalid team config shape, skipping team info', { teamName });
        return null;
      }
      const config = parsedConfig;
      const tasks = this.countTasks(teamName);
      const inboxSummaries = await this.getInboxSummaries(teamName);
      const agentCompletions = this.getAgentCompletions(teamName, config);

      return {
        teamName,
        leadSessionId: config.leadSessionId,
        memberCount: config.members.length,
        tasks,
        config,
        inboxSummaries,
        agentCompletions,
        timestamp: Date.now()
      };
    } catch (error) {
      this.logger.error('Failed to get team info', { teamName, error });
      return null;
    }
  }
}

// Singleton instance.
let instance: TeamWatcherService | null = null;

export function getTeamWatcherService(): TeamWatcherService {
  if (!instance) {
    instance = new TeamWatcherService();
  }
  return instance;
}
