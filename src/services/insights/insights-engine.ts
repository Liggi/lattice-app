import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { anthropicService } from '../insights/anthropic-service.js';
import { SessionInfoService } from '../sessions/session-info-service.js';
import { resolveCanonicalId } from '../sessions/resolve-canonical-id.js';
import { LatticeError } from '@/types/index.js';
import { allowGeneration } from '../infrastructure/generation-gates.js';
import { InsightAuditRepository } from './insight-audit-repository.js';
import { homedir } from 'os';
import { capMessage, humanTextOfInput, isGenericFolder, pickupBriefOf } from './human-input.js';
import { ConfigService } from '../infrastructure/config-service.js';
import { userName } from '../user-profile.js';

// =============================================================================
// Types — owned by InsightsEngine (previously on SessionInfoService)
// =============================================================================

export interface InsightsRecord {
  session_id: string;
  context: { project: string; area: string | null; mission: string; scope: string } | null;
  tags: { complexity: string } | null;
  purpose?: string;
  theme: string | null;
  categories?: SessionCategorySet | null;
  computed_at: string;
  stale: boolean;
  message_count?: number;
  patched_at?: string;
  lines_added?: number;
  lines_removed?: number;
  edit_count?: number;
  write_count?: number;
  metrics_updated_at?: string;
}

/** @deprecated Use InsightsRecord instead */
export type CachedInsights = InsightsRecord;

type InsightsRow = {
  session_id: string;
  context: string | null;
  tags: string | null;
  theme: string | null;
  categories: string | null;
  computed_at: string;
  stale: number;
  message_count: number | null;
  patched_at: string | null;
  purpose: string | null;
  lines_added: number;
  lines_removed: number;
  edit_count: number;
  write_count: number;
  metrics_updated_at: string | null;
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Generate a trace ID for correlating recompute events through the system.
 * Format: <session-prefix>-<timestamp-hex>-<random>
 */
function generateTraceId(sessionId: string): string {
  const sessionPrefix = sessionId.slice(0, 8);
  const timestampHex = Date.now().toString(16);
  const random = crypto.randomBytes(2).toString('hex');
  return `${sessionPrefix}-${timestampHex}-${random}`;
}

/**
 * Build a state snapshot for auditing insight changes.
 * Captures fields relevant to dashboard display.
 */
function buildStateSnapshot(cache: InsightsRecord | null, insights?: SessionInsights): {
  mission?: string;
  theme?: string;
  purpose?: string;
} {
  if (insights) {
    return {
      mission: insights.context?.mission || undefined,
      theme: insights.theme || undefined,
      purpose: insights.purpose || undefined,
    };
  }
  if (cache) {
    return {
      mission: cache.context?.mission || undefined,
      theme: cache.theme || undefined,
      purpose: cache.purpose || undefined,
    };
  }
  return {};
}

import { parseJson } from '../../utils/json.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionInsights,
  SessionTags,
  TodoItem,
} from '@/types/index.js';
import type { SessionCategorySet } from '@/types/session-categories.js';
import { CONFIG_FILE } from '@/utils/constants.js';

// Re-export types that other modules import from this file
export type { SessionInsights, TodoItem } from '@/types/index.js';

/**
 * InsightsEngine — owns insights computation AND storage.
 *
 * Responsibilities:
 * - Building prompts for insight generation
 * - Calling Anthropic/Gemini APIs
 * - Owning the session_insights table (read, write, batch, staleness)
 * - Generating identity images
 * - Audit trail for insight changes
 *
 * This is a "deep module" (Ousterhout): it hides which LLM to call, how to
 * cache, how to detect staleness, how to batch-query, and the audit trail
 * behind a small public API.
 */
// Minimum number of user messages before computing insights on turn:end.
const MIN_USER_MESSAGES = 2;

// Debounce: skip if insights were computed within this window.
/** The one folder every session is launched from (Settings → Launch folder). */
function launchFolder(): string | undefined {
  try {
    return ConfigService.getInstance().getConfig().server?.defaultWorkingDirectory;
  } catch {
    return undefined;
  }
}

const RECOMPUTE_COOLDOWN_MS = 60_000;

export class InsightsEngine {
  private static instance: InsightsEngine | null = null;

  private logger: Logger;
  private sessionInfoService: SessionInfoService;
  private lastComputedAt = new Map<string, number>();

  // Database handle + prepared statements for session_insights table
  private db: Database.Database;
  private getInsightsStmt!: Database.Statement;
  private upsertInsightsStmt!: Database.Statement;
  private getAllInsightsStmt!: Database.Statement;

  constructor(sessionInfoService?: SessionInfoService) {
    this.logger = createLogger('InsightsEngine');
    this.sessionInfoService = sessionInfoService || SessionInfoService.getInstance();
    this.db = DatabaseProvider.getInstance().getDb();
    this.prepareStatements();
  }

  static getInstance(): InsightsEngine {
    if (!InsightsEngine.instance) {
      InsightsEngine.instance = new InsightsEngine();
    }
    return InsightsEngine.instance;
  }

  static resetInstance(): void {
    InsightsEngine.instance = null;
  }

