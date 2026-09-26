import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { SessionInfoService } from '../sessions/session-info-service.js';
import { ClaudeHistoryReader } from '../sessions/claude-history-reader.js';
import { readMessages } from '../../harness/event-message-reader.js';
import type { UnifiedMessage } from '@/types/unified-messages.js';

// ============================================================================
// Types
// ============================================================================

export interface SessionMetrics {
  durationMinutes: number | null;
  messageCount: number;
  toolUseCount: number;
  errorCount: number;
  contextOverflowCount: number;
  autoCompactCount: number;
  fileEditCount: number;
  fileRewriteCount: number;      // Files edited 3+ times
  missionPivotCount: number;     // Recompute events from insight audit
}

export interface SessionAnalysis {
  id: number;
  sessionId: string;
  createdAt: string;
  status: 'pending' | 'extracting' | 'complete' | 'failed';
  errorMessage: string | null;
  metrics: SessionMetrics | null;
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  metrics?: Partial<SessionMetrics>;
}

type AnalysisRow = {
  id: number;
  session_id: string;
  created_at: string;
  status: string;
  error_message: string | null;
  duration_minutes: number | null;
  message_count: number | null;
  tool_use_count: number | null;
  error_count: number | null;
  context_overflow_count: number | null;
  auto_compact_count: number | null;
  file_edit_count: number | null;
  file_rewrite_count: number | null;
  mission_pivot_count: number | null;
};

// ============================================================================
// Service
// ============================================================================

/**
 * SessionAnalysisService extracts and stores session health metrics.
 * Phase 1: Metrics-only extraction (no LLM calls).
 *
 * Data sources:
 * - Session JSONL file: messages, tool uses, timestamps
 * - Debug log: errors, context overflows, auto-compacts
 * - insight_event_audit: mission pivot count
 */
export class SessionAnalysisService {
  private static instance: SessionAnalysisService;
  private logger: Logger;
  private sessionInfoService: SessionInfoService;
  private historyReader: ClaudeHistoryReader;
  private db!: Database.Database;
  private isInitialized = false;

  // Prepared statements
  private getAnalysisStmt!: Database.Statement;
  private insertAnalysisStmt!: Database.Statement;
  private updateAnalysisStmt!: Database.Statement;

  constructor(
    sessionInfoService?: SessionInfoService,
    historyReader?: ClaudeHistoryReader
  ) {
    this.logger = createLogger('SessionAnalysisService');
    this.sessionInfoService = sessionInfoService || SessionInfoService.getInstance();
    this.historyReader = historyReader || new ClaudeHistoryReader(this.sessionInfoService);
  }

  static getInstance(): SessionAnalysisService {
    if (!SessionAnalysisService.instance) {
      SessionAnalysisService.instance = new SessionAnalysisService();
    }
    return SessionAnalysisService.instance;
  }

