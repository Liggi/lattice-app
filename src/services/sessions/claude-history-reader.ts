import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ConversationSummary, ConversationMessage, ConversationListQuery, LatticeError, ToolMetrics } from '@/types/index.js';

import { createLogger, type Logger } from '../infrastructure/logger.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { SessionInfoService } from '../sessions/session-info-service.js';
import { ConversationCache, ConversationChain } from '../sessions/conversation-cache.js';
import { readMessages } from '../../harness/event-message-reader.js';
import type { UnifiedMessage, UnifiedContentBlock } from '@/types/unified-messages.js';
import { MessageFilter } from '../message-filter.js';
import Anthropic from '@anthropic-ai/sdk';
import type { RawJsonEntry } from './claude-history-types.js';
import { parseJson } from '../../utils/json.js';

/**
 * Reads conversation history from Claude's local storage
 */
/** Short-lived cache entry for fetchConversationDirect results */
interface FetchDirectCacheEntry {
  result: { messages: ConversationMessage[]; metadata: { summary: string; projectPath: string; model: string; totalDuration: number } };
  mtimeMs: number;
  cachedAt: number;
}

export class ClaudeHistoryReader {
  private claudeHomePath: string;
  private logger: Logger;
  private sessionInfoService: SessionInfoService;
  private conversationCache: ConversationCache;
  private messageFilter: MessageFilter;

  // Short-lived cache for fetchConversationDirect — prevents dual watchers
  // from redundantly reading + parsing the same JSONL file within a small window.
  private fetchDirectCache: Map<string, FetchDirectCacheEntry> = new Map();
  private readonly FETCH_DIRECT_CACHE_TTL_MS = 500;

  constructor(sessionInfoService?: SessionInfoService) {
    this.claudeHomePath = path.join(os.homedir(), '.claude');
    this.logger = createLogger('ClaudeHistoryReader');
    this.sessionInfoService = sessionInfoService || SessionInfoService.getInstance();
    this.conversationCache = new ConversationCache();
    this.messageFilter = new MessageFilter();
  }

  get homePath(): string {
    return this.claudeHomePath;
  }

  /**
   * Clear the conversation cache to force a refresh on next read
   */
  clearCache(): void {
    this.conversationCache.clear();
  }