  private prepareStatements(): void {
    this.getInsightsStmt = this.db.prepare('SELECT * FROM session_insights WHERE session_id = ?');
    this.upsertInsightsStmt = this.db.prepare(`
      INSERT INTO session_insights (
        session_id, context, tags,
        theme, categories, computed_at, stale,
        message_count, patched_at, purpose
      ) VALUES (
        @session_id, @context, @tags,
        @theme, @categories, @computed_at, @stale,
        @message_count, @patched_at, @purpose
      ) ON CONFLICT(session_id) DO UPDATE SET
        context=excluded.context,
        tags=excluded.tags,
        theme=excluded.theme,
        categories=excluded.categories,
        computed_at=excluded.computed_at,
        stale=excluded.stale,
        message_count=excluded.message_count,
        patched_at=excluded.patched_at,
        purpose=excluded.purpose
    `);
    this.getAllInsightsStmt = this.db.prepare('SELECT * FROM session_insights');
  }

  // ===========================================================================
  // Cache methods (migrated from SessionInfoService)
  // ===========================================================================

  async getInsightsRecord(sessionId: string): Promise<InsightsRecord | null> {
    try {
      const canonicalSessionId = resolveCanonicalId(this.db, sessionId);
      const row = this.getInsightsStmt.get(canonicalSessionId) as InsightsRow | undefined;
      if (row) {
        return this.mapInsightsRow(row);
      }
      return null;
    } catch (error) {
      this.logger.error('Failed to get insights', { sessionId, error });
      return null;
    }
  }

  async setInsightsRecord(insights: InsightsRecord): Promise<void> {
    try {
      const canonicalSessionId = resolveCanonicalId(this.db, insights.session_id);
      this.upsertInsightsStmt.run({
        session_id: canonicalSessionId,
        context: insights.context ? JSON.stringify(insights.context) : null,
        tags: insights.tags ? JSON.stringify(insights.tags) : null,
        theme: insights.theme,
        categories: insights.categories ? JSON.stringify(insights.categories) : null,
        computed_at: insights.computed_at,
        stale: insights.stale ? 1 : 0,
        message_count: insights.message_count ?? null,
        patched_at: insights.patched_at ?? null,
        purpose: insights.purpose ?? null,
      });
      this.logger.debug('Insights cached', {
        sessionId: canonicalSessionId,
        requestedSessionId: insights.session_id === canonicalSessionId ? undefined : insights.session_id,
      });
    } catch (error) {
      this.logger.error('Failed to set insights', { sessionId: insights.session_id, error });
      throw error;
    }
  }

  async getAllInsightsRecords(): Promise<Map<string, InsightsRecord>> {
    try {
      const rows = this.getAllInsightsStmt.all() as InsightsRow[];
      const result = new Map<string, InsightsRecord>();
      for (const row of rows) {
        result.set(row.session_id, this.mapInsightsRow(row));
      }
      return result;
    } catch (error) {
      this.logger.error('Failed to get all insights', error);
      return new Map();
    }
  }

  async getInsightsRecordBatch(sessionIds: string[]): Promise<Map<string, InsightsRecord>> {
    if (sessionIds.length === 0) return new Map();
    try {
      const placeholders = sessionIds.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM session_insights WHERE session_id IN (${placeholders})`)
        .all(...sessionIds) as InsightsRow[];
      const result = new Map<string, InsightsRecord>();
      for (const row of rows) {
        result.set(row.session_id, this.mapInsightsRow(row));
      }
      return result;
    } catch (error) {
      this.logger.error('Failed to get insights batch', error);
      return new Map();
    }
  }

  async getMissingInsightsSessionIds(sessionIds: string[]): Promise<string[]> {
    try {
      const existing = await this.getAllInsightsRecords();
      return sessionIds.filter(id => !existing.has(id));
    } catch (error) {
      this.logger.error('Failed to get missing insights session IDs', error);
      return sessionIds;
    }
  }

  async updateToolMetrics(
    sessionId: string,
    metrics: { linesAdded: number; linesRemoved: number; editCount: number; writeCount: number },
    messageCount?: number
  ): Promise<void> {
    try {
      const canonicalSessionId = resolveCanonicalId(this.db, sessionId);
      this.ensureInsightsRow(canonicalSessionId);
      const stmt = this.db.prepare(`
        UPDATE session_insights
        SET lines_added = ?, lines_removed = ?, edit_count = ?, write_count = ?, metrics_updated_at = ?
            ${messageCount !== undefined ? ', message_count = ?' : ''}
        WHERE session_id = ?
      `);
      const params = [
        metrics.linesAdded,
        metrics.linesRemoved,
        metrics.editCount,
        metrics.writeCount,
        new Date().toISOString(),
        ...(messageCount !== undefined ? [messageCount] : []),
        canonicalSessionId,
      ];
      const result = stmt.run(...params);
      if (result.changes > 0) {
        this.logger.debug('Tool metrics updated', {
          sessionId: canonicalSessionId,
          requestedSessionId: sessionId === canonicalSessionId ? undefined : sessionId,
          metrics,
          messageCount,
        });
      }
    } catch (error) {
      this.logger.error('Failed to update tool metrics', { sessionId, error });
    }
  }

  private ensureInsightsRow(sessionId: string): void {
    this.db.prepare(`
      INSERT INTO session_insights (
        session_id, context, tags,
        theme, categories, computed_at, stale,
        message_count, patched_at, purpose
      ) VALUES (
        ?, NULL, NULL,
        NULL, NULL, ?, 1,
        NULL, NULL, NULL
      )
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, new Date().toISOString());
  }