  static resetInstance(): void {
    SessionAnalysisService.instance = null as unknown as SessionAnalysisService;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Get the shared database connection
    await this.sessionInfoService.initialize();
    this.db = DatabaseProvider.getInstance().getDb();

    // Create our table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,

        -- Extracted metrics
        duration_minutes INTEGER,
        message_count INTEGER,
        tool_use_count INTEGER,
        error_count INTEGER,
        context_overflow_count INTEGER,
        auto_compact_count INTEGER,
        file_edit_count INTEGER,
        file_rewrite_count INTEGER,
        mission_pivot_count INTEGER,

        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      )
    `);

    // Create index for fast lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_analyses_session_id
      ON session_analyses(session_id)
    `);

    this.prepareStatements();
    this.isInitialized = true;
    this.logger.info('SessionAnalysisService initialized');
  }

  private prepareStatements(): void {
    this.getAnalysisStmt = this.db.prepare(
      'SELECT * FROM session_analyses WHERE session_id = ?'
    );

    this.insertAnalysisStmt = this.db.prepare(`
      INSERT INTO session_analyses (session_id, created_at, status)
      VALUES (@sessionId, @createdAt, @status)
    `);

    this.updateAnalysisStmt = this.db.prepare(`
      UPDATE session_analyses SET
        status = @status,
        error_message = @errorMessage,
        duration_minutes = @durationMinutes,
        message_count = @messageCount,
        tool_use_count = @toolUseCount,
        error_count = @errorCount,
        context_overflow_count = @contextOverflowCount,
        auto_compact_count = @autoCompactCount,
        file_edit_count = @fileEditCount,
        file_rewrite_count = @fileRewriteCount,
        mission_pivot_count = @missionPivotCount
      WHERE session_id = @sessionId
    `);
  }

  private mapRow(row: AnalysisRow): SessionAnalysis {
    const hasMetrics = row.message_count !== null;

    return {
      id: row.id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      status: row.status as SessionAnalysis['status'],
      errorMessage: row.error_message,
      metrics: hasMetrics ? {
        durationMinutes: row.duration_minutes,
        messageCount: row.message_count!,
        toolUseCount: row.tool_use_count ?? 0,
        errorCount: row.error_count ?? 0,
        contextOverflowCount: row.context_overflow_count ?? 0,
        autoCompactCount: row.auto_compact_count ?? 0,
        fileEditCount: row.file_edit_count ?? 0,
        fileRewriteCount: row.file_rewrite_count ?? 0,
        missionPivotCount: row.mission_pivot_count ?? 0,
      } : null,
    };
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Check if a session is eligible for analysis.
   * Eligible if: ≥10 messages OR ≥5 min duration OR ≥5 tool uses
   */
  async isEligible(sessionId: string): Promise<EligibilityResult> {
    try {
      // Quick check: get basic message info from session file
      const { messages } = await this.historyReader.fetchConversationDirect(sessionId);

      const messageCount = messages.length;
      const toolUseCount = this.countToolUses(messages);

      // Calculate duration from first to last message
      let durationMinutes: number | null = null;
      if (messages.length >= 2) {
        const firstTs = new Date(messages[0].timestamp).getTime();
        const lastTs = new Date(messages[messages.length - 1].timestamp).getTime();
        durationMinutes = Math.round((lastTs - firstTs) / 60000);
      }

      const metrics = { messageCount, toolUseCount, durationMinutes };

      // Eligibility thresholds
      if (messageCount >= 10) {
        return { eligible: true, reason: `${messageCount} messages`, metrics };
      }
      if (durationMinutes !== null && durationMinutes >= 5) {
        return { eligible: true, reason: `${durationMinutes} minute session`, metrics };
      }
      if (toolUseCount >= 5) {
        return { eligible: true, reason: `${toolUseCount} tool uses`, metrics };
      }

      return {
        eligible: false,
        reason: `Session too small (${messageCount} msgs, ${durationMinutes ?? 0} min, ${toolUseCount} tools)`,
        metrics,
      };
    } catch (error) {
      this.logger.error('Failed to check eligibility', { sessionId, error });
      return { eligible: false, reason: 'Failed to read session' };
    }
  }

  /**
   * Get existing analysis for a session.
   */
  async getAnalysis(sessionId: string): Promise<SessionAnalysis | null> {
    try {
      const row = this.getAnalysisStmt.get(sessionId) as AnalysisRow | undefined;
      return row ? this.mapRow(row) : null;
    } catch (error) {
      this.logger.error('Failed to get analysis', { sessionId, error });
      return null;
    }
  }

  /**
   * Extract metrics for a session.
   * Creates a new analysis record or updates existing one.
   */
  async extractMetrics(sessionId: string): Promise<SessionAnalysis> {
    const now = new Date().toISOString();

    // Check if analysis already exists
    let existing = await this.getAnalysis(sessionId);
    if (!existing) {
      this.insertAnalysisStmt.run({
        sessionId,
        createdAt: now,
        status: 'extracting',
      });
      existing = await this.getAnalysis(sessionId);
    }

    try {
      // Update status to extracting
      this.updateAnalysisStmt.run({
        sessionId,
        status: 'extracting',
        errorMessage: null,
        durationMinutes: null,
        messageCount: null,
        toolUseCount: null,
        errorCount: null,
        contextOverflowCount: null,
        autoCompactCount: null,
        fileEditCount: null,
        fileRewriteCount: null,
        missionPivotCount: null,
      });

      // Extract metrics from various sources
      const metrics = await this.doExtractMetrics(sessionId);

      // Update with extracted metrics
      this.updateAnalysisStmt.run({
        sessionId,
        status: 'complete',
        errorMessage: null,
        durationMinutes: metrics.durationMinutes,
        messageCount: metrics.messageCount,
        toolUseCount: metrics.toolUseCount,
        errorCount: metrics.errorCount,
        contextOverflowCount: metrics.contextOverflowCount,
        autoCompactCount: metrics.autoCompactCount,
        fileEditCount: metrics.fileEditCount,
        fileRewriteCount: metrics.fileRewriteCount,
        missionPivotCount: metrics.missionPivotCount,
      });

      this.logger.info('Metrics extracted successfully', { sessionId, metrics });
      return (await this.getAnalysis(sessionId))!;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateAnalysisStmt.run({
        sessionId,
        status: 'failed',
        errorMessage,
        durationMinutes: null,
        messageCount: null,
        toolUseCount: null,
        errorCount: null,
        contextOverflowCount: null,
        autoCompactCount: null,
        fileEditCount: null,
        fileRewriteCount: null,
        missionPivotCount: null,
      });
      this.logger.error('Failed to extract metrics', { sessionId, error });
      return (await this.getAnalysis(sessionId))!;
    }
  }

  // ============================================================================
  // Private Extraction Methods
  // ============================================================================

  private async doExtractMetrics(sessionId: string): Promise<SessionMetrics> {
    // 1. Try unified message store first
    const unifiedMessages = readMessages(sessionId);

    let messageCount: number;
    let toolUseCount: number;
    let fileEditCount: number;
    let fileRewriteCount: number;
    let durationMinutes: number | null = null;

    if (unifiedMessages.length > 0) {
      this.logger.debug('Using unified message store for metrics', {
        sessionId: sessionId.slice(0, 8),
        messageCount: unifiedMessages.length,
      });
      messageCount = unifiedMessages.length;
      toolUseCount = this.countToolUsesUnified(unifiedMessages);
      const fileCounts = this.countFileEditsUnified(unifiedMessages);
      fileEditCount = fileCounts.fileEditCount;
      fileRewriteCount = fileCounts.fileRewriteCount;

      // Calculate duration from unified messages
      if (unifiedMessages.length >= 2) {
        const firstTs = new Date(unifiedMessages[0].timestamp).getTime();
        const lastTs = new Date(unifiedMessages[unifiedMessages.length - 1].timestamp).getTime();
        durationMinutes = Math.round((lastTs - firstTs) / 60000);
      }
    } else {
      // Fall back to JSONL for pre-unified sessions
      this.logger.debug('Falling back to JSONL for metrics', {
        sessionId: sessionId.slice(0, 8),
      });
      const { messages } = await this.historyReader.fetchConversationDirect(sessionId);

      messageCount = messages.length;
      toolUseCount = this.countToolUses(messages);
      const fileCounts = this.countFileEdits(messages);
      fileEditCount = fileCounts.fileEditCount;
      fileRewriteCount = fileCounts.fileRewriteCount;

      // Calculate duration from JSONL messages
      if (messages.length >= 2) {
        const firstTs = new Date(messages[0].timestamp).getTime();
        const lastTs = new Date(messages[messages.length - 1].timestamp).getTime();
        durationMinutes = Math.round((lastTs - firstTs) / 60000);
      }
    }

    // 2. Extract from debug log
    const debugMetrics = await this.extractDebugLogMetrics(sessionId);

    // 3. Extract from insight audit
    const missionPivotCount = this.countMissionPivots(sessionId);

    return {
      durationMinutes,
      messageCount,
      toolUseCount,
      errorCount: debugMetrics.errorCount,
      contextOverflowCount: debugMetrics.contextOverflowCount,
      autoCompactCount: debugMetrics.autoCompactCount,
      fileEditCount,
      fileRewriteCount,
      missionPivotCount,
    };
  }

  private countToolUses(messages: Array<{ message?: { content?: unknown } }>): number {
    let count = 0;
    for (const msg of messages) {
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        const typedBlock = block as { type?: string } | null;
        if (typedBlock?.type === 'tool_use') {
          count++;
        }
      }
    }
    return count;
  }

  private countFileEdits(messages: Array<{ message?: { content?: unknown } }>): {
    fileEditCount: number;
    fileRewriteCount: number;
  } {
    const fileCounts = new Map<string, number>();

    for (const msg of messages) {
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;

      interface ToolUseBlock {
        type?: string;
        name?: string;
        input?: { file_path?: string };
      }
      for (const block of content) {
        const typedBlock = block as ToolUseBlock | null;
        if (
          typedBlock?.type === 'tool_use' &&
          (typedBlock.name === 'Edit' || typedBlock.name === 'Write') &&
          typedBlock.input?.file_path
        ) {
          const filePath = String(typedBlock.input.file_path);
          fileCounts.set(filePath, (fileCounts.get(filePath) || 0) + 1);
        }
      }
    }

    const fileEditCount = fileCounts.size;
    const fileRewriteCount = Array.from(fileCounts.values()).filter(c => c >= 3).length;

    return { fileEditCount, fileRewriteCount };
  }

  /**
   * Count tool uses from unified messages.
   */
  private countToolUsesUnified(messages: UnifiedMessage[]): number {
    let count = 0;
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Count file edits from unified messages.
   */
  private countFileEditsUnified(messages: UnifiedMessage[]): {
    fileEditCount: number;
    fileRewriteCount: number;
  } {
    const fileCounts = new Map<string, number>();

    for (const msg of messages) {
      for (const block of msg.content) {
        if (
          block.type === 'tool_use' &&
          (block.name === 'Edit' || block.name === 'Write') &&
          block.input?.file_path
        ) {
          const filePath = String(block.input.file_path);
          fileCounts.set(filePath, (fileCounts.get(filePath) || 0) + 1);
        }
      }
    }

    const fileEditCount = fileCounts.size;
    const fileRewriteCount = Array.from(fileCounts.values()).filter(c => c >= 3).length;

    return { fileEditCount, fileRewriteCount };
  }

  private async extractDebugLogMetrics(sessionId: string): Promise<{
    errorCount: number;
    contextOverflowCount: number;
    autoCompactCount: number;
  }> {
    const debugPath = path.join(os.homedir(), '.claude', 'debug', `${sessionId}.txt`);

    try {
      const content = await fs.readFile(debugPath, 'utf-8');
      const lines = content.split('\n');

      let errorCount = 0;
      let contextOverflowCount = 0;
      let autoCompactCount = 0;

      for (const line of lines) {
        if (line.includes('[ERROR]')) {
          errorCount++;
        }
        if (line.includes('prompt is too long')) {
          contextOverflowCount++;
        }
        if (line.includes('PreCompact with query: auto')) {
          autoCompactCount++;
        }
      }

      return { errorCount, contextOverflowCount, autoCompactCount };
    } catch (error) {
      // Debug file may not exist for all sessions
      this.logger.debug('Could not read debug log', { sessionId, error });
      return { errorCount: 0, contextOverflowCount: 0, autoCompactCount: 0 };
    }
  }

  private countMissionPivots(sessionId: string): number {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM insight_event_audit
        WHERE session_id = ? AND event_type = 'recompute'
      `).get(sessionId) as { count: number } | undefined;

      return row?.count ?? 0;
    } catch (error) {
      this.logger.debug('Could not count mission pivots', { sessionId, error });
      return 0;
    }
  }
}
