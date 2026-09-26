import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../infrastructure/logger.js';
import { InsightsEngine } from '../insights/insights-engine.js';
import { ClaudeHistoryReader } from '../sessions/claude-history-reader.js';

interface MiniAction {
  tool: string;
  timestamp: number;
}

interface ActivityUpdate {
  sessionId: string;
  recentActions: MiniAction[];
  timestamp: number;
}

interface InsightsUpdate {
  sessionId: string;
  conversationId?: string;
  type: 'generated' | 'patched';
  timestamp: number;
  identityImage?: string; // Base64-encoded image if available
  traceId?: string; // End-to-end trace ID for debugging
}

/**
 * Watches Claude session JSONL files for changes and emits activity updates
 */
export class SessionActivityWatcher extends EventEmitter {
  private logger = createLogger('SessionActivityWatcher');
  private insightsEngine: InsightsEngine;
  private historyReader: ClaudeHistoryReader;
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private projectsDir: string;
  private isWatching = false;

  // Debounce file changes to avoid rapid-fire updates
  private readonly DEBOUNCE_MS = 100;

  constructor() {
    super();
    this.historyReader = new ClaudeHistoryReader();
    this.insightsEngine = InsightsEngine.getInstance();
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
  }

  /**
   * Start watching for session file changes
   */
  start(): void {
    if (this.isWatching) return;

    this.logger.info('Starting session activity watcher', { projectsDir: this.projectsDir });

    try {
      // Watch the projects directory for new project folders
      this.watchDirectory(this.projectsDir);

      // Watch existing project directories
      if (fs.existsSync(this.projectsDir)) {
        const projects = fs.readdirSync(this.projectsDir);
        for (const project of projects) {
          const projectPath = path.join(this.projectsDir, project);
          if (fs.statSync(projectPath).isDirectory()) {
            this.watchProjectDirectory(projectPath);
          }
        }
      }

      this.isWatching = true;
      this.logger.info('Session activity watcher started', {
        watcherCount: this.watchers.size
      });
    } catch (error) {
      this.logger.error('Failed to start session activity watcher', error);
    }
  }

  /**
   * Emit an insights update event (called by InsightsEventHandler)
   */
  async emitInsightsUpdate(sessionId: string, type: 'generated' | 'patched', traceId?: string): Promise<void> {
    // Try to fetch identity image to include in the update
    let identityImage: string | undefined;
    let conversationId: string | undefined;
    try {
      const { SessionInfoService } = await import('./session-info-service.js');
      const sessionInfoService = SessionInfoService.getInstance();
      // Use sync-only reads to avoid getSessionInfo()'s auto-insert side effect,
      // which creates rows with archived=true and poisons new sessions.
      const sessionInfo = sessionInfoService.getSessionInfoSync(sessionId);

      identityImage = sessionInfo?.identity_image ?? undefined;
      conversationId = sessionInfo?.conversation_id?.trim() || undefined;

      // Prefer image from canonical conversation row when this provider session is linked.
      if (conversationId && conversationId !== sessionId) {
        const conversationInfo = sessionInfoService.getSessionInfoSync(conversationId);
        identityImage = conversationInfo?.identity_image ?? identityImage;
      }
    } catch (_error) {
      // Identity image not available yet, that's okay
      this.logger.debug('No identity image available for insights update', {
        sessionId: sessionId.slice(0, 8)
      });
    }

    const update: InsightsUpdate = {
      sessionId,
      conversationId,
      type,
      timestamp: Date.now(),
      identityImage,
      traceId
    };
    this.logger.debug('[SSE TRACE] SessionActivityWatcher emitting insights event', {
      traceId,
      sessionId: sessionId.slice(0, 8),
      conversationId: conversationId?.slice(0, 8),
      type,
      hasIdentityImage: !!identityImage,
      listenerCount: this.listenerCount('insights')
    });
    this.emit('insights', update);
  }

  /**
   * Emit an API health status event (credit exhaustion / recovery)
   */
  emitApiHealth(status: { creditsExhausted: boolean; since?: string | null }): void {
    this.logger.info('[SSE] SessionActivityWatcher emitting api-health event', {
      creditsExhausted: status.creditsExhausted,
      listenerCount: this.listenerCount('api-health')
    });
    this.emit('api-health', {
      type: 'api-health',
      creditsExhausted: status.creditsExhausted,
      since: status.since || null,
      timestamp: Date.now(),
    });
  }

  /**
   * Stop watching
   */
  stop(): void {
    this.logger.info('Stopping session activity watcher');

    for (const [_path, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.isWatching = false;
  }

  private watchDirectory(dirPath: string): void {
    if (this.watchers.has(dirPath)) return;

    try {
      const watcher = fs.watch(dirPath, { persistent: false }, (eventType, filename) => {
        if (!filename) return;

        const fullPath = path.join(dirPath, filename);

        // Check if it's a new project directory
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
          this.watchProjectDirectory(fullPath);
        }
      });

      this.watchers.set(dirPath, watcher);
      this.logger.debug('Watching directory', { dirPath });
    } catch (error) {
      this.logger.warn('Failed to watch directory', { dirPath, error });
    }
  }

  private watchProjectDirectory(projectPath: string): void {
    if (this.watchers.has(projectPath)) return;

    try {
      const watcher = fs.watch(projectPath, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;

        const filePath = path.join(projectPath, filename);
        this.handleFileChange(filePath, filename);
      });

      this.watchers.set(projectPath, watcher);
      this.logger.debug('Watching project directory', { projectPath });
    } catch (error) {
      this.logger.warn('Failed to watch project directory', { projectPath, error });
    }
  }

  private handleFileChange(filePath: string, filename: string): void {
    // Extract session ID from filename (e.g., "abc123-def456.jsonl" -> "abc123-def456")
    const sessionId = filename.replace('.jsonl', '');

    this.logger.debug('File change detected', {
      sessionId: sessionId.slice(0, 8),
      filename
    });

    // Debounce rapid changes
    const existingTimer = this.debounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.debounceTimers.set(sessionId, setTimeout(() => {
      this.debounceTimers.delete(sessionId);
      void this.extractAndEmit(sessionId, filePath);
    }, this.DEBOUNCE_MS));
  }

  private async extractAndEmit(sessionId: string, _filePath: string): Promise<void> {
    try {
      const { messages } = await this.historyReader.fetchConversationDirect(sessionId);
      const recentActions = this.insightsEngine.extractRecentActions(messages, 10);

      // Only emit when we have something to show
      if (recentActions.length === 0) {
        this.logger.debug('Skipping empty activity update', {
          sessionId: sessionId.slice(0, 8)
        });
        return;
      }

      const update: ActivityUpdate = {
        sessionId,
        recentActions,
        timestamp: Date.now()
      };

      this.logger.debug('Emitting activity update', {
        sessionId: sessionId.slice(0, 8),
        actionCount: recentActions.length
      });

      this.emit('activity', update);
    } catch (error) {
      this.logger.debug('Failed to extract activity', {
        sessionId: sessionId.slice(0, 8),
        error
      });
    }
  }
}

// Singleton instance
let instance: SessionActivityWatcher | null = null;

export function getSessionActivityWatcher(): SessionActivityWatcher {
  if (!instance) {
    instance = new SessionActivityWatcher();
  }
  return instance;
}