  private mapInsightsRow(row: InsightsRow): InsightsRecord {
    return {
      session_id: row.session_id,
      context: row.context ? parseJson(row.context) as InsightsRecord['context'] : null,
      tags: row.tags ? parseJson(row.tags) as InsightsRecord['tags'] : null,
      theme: row.theme,
      categories: row.categories ? parseJson(row.categories) as SessionCategorySet : null,
      computed_at: row.computed_at,
      stale: !!row.stale,
      message_count: row.message_count ?? undefined,
      patched_at: row.patched_at ?? undefined,
      purpose: row.purpose ?? undefined,
      lines_added: row.lines_added ?? undefined,
      lines_removed: row.lines_removed ?? undefined,
      edit_count: row.edit_count ?? undefined,
      write_count: row.write_count ?? undefined,
      metrics_updated_at: row.metrics_updated_at ?? undefined,
    };
  }

  // ===========================================================================
  // Harness event reading (replaces JSONL/historyReader path)
  // ===========================================================================

  /**
   * Read conversation content from harness events.
   * Returns structured data for insight generation. `userPrompts` holds only
   * what the user wrote (see `human-input.ts`), never server-injected input.
   */
  private readConversationFromEvents(sessionId: string): {
    userPrompts: string[];
    assistantTexts: string[];
    todoState: TodoItem[] | null;
    messageCount: number;
    /** A worker's task as its coordinator wrote it at pickup; null for anything else. */
    brief: string | null;
  } {
    type EventRow = { type: string; data: string };
    const rows = this.db.prepare(
      'SELECT type, data FROM harness_events WHERE session_id = ? ORDER BY seq ASC'
    ).all(sessionId) as EventRow[];

    const userPrompts: string[] = [];
    const assistantTexts: string[] = [];
    let todoState: TodoItem[] | null = null;
    let messageCount = 0;
    const name = userName();
    // Codex streams a reply as many content events sharing one messageId; join
    // them so "recent assistant responses" are replies, not ". play to".
    let lastTextMessageId: string | null = null;
    let brief: string | null = null;

    for (const row of rows) {
      const data = parseJson(row.data) as Record<string, unknown>;

      if (row.type === 'input:sent') {
        const text = data.text as string | undefined;
        if (text?.trim()) messageCount++;
        const human = text ? humanTextOfInput(text, name) : null;
        if (human) userPrompts.push(human);
        brief ??= text ? pickupBriefOf(text) : null;
      } else if (row.type === 'content') {
        const blocks = data.blocks as Array<{ type: string; text?: string; thinking?: string; name?: string; input?: Record<string, unknown> }> | undefined;
        if (!blocks) continue;
        messageCount++;

        const messageId = typeof data.messageId === 'string' ? data.messageId : null;
        for (const block of blocks) {
          if (block.type === 'text' && block.text?.trim()) {
            if (messageId && messageId === lastTextMessageId && assistantTexts.length > 0) {
              assistantTexts[assistantTexts.length - 1] += block.text;
            } else {
              assistantTexts.push(block.text);
            }
            lastTextMessageId = messageId;
          } else if (block.type === 'tool_use' && block.name === 'TodoWrite' && block.input?.todos) {
            todoState = block.input.todos as TodoItem[];
          }
        }
      }
    }

    return { userPrompts, assistantTexts: assistantTexts.map((t) => t.trim()).filter(Boolean), todoState, messageCount, brief };
  }

  /**
   * Build the conversation text handed to insight extraction.
   *
   * The window must span the whole session arc: missions extracted from only
   * the most recent prompts collapse into whatever mini-task is currently in
   * flight, which defeats the sidebar's job of orienting on what the session
   * is FOR. Earliest prompts anchor the session's purpose; recent prompts show
   * where it has gone. Anything omitted in between is marked explicitly.
   */
  private buildInsightsConversationText(
    userPrompts: string[],
    assistantTexts: string[],
    todoState: TodoItem[] | null,
    workingDirectory: string | undefined,
    brief: string | null = null,
  ): string {
    const todoContext = todoState
      ? `\nCurrent task list (the sub-task in flight right now — context for theme/tags, NOT the mission):\n${todoState.map(t => `- [${t.status}] ${t.content}`).join('\n')}`
      : '';
    const assistantContext = assistantTexts.length > 0
      ? `\nMost recent assistant responses (current activity — context, NOT the mission):\n${assistantTexts.slice(-3).map(t => `- "${capMessage(t, 300)}"`).join('\n')}`
      : '';
    const projectContext = isGenericFolder(workingDirectory, homedir(), launchFolder())
      ? ''
      : `\nWorking directory: ${workingDirectory}`;

    const EARLIEST_COUNT = 5;
    const RECENT_COUNT = 10;
    const prompts = userPrompts.map((p) => capMessage(p));
    let promptsSection: string;
    if (prompts.length === 0) {
      promptsSection = 'User requests: none. The user has not written to this session.';
    } else if (prompts.length <= EARLIEST_COUNT + RECENT_COUNT) {
      promptsSection = `User requests (chronological, complete):\n${prompts.map(p => `- "${p}"`).join('\n')}`;
    } else {
      const earliest = prompts.slice(0, EARLIEST_COUNT);
      const recent = prompts.slice(-RECENT_COUNT);
      const omitted = prompts.length - EARLIEST_COUNT - RECENT_COUNT;
      promptsSection = [
        'Earliest user requests (session start — these anchor what the session is for):',
        ...earliest.map(p => `- "${p}"`),
        `[... ${omitted} intermediate request${omitted === 1 ? '' : 's'} omitted ...]`,
        'Most recent user requests:',
        ...recent.map(p => `- "${p}"`),
      ].join('\n');
    }

    const briefSection = brief
      ? `\nBrief this session was started with (written by its coordinator, not the user; it says what the session was set up to do):\n"${capMessage(brief)}"\n`
      : '';

    return `${projectContext}${briefSection}\n${promptsSection}\n${todoContext}${assistantContext}`;
  }