  /**
   * List all conversations with optional filtering
   */
  async listConversations(filter?: ConversationListQuery): Promise<{
    conversations: ConversationSummary[];
    total: number;
  }> {
    const timings: Record<string, number> = {};
    const startTime = Date.now();

    try {
      // FAST PATH: For archived=true queries, use DB-only path (avoids parsing JSONL files)
      // This is critical for performance - archived sessions can number in the thousands
      // Skip fast path if workspace filter is specified (needs full DB query with workspace column)
      if (filter?.archived === true && filter?.pinned === undefined && filter?.workspace === undefined) {
        return await this.listArchivedConversationsFast(filter, timings, startTime);
      }

      // SLOW PATH: Parse JSONL files for non-archived or mixed queries

      // Fetch ALL session info first - needed to filter before expensive parsing
      const sessionInfoStart = Date.now();
      const allSessionInfo = await this.sessionInfoService.getAllSessionInfo();
      timings.getAllSessionInfo = Date.now() - sessionInfoStart;

      // Fetch ALL insights - needed for cached tool metrics (Phase 1 optimization)
      const insightsStart = Date.now();
      const db = DatabaseProvider.getInstance().getDb();
      const insightRows = db.prepare('SELECT * FROM session_insights').all() as Array<{
        session_id: string; lines_added?: number; lines_removed?: number;
        edit_count?: number; write_count?: number; metrics_updated_at?: string | null;
      }>;
      const allInsights = new Map(insightRows.map(r => [r.session_id, r]));
      timings.getAllInsights = Date.now() - insightsStart;

      // Pre-filter session IDs based on archived/pinned/workspace filters to avoid parsing unwanted files
      let allowedSessionIds: Set<string> | null = null;
      if (filter?.archived !== undefined || filter?.pinned !== undefined || filter?.workspace !== undefined) {
        allowedSessionIds = new Set<string>();
        for (const [sessionId, info] of Object.entries(allSessionInfo)) {
          // Apply archive filter
          if (filter.archived !== undefined && info.archived !== filter.archived) {
            continue;
          }
          // Apply pinned filter
          if (filter.pinned !== undefined && info.pinned !== filter.pinned) {
            continue;
          }
          // Apply workspace filter (sessions default to 'main' if not set)
          if (filter.workspace !== undefined) {
            const sessionWorkspace = info.workspace || 'main';
            if (sessionWorkspace !== filter.workspace) {
              continue;
            }
          }
          allowedSessionIds.add(sessionId);
        }
      }

      // Parse conversations (optionally filtered by sessionId)
      const parseStart = Date.now();
      const conversationChains = await this.parseAllConversations(allowedSessionIds);
      timings.parseAllConversations = Date.now() - parseStart;

      // Track sessions that need metrics backfilled (fire-and-forget after response)
      const metricsToBackfill: Array<{ sessionId: string; metrics: ToolMetrics; messageCount: number }> = [];

      // Convert to ConversationSummary format and enhance with custom names
      const allConversations: ConversationSummary[] = conversationChains.map((chain) => {
        // Use bulk-fetched session info (O(1) lookup instead of async query)
        // Default to archived: false - externally-started sessions should appear in sidebar.
        // Users archive sessions manually when done.
        const sessionInfo = allSessionInfo[chain.sessionId] || {
          custom_name: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 4,
          pinned: false,
          archived: false,
          continuation_session_id: '',
          initial_commit_head: '',
          permission_mode: 'default',
          workspace: 'main'
        };

        // Use cached tool metrics if available (Phase 1 optimization)
        const cachedInsights = allInsights.get(chain.sessionId);
        let toolMetrics: ToolMetrics;

        if (cachedInsights?.metrics_updated_at) {
          // Use cached metrics - fast path
          toolMetrics = {
            linesAdded: cachedInsights.lines_added || 0,
            linesRemoved: cachedInsights.lines_removed || 0,
            editCount: cachedInsights.edit_count || 0,
            writeCount: cachedInsights.write_count || 0
          };
        } else {
          toolMetrics = { linesAdded: 0, linesRemoved: 0, editCount: 0, writeCount: 0 };
        }

        return {
          providerSessionId: chain.sessionId,
          projectPath: chain.projectPath,
          summary: chain.summary,
          sessionInfo: sessionInfo,
          createdAt: chain.createdAt,
          updatedAt: chain.updatedAt,
          messageCount: chain.messages.length,
          totalDuration: chain.totalDuration,
          model: chain.model,
          status: 'completed' as const, // Default status, will be updated by server
          toolMetrics: toolMetrics
        };
      });

      // Backfill metrics in background (don't block response)
      if (metricsToBackfill.length > 0) {
        this.logger.info('Backfilling tool metrics for sessions without cache', {
          count: metricsToBackfill.length
        });
        // Fire and forget - update DB in background
        const metricsDb = DatabaseProvider.getInstance().getDb();
        Promise.all(
          metricsToBackfill.map(({ sessionId, metrics, messageCount }) => {
            try {
              metricsDb.prepare(`
                INSERT INTO session_insights (session_id, computed_at, stale, lines_added, lines_removed, edit_count, write_count, metrics_updated_at, message_count)
                VALUES (?, datetime('now'), 1, ?, ?, ?, ?, datetime('now'), ?)
                ON CONFLICT(session_id) DO UPDATE SET
                  lines_added=excluded.lines_added, lines_removed=excluded.lines_removed,
                  edit_count=excluded.edit_count, write_count=excluded.write_count,
                  metrics_updated_at=excluded.metrics_updated_at,
                  message_count=COALESCE(excluded.message_count, message_count)
              `).run(sessionId, metrics.linesAdded, metrics.linesRemoved, metrics.editCount, metrics.writeCount, messageCount ?? null);
            } catch (err) {
              this.logger.warn('Metrics backfill failed', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            return Promise.resolve();
          })
        ).catch((err) => {
          this.logger.warn('Metrics backfill batch failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      // Apply filters and pagination
      const filterStart = Date.now();
      const filtered = this.applyFilters(allConversations, filter);
      const paginated = this.applyPagination(filtered, filter);
      timings.filterAndPaginate = Date.now() - filterStart;

      timings.total = Date.now() - startTime;
      this.logger.debug('listConversations breakdown', {
        timingsMs: timings,
        sessionInfoCount: Object.keys(allSessionInfo).length,
        insightsCount: allInsights.size,
        conversationChainsCount: conversationChains.length,
        filteredCount: filtered.length,
        paginatedCount: paginated.length,
        allowedSessionIds: allowedSessionIds?.size ?? 'all',
      });

      return {
        conversations: paginated,
        total: filtered.length
      };
    } catch (error) {
      throw new LatticeError('HISTORY_READ_FAILED', `Failed to read conversation history: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  }

  /**
   * Fast path for listing archived sessions - queries DB directly without parsing JSONL files.
   * This is ~100x faster than the file-parsing path for large archives.
   */
  private async listArchivedConversationsFast(
    filter: ConversationListQuery,
    timings: Record<string, number>,
    startTime: number
  ): Promise<{ conversations: ConversationSummary[]; total: number }> {
    const dbStart = Date.now();

    // Get total count for pagination
    const total = this.sessionInfoService.getArchivedSessionCount();

    // Get paginated archived sessions with insights from DB
    const limit = filter.limit || 20;
    const offset = filter.offset || 0;
    const dbResults = this.sessionInfoService.getArchivedSessionsWithInsights(limit, offset);

    timings.dbQuery = Date.now() - dbStart;

    // Convert to ConversationSummary format
    const conversations: ConversationSummary[] = dbResults.map(({ sessionId, sessionInfo, insights }) => {
      // Build tool metrics from insights if available
      const toolMetrics: ToolMetrics = insights?.metrics_updated_at ? {
        linesAdded: insights.lines_added || 0,
        linesRemoved: insights.lines_removed || 0,
        editCount: insights.edit_count || 0,
        writeCount: insights.write_count || 0
      } : {
        linesAdded: 0,
        linesRemoved: 0,
        editCount: 0,
        writeCount: 0
      };

      return {
        providerSessionId: sessionId,
        projectPath: '', // Not available without parsing JSONL - acceptable for archive view
        summary: insights?.purpose || insights?.context?.mission || sessionInfo.custom_name || 'Archived session',
        sessionInfo,
        createdAt: sessionInfo.created_at,
        updatedAt: sessionInfo.updated_at,
        messageCount: insights?.message_count || 0,
        totalDuration: 0, // Not available without parsing JSONL
        model: 'Unknown', // Not available without parsing JSONL
        status: 'completed' as const,
        toolMetrics
      };
    });

    timings.total = Date.now() - startTime;

    this.logger.debug('listArchivedConversationsFast', {
      timingsMs: timings,
      total,
      returnedCount: conversations.length,
      limit,
      offset
    });

    return { conversations, total };
  }

  /**
   * Get the file path for a session's JSONL file.
   * Public wrapper around findSessionFile.
   */
  async getSessionFilePath(sessionId: string): Promise<string | null> {
    return this.findSessionFile(sessionId);
  }

  /**
   * Whether a session's transcript is still on disk — the file `--resume`
   * needs. Three-valued on purpose.
   *
   * `claudeHomePath` is `~/.claude`, which ignores CLAUDE_CONFIG_DIR, so a
   * "not found" can mean either "Claude pruned it" or "we are looking in the
   * wrong place entirely" (a relocated config dir, a test home, a fresh
   * install). Callers that block on this must not treat the second case as the
   * first: doing so would refuse every resume on such a machine. When no
   * transcript store is visible at all, the honest answer is 'unknown'.
   */
  async classifyTranscript(sessionId: string): Promise<'present' | 'missing' | 'unknown'> {
    const projectsPath = path.join(this.claudeHomePath, 'projects');

    let storeHasTranscripts = false;
    try {
      for (const project of await this.readDirectory(projectsPath)) {
        const entries = await this.readDirectory(path.join(projectsPath, project))
          .catch(() => [] as string[]);
        if (entries.some(name => name.endsWith('.jsonl'))) {
          storeHasTranscripts = true;
          break;
        }
      }
    } catch {
      return 'unknown';
    }
    if (!storeHasTranscripts) return 'unknown';

    return (await this.findSessionFile(sessionId)) ? 'present' : 'missing';
  }

  /**
   * Extract the first user prompt from a session's JSONL file.
   * Reads only enough lines to find the first user message.
   */
  async getFirstUserPrompt(sessionId: string): Promise<string | null> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) return null;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = parseJson(line);
          if (!parsed || typeof parsed !== 'object') continue;

          const entry = parsed as { type?: unknown; message?: unknown };
          if (entry.type !== 'user' || !entry.message || typeof entry.message !== 'object') continue;

          const contentValue = (entry.message as { content?: unknown }).content;
          if (typeof contentValue === 'string') return contentValue;

          if (Array.isArray(contentValue)) {
            const textBlock = contentValue.find((block): block is { type: 'text'; text: string } => (
              !!block
              && typeof block === 'object'
              && (block as { type?: unknown }).type === 'text'
              && typeof (block as { text?: unknown }).text === 'string'
            ));
            if (textBlock) return textBlock.text;
          }
        } catch { continue; }
      }
    } catch { /* file read error */ }

    return null;
  }

  /**
   * Fallback: convert messages from harness event storage
   * into ConversationMessage[] so the insights pipeline can process them.
   */
  private fetchFromEventStorage(sessionId: string): ConversationMessage[] {
    try {
      const unified = readMessages(sessionId);
      if (unified.length === 0) return [];

      return unified.map((msg: UnifiedMessage, idx: number) => {
        // Convert UnifiedContentBlock[] → Anthropic-compatible content
        const anthropicContent = msg.content
          .filter((b: UnifiedContentBlock) => b.type === 'text' || b.type === 'tool_use' || b.type === 'tool_result')
          .map((b: UnifiedContentBlock) => {
            if (b.type === 'text') return { type: 'text' as const, text: b.text };
            if (b.type === 'tool_use') return { type: 'tool_use' as const, id: b.id || `tool-${idx}`, name: b.name || 'unknown', input: b.input ?? {} };
            if (b.type === 'tool_result') return { type: 'text' as const, text: typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '') };
            return { type: 'text' as const, text: '' };
          });

        return {
          uuid: msg.id || `codex-${idx}`,
          type: msg.role === 'user' ? 'user' as const : 'assistant' as const,
          message: { role: msg.role, content: anthropicContent } as Anthropic.MessageParam,
          timestamp: msg.timestamp,
          sessionId,
          provider: msg.provider || 'codex',
        };
      });
    } catch (err) {
      this.logger.debug('Event storage fallback failed', { sessionId: sessionId.slice(0, 8), err });
      return [];
    }
  }

  /**
   * Find the JSONL file for a session by checking each project folder
   * Returns the file path if found, null otherwise
   */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    const projectsPath = path.join(this.claudeHomePath, 'projects');

    try {
      const projects = await this.readDirectory(projectsPath);

      for (const project of projects) {
        const projectPath = path.join(projectsPath, project);
        const stats = await fs.stat(projectPath);
        if (!stats.isDirectory()) continue;

        const sessionFile = path.join(projectPath, `${sessionId}.jsonl`);
        try {
          await fs.access(sessionFile);
          return sessionFile;
        } catch {
          // File doesn't exist in this project, continue searching
        }
      }

      return null;
    } catch (error) {
      this.logger.error('Error searching for session file', error, { sessionId });
      return null;
    }
  }

  /**
   * Get file modification times for multiple sessions
   * Used for lightweight activity detection without reading file contents
   */
  async getSessionFileMtimes(sessionIds: string[]): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    await Promise.all(
      sessionIds.map(async (sessionId) => {
        const filePath = await this.findSessionFile(sessionId);
        if (filePath) {
          try {
            const stats = await fs.stat(filePath);
            results.set(sessionId, stats.mtimeMs);
          } catch {
            // File not accessible, skip
          }
        }
      })
    );

    return results;
  }

  /**
   * Get sessions that are "recently active" based on file modification time.
   * A session is considered active if its JSONL file was modified within the threshold.
   * This is more reliable than fuser since Claude writes frequently during activity.
   *
   * @param sessionIds - Session IDs to check
   * @param thresholdMs - How recent the mtime must be (default: 60 seconds)
   * @returns Set of session IDs that are recently active
   */
  async getRecentlyActiveSessionsByMtime(sessionIds: string[], thresholdMs: number = 60000): Promise<Set<string>> {
    const activeSet = new Set<string>();
    const now = Date.now();
    const projectsPath = path.join(this.claudeHomePath, 'projects');

    // Build a Set for O(1) lookup
    const sessionIdSet = new Set(sessionIds);

    try {
      // Get all project directories
      const projects = await this.readDirectory(projectsPath);

      // Check all JSONL files in parallel across all projects
      await Promise.all(
        projects.map(async (project) => {
          const projectDir = path.join(projectsPath, project);
          try {
            const stats = await fs.stat(projectDir);
            if (!stats.isDirectory()) return;

            const files = await this.readDirectory(projectDir);
            await Promise.all(
              files
                .filter(f => f.endsWith('.jsonl'))
                .map(async (file) => {
                  const sessionId = file.replace('.jsonl', '');
                  if (!sessionIdSet.has(sessionId)) return;

                  try {
                    const filePath = path.join(projectDir, file);
                    const fileStats = await fs.stat(filePath);
                    const ageMs = now - fileStats.mtimeMs;

                    if (ageMs < thresholdMs) {
                      activeSet.add(sessionId);
                      this.logger.debug('Session detected as active by mtime', {
                        sessionId: sessionId.slice(0, 8),
                        ageSeconds: Math.round(ageMs / 1000)
                      });
                    }
                  } catch {
                    // File not accessible, skip
                  }
                })
            );
          } catch {
            // Project dir not accessible, skip
          }
        })
      );

      return activeSet;
    } catch (error) {
      this.logger.error('Error checking session mtimes', error);
      return activeSet;
    }
  }


  /**
   * Fetch conversation with metadata in a single fast operation
   * Uses direct file lookup instead of parsing all conversations
   */
  async fetchConversationDirect(sessionId: string): Promise<{
    messages: ConversationMessage[];
    metadata: { summary: string; projectPath: string; model: string; totalDuration: number };
  }> {
    const startTime = Date.now();

    try {
      // Find the session file directly
      const filePath = await this.findSessionFile(sessionId);

      if (!filePath) {
        // Fallback: check harness event storage
      const messages = this.fetchFromEventStorage(sessionId);
        if (messages.length > 0) {
          const elapsed = Date.now() - startTime;
          this.logger.debug('fetchConversationDirect: using event storage fallback', {
            sessionId: sessionId.slice(0, 8),
            messageCount: messages.length,
            elapsedMs: elapsed,
          });
          return {
            messages,
            metadata: { summary: '', projectPath: '', model: 'codex', totalDuration: 0 },
          };
        }

        this.logger.debug('fetchConversationDirect: session JSONL file not found', { sessionId });
        throw new LatticeError('CONVERSATION_NOT_FOUND', `Conversation ${sessionId} not found`, 404);
      }

      // --- Short-lived cache: if file hasn't changed since last read within TTL, reuse ---
      let fileMtimeMs: number;
      try {
        const stat = await fs.stat(filePath);
        fileMtimeMs = stat.mtimeMs;
      } catch {
        fileMtimeMs = 0; // stat failed — skip cache
      }

      const cached = this.fetchDirectCache.get(sessionId);
      const now = Date.now();
      if (cached && cached.mtimeMs === fileMtimeMs && (now - cached.cachedAt) < this.FETCH_DIRECT_CACHE_TTL_MS) {
        this.logger.debug('fetchConversationDirect: cache hit', {
          sessionId: sessionId.slice(0, 8),
          cacheAgeMs: now - cached.cachedAt,
        });
        return cached.result;
      }

      // Parse just this one file
      const allEntries = await this.parseJsonlFile(filePath);

      // Extract project path from file path
      const projectsPath = path.join(this.claudeHomePath, 'projects');
      const relativePath = filePath.replace(projectsPath + path.sep, '');
      const projectName = relativePath.split(path.sep)[0];
      const projectPath = this.decodeProjectName(projectName);

      // Get summary from global summaries.json — also check JSONL-embedded summaries
      const summary = await this.getSummaryForSession(sessionId);
      const summaryMap = new Map<string, string>();
      if (summary) summaryMap.set(sessionId, summary);

      // Process embedded summaries (type: "summary" entries with leafUuid)
      const embeddedSummaries = this.processSummaries(allEntries);
      for (const [leafUuid, summaryText] of embeddedSummaries) {
        summaryMap.set(leafUuid, summaryText);
      }

      // Filter to only user/assistant messages (exclude summary, queue-operation, etc.)
      // These non-message entries have null uuids which corrupt the message chain
      const entries = allEntries.filter(e => e.type === 'user' || e.type === 'assistant');

      // Build conversation chain from entries
      const chain = this.buildConversationChain(sessionId, entries.map(e => ({ ...e, sourceProject: projectPath })),
        summaryMap);

      if (!chain) {
        this.logger.debug('fetchConversationDirect: chain build returned null — see buildConversationChain logs above', { sessionId });
        throw new LatticeError('CONVERSATION_NOT_FOUND', `Failed to build conversation ${sessionId}`, 404);
      }

      const elapsed = Date.now() - startTime;
      this.logger.debug('Direct conversation fetch completed', {
        sessionId,
        elapsedMs: elapsed,
        messageCount: chain.messages.length,
        cacheStatus: 'miss',
      });

      const result = {
        messages: chain.messages, // Already filtered in buildConversationChain
        metadata: {
          summary: chain.summary,
          projectPath: chain.projectPath,
          model: chain.model,
          totalDuration: chain.totalDuration
        }
      };

      // Store in short-lived cache — evict stale entries opportunistically
      this.fetchDirectCache.set(sessionId, { result, mtimeMs: fileMtimeMs, cachedAt: Date.now() });
      if (this.fetchDirectCache.size > 50) {
        const cutoff = Date.now() - this.FETCH_DIRECT_CACHE_TTL_MS * 2;
        for (const [key, entry] of this.fetchDirectCache) {
          if (entry.cachedAt < cutoff) this.fetchDirectCache.delete(key);
        }
      }

      return result;
    } catch (error) {
      if (error instanceof LatticeError) throw error;
      throw new LatticeError('CONVERSATION_READ_FAILED', `Failed to read conversation: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  }

  /**
   * Get summary for a session from summaries.json
   */
  private async getSummaryForSession(sessionId: string): Promise<string | null> {
    try {
      const summariesPath = path.join(this.claudeHomePath, 'summaries.json');
      const content = await fs.readFile(summariesPath, 'utf-8');
      const summaries = parseJson(content) as Record<string, string | undefined>;
      return summaries[sessionId] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Decode project folder name to actual path
   */
  private decodeProjectName(projectName: string): string {
    // Project folders use dashes instead of slashes
    // e.g., "-home-alex-lattice" -> "/home/alex/lattice"
    return projectName.replace(/^-/, '/').replace(/-/g, '/');
  }

  /**
   * Get the working directory for a specific conversation session
   * Reads the cwd from the session's JSONL file to get the accurate path
   * (folder name decoding is lossy for paths containing hyphens)
   */
  async getConversationWorkingDirectory(sessionId: string): Promise<string | null> {
    const startTime = Date.now();
    try {
      const filePath = await this.findSessionFile(sessionId);

      if (!filePath) {
        this.logger.warn('Session file not found', { sessionId });
        return null;
      }

      // Read the first entry from the JSONL file to get the actual cwd
      // This is more reliable than decoding the folder name, which is lossy
      // (e.g., "my-org" folder becomes "my/org" when decoded)
      const entries = await this.parseJsonlFile(filePath);

      // Find the first entry with a cwd field
      const entryWithCwd = entries.find(e => e.cwd);

      if (entryWithCwd?.cwd) {
        this.logger.debug('Found working directory from JSONL cwd field', {
          sessionId,
          workingDirectory: entryWithCwd.cwd,
          elapsedMs: Date.now() - startTime
        });
        return entryWithCwd.cwd;
      }

      // Fallback to folder name decoding if no cwd field found
      // (older sessions may not have cwd in the JSONL)
      const projectsPath = path.join(this.claudeHomePath, 'projects');
      const relativePath = filePath.replace(projectsPath + path.sep, '');
      const projectName = relativePath.split(path.sep)[0];
      const projectPath = this.decodeProjectName(projectName);

      this.logger.debug('Found working directory from folder name (fallback)', {
        sessionId,
        workingDirectory: projectPath,
        elapsedMs: Date.now() - startTime
      });

      return projectPath;
    } catch (error) {
      this.logger.error('Error getting working directory for conversation', error, { sessionId });
      return null;
    }
  }

  /**
   * Get file modification times for JSONL files
   * @param allowedSessionIds Optional filter - if provided, only stat files for these sessions
   */
  private async getFileModificationTimes(allowedSessionIds?: Set<string> | null): Promise<Map<string, number>> {
    const modTimes = new Map<string, number>();
    const projectsPath = path.join(this.claudeHomePath, 'projects');

    this.logger.debug('Getting file modification times', {
      projectsPath,
      filtered: !!allowedSessionIds,
      allowedCount: allowedSessionIds?.size
    });

    try {
      const projects = await this.readDirectory(projectsPath);
      this.logger.debug('Found projects', { projectCount: projects.length });

      for (const project of projects) {
        const projectPath = path.join(projectsPath, project);
        const stats = await fs.stat(projectPath);

        if (!stats.isDirectory()) continue;

        const files = await this.readDirectory(projectPath);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

        for (const file of jsonlFiles) {
          // Skip files not in allowed list (optimization: avoid stat calls)
          if (allowedSessionIds) {
            const sessionId = file.replace('.jsonl', '');
            if (!allowedSessionIds.has(sessionId)) continue;
          }

          const filePath = path.join(projectPath, file);
          try {
            const fileStats = await fs.stat(filePath);
            modTimes.set(filePath, fileStats.mtimeMs);
          } catch (error) {
            this.logger.warn('Failed to stat file', { filePath, error });
          }
        }
      }
      
      this.logger.debug('File modification times collection complete', {
        totalFiles: modTimes.size,
        projects: projects.length
      });
    } catch (error) {
      this.logger.error('Error getting file modification times', error);
    }
    
    return modTimes;
  }


  /**
   * Extract source project name from file path
   */
  private extractSourceProject(filePath: string): string {
    const projectsPath = path.join(this.claudeHomePath, 'projects');
    const relativePath = path.relative(projectsPath, filePath);
    const segments = relativePath.split(path.sep);
    return segments[0]; // First segment is the project directory name
  }

  /**
   * Process all entries into conversation chains (the cheap in-memory operations)
   */
  private processAllEntries(allEntries: (RawJsonEntry & { sourceProject: string })[]): ConversationChain[] {
    const startTime = Date.now();
    
    this.logger.debug('Processing all entries into conversations', {
      totalEntries: allEntries.length
    });
    
    // Group entries by sessionId
    const sessionGroups = this.groupEntriesBySession(allEntries);
    this.logger.debug('Entries grouped by session', {
      sessionCount: sessionGroups.size,
      totalEntries: allEntries.length
    });
    
    // Process summaries
    const summaries = this.processSummaries(allEntries);
    this.logger.debug('Summaries processed', {
      summaryCount: summaries.size
    });
    
    // Build conversation chains
    const conversationChains: ConversationChain[] = [];
    let discardedCount = 0;

    for (const [sessionId, entries] of sessionGroups) {
      const chain = this.buildConversationChain(sessionId, entries, summaries);
      if (chain) {
        conversationChains.push(chain);
      } else {
        discardedCount++;
      }
    }

    if (discardedCount > 0) {
      this.logger.warn('[HISTORY-DISCARD] Sessions discarded during chain building', {
        discardedCount,
        totalSessions: sessionGroups.size,
        keptCount: conversationChains.length,
      });
    }

    const totalElapsed = Date.now() - startTime;
    this.logger.debug('Entry processing complete', {
      conversationCount: conversationChains.length,
      discardedCount,
      totalElapsedMs: totalElapsed,
      avgTimePerConversation: conversationChains.length > 0 ? totalElapsed / conversationChains.length : 0
    });
    
    return conversationChains;
  }

  /**
   * Parse all conversations from all JSONL files with file-level caching and concurrency protection
   * @param allowedSessionIds Optional set of session IDs to parse. If provided, only these sessions will be parsed.
   */
  private async parseAllConversations(allowedSessionIds?: Set<string> | null): Promise<ConversationChain[]> {
    const startTime = Date.now();
    const timings: Record<string, number> = {};

    this.logger.debug('Starting parseAllConversations with file-level caching', {
      filtered: allowedSessionIds !== null && allowedSessionIds !== undefined,
      allowedCount: allowedSessionIds?.size
    });

    // Get current file modification times (filtered if allowedSessionIds provided)
    const modTimeStart = Date.now();
    const filteredModTimes = await this.getFileModificationTimes(allowedSessionIds);
    timings.getFileModificationTimes = Date.now() - modTimeStart;

    // Use the new file-level cache interface
    const cacheStart = Date.now();
    const conversations = await this.conversationCache.getOrParseConversations(
      filteredModTimes,
      (filePath: string) => this.parseJsonlFile(filePath), // Parse single file
      (filePath: string) => this.extractSourceProject(filePath), // Get source project
      (allEntries: (RawJsonEntry & { sourceProject: string })[]) => this.processAllEntries(allEntries) // Process entries
    );
    timings.getOrParseConversations = Date.now() - cacheStart;

    timings.total = Date.now() - startTime;
    this.logger.debug('parseAllConversations breakdown', {
      timingsMs: timings,
      filteredModTimesCount: filteredModTimes.size,
      conversationCount: conversations.length,
    });

    return conversations;
  }
  
  /**
   * Parse a single JSONL file and return all valid entries
   */
  private async parseJsonlFile(filePath: string): Promise<RawJsonEntry[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      const entries: RawJsonEntry[] = [];
      
      for (const line of lines) {
        try {
          const entry = parseJson(line) as RawJsonEntry;
          entries.push(entry);
        } catch (parseError) {
          this.logger.warn('Failed to parse line from JSONL file', { 
            error: parseError,
            filePath, 
            line: line.substring(0, 100) 
          });
        }
      }
      
      return entries;
    } catch (error) {
      this.logger.error('Failed to read JSONL file', error, { filePath });
      return [];
    }
  }
  
  /**
   * Group entries by sessionId
   */
  private groupEntriesBySession(entries: (RawJsonEntry & { sourceProject: string })[]): Map<string, (RawJsonEntry & { sourceProject: string })[]> {
    const sessionGroups = new Map<string, (RawJsonEntry & { sourceProject: string })[]>();
    
    for (const entry of entries) {
      // Only group user and assistant messages
      if ((entry.type === 'user' || entry.type === 'assistant') && entry.sessionId) {
        if (!sessionGroups.has(entry.sessionId)) {
          sessionGroups.set(entry.sessionId, []);
        }
        sessionGroups.get(entry.sessionId)!.push(entry);
      }
    }
    
    return sessionGroups;
  }
  
  /**
   * Process summary entries and create leafUuid mapping
   */
  private processSummaries(entries: RawJsonEntry[]): Map<string, string> {
    const summaries = new Map<string, string>();
    
    for (const entry of entries) {
      if (entry.type === 'summary' && entry.leafUuid && entry.summary) {
        summaries.set(entry.leafUuid, entry.summary);
      }
    }
    
    return summaries;
  }
  
  private async readDirectory(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Build a conversation chain from session entries
   */
  private buildConversationChain(
    sessionId: string,
    entries: (RawJsonEntry & { sourceProject: string })[],
    summaries: Map<string, string>
  ): ConversationChain | null {
    try {
      // Convert entries to ConversationMessage format
      const messages: ConversationMessage[] = entries.map(entry => this.parseMessage(entry));

      // Build message chain using parentUuid/uuid relationships
      const orderedMessages = this.buildMessageChain(messages);

      if (orderedMessages.length === 0) {
        return null;
      }

      // Apply message filter
      const filteredMessages = this.messageFilter.filterMessages(orderedMessages, `buildChain:${sessionId}`);

      // Check if we have any messages left after filtering
      if (filteredMessages.length === 0) {
        return null;
      }

      // Filter out warmup/sidechain-only sessions
      // These are subagent sessions that exist only to prime the context cache
      const firstUserMessage = filteredMessages.find(msg => msg.type === 'user');
      let isWarmupSession = false;

      if (firstUserMessage?.message) {
        const msgContent = 'content' in firstUserMessage.message
          ? firstUserMessage.message.content
          : null;

        if (msgContent) {
          isWarmupSession = typeof msgContent === 'string'
            ? msgContent.trim() === 'Warmup'
            : Array.isArray(msgContent) &&
              msgContent.length === 1 &&
              msgContent[0].type === 'text' &&
              'text' in msgContent[0] &&
              msgContent[0].text?.trim() === 'Warmup';
        }
      }

      // Skip sessions that are pure warmup sessions (sidechain with just "Warmup" prompt)
      // Use filteredMessages[0] for sidechain check to be consistent with warmup detection
      if (isWarmupSession && filteredMessages[0]?.isSidechain) {
        return null;
      }

      // Determine project path - use original first message for cwd before filtering
      const firstMessage = orderedMessages[0];
      let projectPath = '';
      
      if (firstMessage.cwd) {
        projectPath = firstMessage.cwd;
      } else {
        // Fallback to decoding directory name from source project
        const sourceProject = entries[0].sourceProject;
        projectPath = this.decodeProjectPath(sourceProject);
      }
      
      // Determine conversation summary
      const summary = this.determineConversationSummary(filteredMessages, summaries);
      
      // Calculate metadata from filtered messages
      const totalDuration = filteredMessages.reduce((sum, msg) => sum + (msg.durationMs || 0), 0);
      const model = this.extractModel(filteredMessages);
      
      // Get timestamps from filtered messages
      const timestamps = filteredMessages
        .map(msg => msg.timestamp)
        .filter(ts => ts)
        .sort();
      
      const createdAt = timestamps[0] || new Date().toISOString();
      const updatedAt = timestamps[timestamps.length - 1] || createdAt;
      
      return {
        sessionId,
        messages: filteredMessages,
        projectPath,
        summary,
        createdAt,
        updatedAt,
        totalDuration,
        model
      };
    } catch (error) {
      this.logger.error('Error building conversation chain', error, { sessionId: sessionId.slice(0, 8) });
      return null;
    }
  }
  
  /**
   * Build ordered message chain using parentUuid relationships.
   * Uses a pre-built children index for O(n) traversal instead of
   * scanning all messages per node (which was O(n²)).
   */
  private buildMessageChain(messages: ConversationMessage[]): ConversationMessage[] {
    const startMs = Date.now();

    // O(n): build uuid→message and parentUuid→children[] indexes
    const messageMap = new Map<string, ConversationMessage>();
    const childrenMap = new Map<string, ConversationMessage[]>();
    for (const msg of messages) {
      messageMap.set(msg.uuid, msg);
      if (msg.parentUuid) {
        let siblings = childrenMap.get(msg.parentUuid);
        if (!siblings) {
          siblings = [];
          childrenMap.set(msg.parentUuid, siblings);
        }
        siblings.push(msg);
      }
    }

    // Find head message (parentUuid is null OR parent was filtered out)
    // Prefer non-sidechain roots - sidechain entries (subagent tasks) have their own
    // separate chains but share the same sessionId
    const rootMessages = messages.filter(msg =>
      !msg.parentUuid || !messageMap.has(msg.parentUuid)
    );
    const mainRoot = rootMessages.find(msg => !msg.isSidechain);
    const headMessage = mainRoot || rootMessages[0];

    if (!headMessage) {
      // If no head found, return messages sorted by timestamp
      return messages.sort((a, b) =>
        new Date(a.timestamp || '').getTime() - new Date(b.timestamp || '').getTime()
      );
    }

    // Build chain from head using O(1) children lookups
    const orderedMessages: ConversationMessage[] = [];
    const visited = new Set<string>();

    const traverse = (currentMessage: ConversationMessage) => {
      if (visited.has(currentMessage.uuid)) {
        return; // Avoid cycles
      }

      visited.add(currentMessage.uuid);
      orderedMessages.push(currentMessage);

      // O(1) lookup instead of O(n) filter
      const children = childrenMap.get(currentMessage.uuid) || [];

      // Sort children by timestamp to maintain order
      children.sort((a, b) =>
        new Date(a.timestamp || '').getTime() - new Date(b.timestamp || '').getTime()
      );

      children.forEach(child => traverse(child));
    };

    traverse(headMessage);

    // Add any orphaned messages at the end
    const orphanedMessages = messages.filter(msg => !visited.has(msg.uuid));
    orderedMessages.push(...orphanedMessages.sort((a, b) =>
      new Date(a.timestamp || '').getTime() - new Date(b.timestamp || '').getTime()
    ));

    const elapsedMs = Date.now() - startMs;
    this.logger.debug('buildMessageChain completed', {
      messageCount: messages.length,
      orderedCount: orderedMessages.length,
      orphanCount: orphanedMessages.length,
      elapsedMs,
    });

    return orderedMessages;
  }
  
  /**
   * Determine conversation summary from messages and summary map
   */
  private determineConversationSummary(
    messages: ConversationMessage[], 
    summaries: Map<string, string>
  ): string {
    // Walk through messages from latest to earliest to find last available summary
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (summaries.has(message.uuid)) {
        return summaries.get(message.uuid)!;
      }
    }
    
    // Fallback to first user message content
    const firstUserMessage = messages.find(msg => msg.type === 'user');
    if (firstUserMessage && firstUserMessage.message) {
      const content = this.extractMessageContent(firstUserMessage.message);
      return content.length > 100 ? content.substring(0, 100) + '...' : content;
    }
    
    return 'No summary available';
  }
  
  /**
   * Extract text content from message object
   */
  private extractMessageContent(message: Anthropic.Message | Anthropic.MessageParam | string): string {
    if (typeof message === 'string') {
      return message;
    }
    
    if (message.content) {
      if (typeof message.content === 'string') {
        return message.content;
      }
      
      if (Array.isArray(message.content)) {
        // Find first text content block
        const textBlock = message.content.find((block) => block.type === 'text');
        return textBlock && 'text' in textBlock ? textBlock.text : '';
      }
    }
    
    return 'No content available';
  }
  
  /**
   * Extract model information from messages
   */
  private extractModel(messages: ConversationMessage[]): string {
    for (const message of messages) {
      if (message.message && typeof message.message === 'object') {
        const messageObj = message.message as { model?: string };
        if (messageObj.model) {
          return messageObj.model;
        }
      }
    }
    return 'Unknown';
  }


  private parseMessage(entry: RawJsonEntry): ConversationMessage {
    return {
      uuid: entry.uuid || '',
      type: entry.type as 'user' | 'assistant' | 'system',
      message: entry.message!,  // Non-null assertion since ConversationMessage requires it
      timestamp: entry.timestamp || '',
      sessionId: entry.sessionId || '',
      provider: 'claude',
      parentUuid: entry.parentUuid,
      isSidechain: entry.isSidechain,
      userType: entry.userType,
      cwd: entry.cwd,
      version: entry.version,
      durationMs: entry.durationMs
    };
  }

  private applyFilters(conversations: ConversationSummary[], filter?: ConversationListQuery): ConversationSummary[] {
    if (!filter) return conversations;
    
    let filtered = [...conversations];
    
    // Filter by project path
    if (filter.projectPath) {
      filtered = filtered.filter(c => c.projectPath === filter.projectPath);
    }
    
    // Filter by continuation session
    if (filter.hasContinuation !== undefined) {
      filtered = filtered.filter(c => {
        const hasContinuation = c.sessionInfo.continuation_session_id !== '';
        return filter.hasContinuation ? hasContinuation : !hasContinuation;
      });
    }
    
    // Filter by archived status
    if (filter.archived !== undefined) {
      filtered = filtered.filter(c => c.sessionInfo.archived === filter.archived);
    }
    
    // Filter by pinned status
    if (filter.pinned !== undefined) {
      filtered = filtered.filter(c => c.sessionInfo.pinned === filter.pinned);
    }
    
    // Sort
    if (filter.sortBy) {
      filtered.sort((a, b) => {
        const field = filter.sortBy === 'created' ? 'createdAt' : 'updatedAt';
        const aVal = new Date(a[field]).getTime();
        const bVal = new Date(b[field]).getTime();
        return filter.order === 'desc' ? bVal - aVal : aVal - bVal;
      });
    }
    
    return filtered;
  }

  private applyPagination(conversations: ConversationSummary[], filter?: ConversationListQuery): ConversationSummary[] {
    if (!filter) return conversations;
    
    const limit = filter.limit || 20;
    const offset = filter.offset || 0;
    
    return conversations.slice(offset, offset + limit);
  }

  private decodeProjectPath(encoded: string): string {
    // Claude encodes directory paths by replacing '/' with '-'
    return encoded.replace(/-/g, '/');
  }

  /**
   * Read Claude Code's native task state for a session.
   *
   * Tasks are stored in ~/.claude/tasks/{sessionId}/*.json
   * Each task is a separate JSON file with id, subject, status, etc.
   *
   * Returns null if no tasks exist for this session.
   */
  async readTaskStateForSession(sessionId: string): Promise<{
    currentTask: string | null;
    pendingCount: number;
    completedCount: number;
    totalCount: number;
    tasks: Array<{ id: string; subject: string; status: string }>;
  } | null> {
    try {
      const tasksDir = path.join(os.homedir(), '.claude', 'tasks', sessionId);

      // Check if directory exists
      try {
        await fs.access(tasksDir);
      } catch {
        // No tasks directory for this session
        return null;
      }

      // Read all JSON files in the directory
      const files = await fs.readdir(tasksDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      if (jsonFiles.length === 0) {
        return null;
      }

      const tasks: Array<{ id: string; subject: string; status: string }> = [];

      interface TaskFile {
        id?: string;
        subject?: string;
        status?: string;
      }

      for (const file of jsonFiles) {
        try {
          const content = await fs.readFile(path.join(tasksDir, file), 'utf-8');
          const task = parseJson(content) as TaskFile;

          if (task.id && task.subject) {
            tasks.push({
              id: task.id,
              subject: task.subject,
              status: task.status ?? 'pending',
            });
          }
        } catch (error) {
          this.logger.debug('Failed to parse task file', { file, error });
          // Continue with other files
        }
      }

      if (tasks.length === 0) {
        return null;
      }

      // Find current task and counts
      const inProgress = tasks.find(t => t.status === 'in_progress');
      const pendingCount = tasks.filter(t => t.status === 'pending').length;
      const completedCount = tasks.filter(t => t.status === 'completed' || t.status === 'done').length;

      return {
        currentTask: inProgress?.subject || null,
        pendingCount,
        completedCount,
        totalCount: tasks.length,
        tasks,
      };
    } catch (error) {
      this.logger.debug('Failed to read task state', { sessionId, error });
      return null;
    }
  }

}