  private isArchived(sessionId: string): boolean {
    const row = this.db.prepare('SELECT archived FROM sessions WHERE session_id = ?').get(sessionId) as { archived?: number } | undefined;
    return row?.archived === 1;
  }

  /**
   * Called on turn:end from the harness event pipeline.
   * Runs in the background — never blocks the event pipeline.
   */
  async onTurnEnd(sessionId: string): Promise<void> {
    // Two turn ends can arrive together (a turn cut by a restart and the
    // resumed one); without this both pass the cooldown and both call the model.
    if (this.turnEndInFlight.has(sessionId)) return;
    this.turnEndInFlight.add(sessionId);
    try {
      await this.computeOnTurnEnd(sessionId);
    } finally {
      this.turnEndInFlight.delete(sessionId);
    }
  }

  private turnEndInFlight = new Set<string>();

  private async computeOnTurnEnd(sessionId: string): Promise<void> {
    try {
      // Feature switch, checked before the key and cooldown gates. This fires
      // on every turn of every session, so its bill tracks how much Lattice
      // gets used rather than anything anyone asked for.
      if (!allowGeneration('insights')) return;

      // API key gate
      if (!anthropicService.isConfigured()) return;

      // Archived sessions are hidden from the sidebar, and a session created
      // archived is a verification fixture; nobody reads their titles.
      if (this.isArchived(sessionId)) return;

      // Cooldown gate
      const lastComputed = this.lastComputedAt.get(sessionId);
      if (lastComputed && (Date.now() - lastComputed) < RECOMPUTE_COOLDOWN_MS) {
        this.logger.debug('Skipping insights — cooldown active', { sessionId: sessionId.slice(0, 8) });
        return;
      }

      // Read events and check minimum threshold
      const { userPrompts, assistantTexts, todoState, messageCount, brief } = this.readConversationFromEvents(sessionId);
      // A worker's brief says what it is for on its own; anything else waits for the user to say.
      if (userPrompts.length < MIN_USER_MESSAGES && !brief) return;

      // Only a new message from the user can change what the session is for.
      // Turns driven by worker reports, server notes or agent messages would
      // otherwise re-run the same prompt and get the same answer.
      const existing = await this.getInsightsRecord(sessionId);
      if (existing && existing.message_count === userPrompts.length) return;

      // Get working directory from conversation record
      let workingDirectory: string | undefined;
      try {
        const { ConversationService } = await import('../sessions/conversation-service.js');
        const conv = ConversationService.getInstance().getConversation(sessionId);
        workingDirectory = conv?.workingDirectory;
      } catch { /* optional context */ }

      this.logger.info('Computing insights from harness events', {
        sessionId: sessionId.slice(0, 8),
        userPromptCount: userPrompts.length,
        messageCount,
      });

      // Build prompt and call Anthropic
      const conversationText = this.buildInsightsConversationText(
        userPrompts, assistantTexts, todoState, workingDirectory, brief,
      );

      const result = await anthropicService.extractSessionInsights(conversationText, sessionId);

      // Declined: keep whatever was shown before, but note the count so the
      // same messages are not sent again on every later turn.
      if (!result.context) {
        await this.setInsightsRecord(existing
          ? { ...existing, message_count: userPrompts.length }
          : {
            session_id: sessionId, context: null, tags: null, theme: null, categories: null,
            computed_at: new Date().toISOString(), stale: false, message_count: userPrompts.length,
          });
        this.lastComputedAt.set(sessionId, Date.now());
        return;
      }

      // Store insights
      await this.setInsightsRecord({
        session_id: sessionId,
        context: result.context || null,
        tags: result.tags || null,
        theme: result.theme || null,
        categories: result.categories || null,
        computed_at: new Date().toISOString(),
        stale: false,
        message_count: userPrompts.length,
        purpose: result.context?.mission || undefined,
      });

      this.lastComputedAt.set(sessionId, Date.now());

      // Emit SSE so the frontend updates
      try {
        const { getSessionActivityWatcher } = await import('../sessions/session-activity-watcher.js');
        await getSessionActivityWatcher().emitInsightsUpdate(sessionId, 'generated');
      } catch {
        this.logger.debug('Failed to emit SSE for insights', { sessionId: sessionId.slice(0, 8) });
      }

      this.logger.info('Insights computed and stored', {
        sessionId: sessionId.slice(0, 8),
        mission: result.context?.mission,
        theme: result.theme,
      });
    } catch (error) {
      this.logger.warn('Insights computation failed on turn:end', {
        sessionId: sessionId.slice(0, 8),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ===========================================================================
  // ID resolution
  // ===========================================================================

  private resolveCanonicalSessionId(sessionId: string): string {
    return resolveCanonicalId(this.db, sessionId);
  }

  private isSessionNotReadyError(error: unknown): error is LatticeError {
    return error instanceof LatticeError && error.code === 'SESSION_NOT_READY';
  }

  private toSessionNotReadyError(sessionId: string): LatticeError {
    return new LatticeError(
      'SESSION_NOT_READY',
      `Session ${sessionId.slice(0, 8)} not ready for insights computation`,
      425
    );
  }

  /**
   * Extract the last N actions from recent messages (tool uses, user messages, assistant text)
   * Returns an array of {tool, timestamp} for mini action log display
   */
  extractRecentActions(messages: ConversationMessage[], limit: number = 14): Array<{ tool: string; timestamp: number }> {
    const actions: Array<{ tool: string; timestamp: number }> = [];

    // Walk backwards through messages
    for (let i = messages.length - 1; i >= 0 && actions.length < limit; i--) {
      const msg = messages[i];
      const content = msg.message?.content;
      const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();

      // User messages - handle both string and array content
      if (msg.type === 'user') {
        // String content (most common for typed user prompts)
        if (typeof content === 'string' && content.trim().length > 0) {
          actions.push({
            tool: 'User',
            timestamp
          });
          if (actions.length >= limit) break;
          continue;
        }

        // Array content - look for text blocks
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'text' &&
              'text' in block &&
              typeof block.text === 'string' &&
              block.text.trim().length > 0
            ) {
              actions.push({
                tool: 'User',
                timestamp
              });
              // Only count one user action per message
              break;
            }
          }
          if (actions.length >= limit) break;
        }
        continue;
      }

      // Skip non-array content for assistant messages
      if (!Array.isArray(content)) continue;

      // Assistant messages - both tool uses and text responses
      if (msg.type === 'assistant') {
        let hasToolUse = false;
        let _hasText = false;

        // First pass: check what types we have
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block) {
            if (block.type === 'tool_use') hasToolUse = true;
            if (block.type === 'text') _hasText = true;
          }
        }

        // Second pass: add actions
        for (const block of content) {
          if (typeof block !== 'object' || block === null || !('type' in block)) continue;

          if (block.type === 'tool_use' && 'name' in block && typeof block.name === 'string') {
            actions.push({
              tool: block.name,
              timestamp
            });

            if (actions.length >= limit) break;
          } else if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
            // Only add text response if there's no tool use in this message
            if (!hasToolUse && block.text.trim().length > 0) {
              actions.push({
                tool: 'Response',
                timestamp
              });
              // Only count one text response per message
              break;
            }
          }
        }

        if (actions.length >= limit) break;
      }
    }

    // Reverse to get chronological order (oldest first, newest last)
    return actions.reverse();
  }

  /**
   * Get full insights for a session (checks cache first)
   * For automated sessions, returns quick insights without AI generation.
   *
   * NON-BLOCKING BEHAVIOR:
   * - If cache is fresh → return it immediately
   * - If cache is stale → return stale data immediately, trigger background regeneration
   * - If no cache → generate synchronously (first time only)
   */
  async getInsights(sessionId: string): Promise<SessionInsights> {
    const canonicalSessionId = this.resolveCanonicalSessionId(sessionId);
    sessionId = canonicalSessionId;

    this.logger.debug('[GET INSIGHTS] Called', {
      sessionId: sessionId.slice(0, 8),
    });

    // Check cache first
    const cached = await this.getInsightsRecord(sessionId);

    if (cached && !cached.stale) {
      return this.cachedToSessionInsights(cached);
    }

    // NON-BLOCKING: If we have stale cache, return it immediately and regenerate in background
    if (cached && cached.stale) {
      this.logger.debug('[GET INSIGHTS] Returning stale cache, triggering background regeneration', {
        sessionId: sessionId.slice(0, 8)
      });

      // Fire off background regeneration (don't await)
      this.regenerateInsightsInBackground(sessionId, cached).catch((err: unknown) =>
        this.logger.debug('Background regeneration failed', { sessionId, error: err })
      );

      // Return stale data immediately for fast UX
      return this.cachedToSessionInsights(cached);
    }

    // No cache at all - must generate synchronously (first time for this session)
    this.logger.debug('[GET INSIGHTS] No cache - triggering synchronous generation', {
      sessionId: sessionId.slice(0, 8)
    });

    const traceId = generateTraceId(sessionId);
    const startTime = Date.now();
    const beforeState = buildStateSnapshot(cached);

    let insights: SessionInsights & { messageCount: number };
    try {
      insights = await this.computeInsights(sessionId);
    } catch (error) {
      if (this.isSessionNotReadyError(error)) {
        this.logger.debug('[GET INSIGHTS] Session not ready, returning quick fallback', {
          sessionId: sessionId.slice(0, 8),
          code: error.code,
          statusCode: error.statusCode,
        });
        return this.getInsightsQuick(sessionId);
      }
      throw error;
    }

    // Cache the result and audit the recompute
    const afterState = buildStateSnapshot(null, insights);
    const changedFields: string[] = [];
    if (beforeState.mission !== afterState.mission) changedFields.push('mission');
    if (beforeState.theme !== afterState.theme) changedFields.push('theme');
    if (beforeState.purpose !== afterState.purpose) changedFields.push('purpose');

    const durationMs = Date.now() - startTime;

    // Audit the recompute
    InsightAuditRepository.getInstance().auditEvent({
      traceId,
      sessionId,
      eventType: 'recompute',
      trigger: 'api_request',
      beforeState,
      afterState,
      patchedFields: changedFields,
      durationMs,
      llmResponse: `Sonnet returned: context=${!!insights.context}, theme=${insights.theme}`,
    });

    // Cache the result (don't await - fire and forget)
    this.cacheInsights(sessionId, insights).catch((err: unknown) =>
      this.logger.debug('Failed to cache insights', { sessionId, error: err })
    );

    return insights;
  }

  /**
   * Regenerate insights in the background (for stale cache refresh).
   * This runs async and updates the cache when done.
   */
  private async regenerateInsightsInBackground(sessionId: string, existingCache: InsightsRecord): Promise<void> {
    const traceId = generateTraceId(sessionId);
    const startTime = Date.now();
    const beforeState = buildStateSnapshot(existingCache);

    this.logger.info('[BACKGROUND REGEN] Starting', {
      traceId,
      sessionId: sessionId.slice(0, 8)
    });

    try {
      const insights = await this.computeInsights(sessionId);

      // Cache the result and audit the recompute
      const afterState = buildStateSnapshot(null, insights);
      const changedFields: string[] = [];
      if (beforeState.mission !== afterState.mission) changedFields.push('mission');
      if (beforeState.theme !== afterState.theme) changedFields.push('theme');
      if (beforeState.purpose !== afterState.purpose) changedFields.push('purpose');

      const durationMs = Date.now() - startTime;

      // Audit the recompute
      InsightAuditRepository.getInstance().auditEvent({
        traceId,
        sessionId,
        eventType: 'recompute',
        trigger: 'background_stale_refresh',
        beforeState,
        afterState,
        patchedFields: changedFields,
        durationMs,
        llmResponse: `Sonnet returned: context=${!!insights.context}, theme=${insights.theme}`,
      });

      await this.cacheInsights(sessionId, insights);

      this.logger.info('[BACKGROUND REGEN] Completed', {
        traceId,
        sessionId: sessionId.slice(0, 8),
        durationMs,
        changedFields
      });
    } catch (error) {
      this.logger.warn('[BACKGROUND REGEN] Failed - existing cache preserved', {
        traceId,
        sessionId: sessionId.slice(0, 8),
        error
      });
      // Don't throw - this is a background operation
      // IMPORTANT: We intentionally don't cache anything on failure to preserve existing good data
    }
  }

  /**
   * Compute insights from conversation (bypasses cache)
   */
  async computeInsights(sessionId: string): Promise<SessionInsights & { messageCount: number }> {
    // Unlike onTurnEnd, something is waiting on this — so it fails loudly
    // rather than returning an empty result that would be cached as truth.
    if (!allowGeneration('insights')) {
      throw new LatticeError(
        'GENERATION_DISABLED',
        `Insight generation is off — set generation.insights to true in ${CONFIG_FILE}`,
        503,
      );
    }

    const canonicalSessionId = this.resolveCanonicalSessionId(sessionId);

    // Read conversation from harness events
    const { userPrompts, assistantTexts, todoState, brief } = this.readConversationFromEvents(canonicalSessionId);

    if (userPrompts.length === 0 && !brief) {
      throw this.toSessionNotReadyError(canonicalSessionId);
    }

    // Get working directory for project context
    let projectPath: string | undefined;
    try {
      const { ConversationService } = await import('../sessions/conversation-service.js');
      const conv = ConversationService.getInstance().getConversation(canonicalSessionId);
      projectPath = conv?.workingDirectory;
    } catch { /* optional context */ }

    const conversationText = this.buildInsightsConversationText(
      userPrompts, assistantTexts, todoState, projectPath, brief,
    );

    const result = await anthropicService.extractSessionInsights(conversationText, canonicalSessionId);

    // Declined: callers cache what this returns, so hand back the previous
    // insights rather than overwrite them with nothing.
    if (!result.context) {
      const previous = await this.getInsightsRecord(canonicalSessionId);
      return {
        ...(previous ? this.cachedToSessionInsights(previous) : { context: null, tags: null, theme: null }),
        sessionId: canonicalSessionId,
        messageCount: userPrompts.length,
      };
    }

    return {
      sessionId: canonicalSessionId,
      context: result.context || null,
      tags: result.tags || null,
      theme: result.theme || null,
      categories: result.categories || null,
      // The user-message count, as onTurnEnd stores it, so its new-message check holds after this path too.
      messageCount: userPrompts.length,
    };
  }

  /**
   * Cache insights to database
   */
  async cacheInsights(sessionId: string, insights: SessionInsights & { messageCount?: number }): Promise<InsightsRecord> {
    const now = new Date().toISOString();
    const canonicalSessionId = this.resolveCanonicalSessionId(sessionId);

    // Preserve fields that are set by the fast-path patch system (Haiku),
    // not by the full compute (Sonnet). A recompute should not wipe these.
    const existing = await this.getInsightsRecord(canonicalSessionId);
    const purposeToCache = insights.purpose || existing?.purpose;

    const cached: InsightsRecord = {
      session_id: canonicalSessionId,
      context: insights.context,
      tags: insights.tags,
      theme: insights.theme,
      categories: insights.categories ?? existing?.categories ?? null,
      computed_at: now,
      stale: false,
      message_count: insights.messageCount,
      purpose: purposeToCache,
    };
    await this.setInsightsRecord(cached);

    return cached;
  }

  /**
   * Convert cached insights to SessionInsights format
   */
  private cachedToSessionInsights(cached: InsightsRecord): SessionInsights {
    return {
      sessionId: cached.session_id,
      context: cached.context as SessionContext | null,
      tags: cached.tags as SessionTags | null,
      theme: cached.theme as SessionInsights['theme'],
      categories: cached.categories ?? null,
      computedAt: cached.computed_at,
      patchedAt: cached.patched_at,
      purpose: cached.purpose,
    };
  }

  /**
   * Get cached insights for multiple sessions (for list view)
   */
  async getCachedInsightsForSessions(sessionIds: string[]): Promise<Map<string, SessionInsights>> {
    // Resolve canonical IDs (conv-* IDs pass through unchanged)
    const canonicalIds = sessionIds.map(id => this.resolveCanonicalSessionId(id));
    const uniqueCanonicalIds = [...new Set(canonicalIds)];

    // Use batch query instead of fetching all insights
    const batchCached = await this.getInsightsRecordBatch(uniqueCanonicalIds);
    const result = new Map<string, SessionInsights>();

    for (let i = 0; i < sessionIds.length; i++) {
      const cached = batchCached.get(canonicalIds[i]);
      if (cached) {
        result.set(sessionIds[i], this.cachedToSessionInsights(cached));
      }
    }

    return result;
  }

  /**
   * Recompute insights for stale sessions (force refresh)
   */
  async recomputeStaleInsights(sessionIds: string[], maxConcurrent = 3): Promise<number> {
    if (sessionIds.length === 0) {
      return 0;
    }

    this.logger.debug('Recomputing stale insights', { count: sessionIds.length });

    // Process in batches to avoid overwhelming the system
    let computed = 0;
    for (let i = 0; i < sessionIds.length; i += maxConcurrent) {
      const batch = sessionIds.slice(i, i + maxConcurrent);
      await Promise.all(
        batch.map(async (sessionId) => {
          const traceId = generateTraceId(sessionId);
          const startTime = Date.now();

          try {
            // Get existing cache BEFORE regenerating
            const existingCache = await this.getInsightsRecord(sessionId);
            const beforeState = buildStateSnapshot(existingCache);

            this.logger.debug('Computing insights for session', { traceId, sessionId });
            const insights = await this.computeInsights(sessionId);

            await this.cacheInsights(sessionId, insights);
            computed++;

            // Build after state and determine what changed
            const afterState = buildStateSnapshot(null, insights);
            const changedFields: string[] = [];
            if (beforeState.mission !== afterState.mission) changedFields.push('mission');
            if (beforeState.theme !== afterState.theme) changedFields.push('theme');
            if (beforeState.purpose !== afterState.purpose) changedFields.push('purpose');

            const durationMs = Date.now() - startTime;

            // Audit the recompute with full before/after state
            InsightAuditRepository.getInstance().auditEvent({
              traceId,
              sessionId,
              eventType: 'recompute',
              trigger: 'stale_refresh',
              beforeState,
              afterState,
              patchedFields: changedFields,
              durationMs,
              llmResponse: `Sonnet returned: context=${!!insights.context}, theme=${insights.theme}`,
            });

            this.logger.info('Insights computed successfully', {
              traceId,
              sessionId,
              changedFields,
              durationMs,
            });
          } catch (error) {
            if (this.isSessionNotReadyError(error)) {
              this.logger.debug('Skipping stale insights recompute - session not ready', {
                traceId,
                sessionId: sessionId.slice(0, 8),
                code: error.code,
              });
              return;
            }
            this.logger.warn('Failed to compute insights for session', { traceId, sessionId, error });
          }
        })
      );
    }

    return computed;
  }

  /**
   * Build a text context string from conversation messages for Gemini consultation.
   * Includes project path, existing mission/purpose, and a truncated transcript.
   */
  async buildConsultationContext(
    sessionId: string,
    messages: ConversationMessage[],
    projectPath?: string,
  ): Promise<string> {
    const contextParts: string[] = [];
    if (projectPath) {
      contextParts.push(`Project directory: ${projectPath}`);
    }

    const existingInsights = await this.getInsightsRecord(sessionId);
    if (existingInsights?.context?.mission) {
      contextParts.push(`Session mission: ${existingInsights.context.mission}`);
    }
    if (existingInsights?.purpose) {
      contextParts.push(`Session purpose: ${existingInsights.purpose}`);
    }

    contextParts.push(`Session transcript (${messages.length} messages):`);
    contextParts.push('---');

    let totalChars = 0;
    const MAX_CHARS = 500_000;

    for (const msg of messages) {
      const content = msg.message?.content;
      let text = '';

      if (typeof content === 'string') {
        text = content.slice(0, 2000);
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block) {
            if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
              parts.push(block.text.slice(0, 2000));
            } else if (block.type === 'tool_use' && 'name' in block) {
              const inputPreview = 'input' in block && block.input
                ? JSON.stringify(block.input).slice(0, 200)
                : '';
              parts.push(`[Tool: ${block.name as string}] ${inputPreview}`);
            }
          }
        }
        text = parts.join('\n');
      }

      if (!text) continue;

      const prefix = msg.type === 'user' ? '## USER:' : '## ASSISTANT:';
      const entry = `${prefix}\n${text}`;

      if (totalChars + entry.length > MAX_CHARS) {
        contextParts.push(`\n... [remaining messages truncated at ${MAX_CHARS} chars] ...`);
        break;
      }

      contextParts.push(entry);
      totalChars += entry.length;
    }

    return contextParts.join('\n\n');
  }

  // In-flight dedup for backfillMissing — prevents duplicate API calls when
  // the list endpoint is hit concurrently.
  private backfillInFlight = new Set<string>();

  /**
   * Failure memory for backfillMissing: conversationId -> epoch ms before
   * which we will not attempt another mission compute.
   *
   * In-flight dedup alone was not enough. A conversation that structurally
   * cannot produce a mission (no readable messages, a provider error that
   * recurs) came back missing on the next sidebar list fetch and re-triggered
   * a real LLM call — forever, once per list request, with the error swallowed.
   */
  private backfillCooldownUntil = new Map<string, number>();
  /** How long a conversation is left alone after a failed or empty compute. */
  private static readonly BACKFILL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

  /**
   * Backfill missing missions and identity images for a set of conversations.
   * Non-blocking, fire-and-forget with internal dedup. Designed to be called
   * from the list endpoint on every load.
   */
  async backfillMissing(conversationIds: string[]): Promise<void> {
    // Fires from the conversation list on every load, for every session
    // missing insights — the widest fan-out of any spend path here.
    if (!allowGeneration('insights')) return;
    if (conversationIds.length === 0) return;

    let cachedInsights = new Map<string, SessionInsights>();
    try {
      cachedInsights = await this.getCachedInsightsForSessions(conversationIds);
    } catch (err) {
      this.logger.warn('Failed to read cached insights for backfill', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const now = Date.now();

    // Backfill missions for sessions that don't have one yet
    const missingMissionIds = conversationIds.filter((id) => {
      if (cachedInsights.get(id)?.context?.mission) {
        // A mission exists now — whatever kept it from computing is resolved.
        this.backfillCooldownUntil.delete(id);
        return false;
      }
      if (this.backfillInFlight.has(`mission:${id}`)) return false;
      const cooldownUntil = this.backfillCooldownUntil.get(id);
      if (cooldownUntil !== undefined && cooldownUntil > now) return false;
      return true;
    });

    if (missingMissionIds.length > 0) {
      for (const id of missingMissionIds) this.backfillInFlight.add(`mission:${id}`);
      this.recomputeStaleInsights(missingMissionIds, 2)
        .then(() => this.recordBackfillOutcome(missingMissionIds))
        .catch((err: unknown) => {
          this.logger.warn('Mission backfill failed', {
            count: missingMissionIds.length,
            error: err instanceof Error ? err.message : String(err),
          });
          this.startBackfillCooldown(missingMissionIds);
        })
        .finally(() => {
          for (const id of missingMissionIds) this.backfillInFlight.delete(`mission:${id}`);
        });
    }

  }

  /**
   * After a backfill pass, put any conversation that still has no mission on
   * cooldown. recomputeStaleInsights swallows per-session errors, so the cache
   * is the only honest signal of whether the compute actually produced one.
   */
  private async recordBackfillOutcome(conversationIds: string[]): Promise<void> {
    let afterInsights = new Map<string, SessionInsights>();
    try {
      afterInsights = await this.getCachedInsightsForSessions(conversationIds);
    } catch (err) {
      this.logger.warn('Failed to verify backfill outcome; backing off', {
        count: conversationIds.length,
        error: err instanceof Error ? err.message : String(err),
      });
      this.startBackfillCooldown(conversationIds);
      return;
    }

    const stillMissing = conversationIds.filter(
      (id) => !afterInsights.get(id)?.context?.mission
    );
    if (stillMissing.length === 0) return;

    this.startBackfillCooldown(stillMissing);
    this.logger.warn('Mission backfill produced no mission; backing off', {
      count: stillMissing.length,
      cooldownMs: InsightsEngine.BACKFILL_COOLDOWN_MS,
      conversationIds: stillMissing.slice(0, 5),
    });
  }

  private startBackfillCooldown(conversationIds: string[]): void {
    const now = Date.now();

    // Opportunistic prune so the map tracks live backoffs, not history.
    for (const [id, until] of this.backfillCooldownUntil) {
      if (until <= now) this.backfillCooldownUntil.delete(id);
    }

    const until = now + InsightsEngine.BACKFILL_COOLDOWN_MS;
    for (const id of conversationIds) {
      this.backfillCooldownUntil.set(id, until);
    }
  }

  /**
   * Get insights without AI generation (faster, for list views)
   */
  async getInsightsQuick(sessionId: string): Promise<SessionInsights> {
    const canonicalSessionId = this.resolveCanonicalSessionId(sessionId);

    // Check cache first - return cached AI insights if available
    const cached = await this.getInsightsRecord(canonicalSessionId);
    if (cached) {
      return this.cachedToSessionInsights(cached);
    }

    // No cached insights - return minimal structure
    return {
      sessionId: canonicalSessionId,
      context: null,
      tags: null,
      theme: null,
    };
  }

}
