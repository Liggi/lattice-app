import type { Provider } from '@/types/unified-messages.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { CONFIG_DIR, CONFIG_DIR_NAME } from '@/utils/constants.js';
import { randomUUID } from 'crypto';
import type { SessionInfo } from '@/types/index.js';

import { createLogger } from '../infrastructure/logger.js';
import { type Logger } from '../infrastructure/logger.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { runSessionInfoSchemaBootstrap } from './session-info-migrations.js';
import { resolveCanonicalId } from './resolve-canonical-id.js';

type SessionRow = {
  custom_name: string;
  created_at: string;
  updated_at: string;
  version: number;
  pinned: number | boolean;
  archived: number | boolean;
  continuation_session_id: string;
  initial_commit_head: string;
  permission_mode: string;
  identity_image: string | null;
  pin_character_name: string | null;
  pin_character_image: string | null;
  last_termination_reason: string | null;
  branched_from_session_id: string | null;
  branched_at_turn: number | null;
  workspace: string;
  team_name: string | null;
  team_role: string | null;
  paused_reason: string | null;
  conversation_id: string | null;
  imported_at: string | null;
  last_turn_usage_json: string | null;
  project_name: string | null;
};

/** @deprecated Use InsightsRecord from InsightsEngine directly */
import type { InsightsRecord } from '../insights/insights-engine.js';
import { parseJson } from '../../utils/json.js';
export type { InsightsRecord as CachedInsights } from '../insights/insights-engine.js';

type SessionEventRow = {
  id: string;
  session_id: string;
  trace_id: string | null;
  event_type: string;
  provider: string | null;
  streaming_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  timestamp: string;
  source: string;
  metadata_json: string | null;
};

type SessionEventRecord = {
  id: string;
  sessionId: string;
  traceId: string | null;
  eventType: string;
  provider: string | null;
  streamingId: string | null;
  threadId: string | null;
  messageId: string | null;
  timestamp: string;
  source: string;
  metadata: Record<string, unknown> | null;
};

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseMcpServersJson(value: string): Array<{ name: string; status: string }> | null {
  let parsed: unknown;
  try {
    parsed = parseJson(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const servers: Array<{ name: string; status: string }> = [];
  for (const item of parsed) {
    if (!isJsonRecord(item)) continue;
    const name = item.name;
    const status = item.status;
    if (typeof name !== 'string' || typeof status !== 'string') continue;
    servers.push({ name, status });
  }
  return servers;
}

/**
 * SessionInfoService manages session information using SQLite backend
 * Stores session metadata including custom names in ~/.lattice/session-info.db
 * Provides fast lookups and updates for session-specific data
 *
 * REMAINING SECTIONS:
 * 1. Core Session CRUD - getSessionInfo, updateSessionInfo, deleteSession
 * 2. Recommendation Management - getPendingRecommendations, acceptRecommendation
 * 3. Session metadata (MCP servers, identity images, proposed next steps)
 * 4. Branch Operations - copyTurnsForBranch
 * 5. File Changes - insertFileChange, getFileChanges
 */
export class SessionInfoService {
  private static instance: SessionInfoService;
  private logger: Logger;
  private dbPath!: string;
  private configDir!: string;
  private isInitialized = false;
  private db!: Database.Database;

  private getSessionStmt!: Database.Statement;
  private insertSessionStmt!: Database.Statement;
  private updateSessionStmt!: Database.Statement;
  private deleteSessionStmt!: Database.Statement;
  private getAllStmt!: Database.Statement;
  private countStmt!: Database.Statement;
  private archiveAllStmt!: Database.Statement;
  private setMetadataStmt!: Database.Statement;
  private getMetadataStmt!: Database.Statement;

  // File changes statements
  private insertFileChangeStmt!: Database.Statement;
  private getFileChangesStmt!: Database.Statement;

  // Batch lookup statements, keyed by placeholder count + projection.
  private batchLookupStmts: Map<string, Database.Statement> = new Map();
  private columnsWithoutIdentityImage: string[] | null = null;
  private static readonly BATCH_LOOKUP_CHUNK = 500;
  private static readonly BATCH_STMT_CACHE_LIMIT = 64;

  constructor(customConfigDir?: string) {
    this.logger = createLogger('SessionInfoService');
    this.initializePaths(customConfigDir);
  }

  static getInstance(): SessionInfoService {
    if (!SessionInfoService.instance) {
      SessionInfoService.instance = new SessionInfoService();
    }
    return SessionInfoService.instance;
  }

  static resetInstance(): void {
    if (SessionInfoService.instance) {
      SessionInfoService.instance.isInitialized = false;
    }
    SessionInfoService.instance = null as unknown as SessionInfoService;
  }

  private initializePaths(customConfigDir?: string): void {
    if (customConfigDir) {
      if (customConfigDir === ':memory:') {
        this.configDir = ':memory:';
        this.dbPath = ':memory:';
        return;
      }
      this.configDir = path.join(customConfigDir, CONFIG_DIR_NAME);
    } else {
      this.configDir = CONFIG_DIR;
    }
    this.dbPath = path.join(this.configDir, 'session-info.db');

    this.logger.debug('Initializing paths', {
      configDir: this.configDir,
      dbPath: this.dbPath
    });
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.ensureConfigDirectoryExists();
      this.openDatabaseConnection();
      runSessionInfoSchemaBootstrap(this.db, this.logger);
      this.prepareStatements();
      this.ensureMetadata();
      await this.initializeConversationService();
      this.isInitialized = true;
    } catch (error) {
      this.logger.error('Failed to initialize session info database', error);
      throw new Error(`Session info database initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private ensureConfigDirectoryExists(): void {
    if (this.dbPath !== ':memory:' && !fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
      this.logger.debug('Created config directory', { dir: this.configDir });
    }
  }

  private openDatabaseConnection(): void {
    const provider = DatabaseProvider.getInstance(this.dbPath === ':memory:' ? ':memory:' : this.configDir);
    this.db = provider.getDb();
    this.dbPath = provider.getDbPath();
  }

  private async initializeConversationService(): Promise<void> {
    // ConversationService shares this DB handle.
    const { ConversationService } = await import('./conversation-service.js');
    ConversationService.getInstance().initialize(this.db);
  }

  private prepareStatements(): void {
    this.prepareSessionStatements();
    this.prepareFileChangeStatements();
  }

  private prepareSessionStatements(): void {
    // Statements are bound to a db handle; drop anything cached for a previous one.
    this.batchLookupStmts.clear();
    this.columnsWithoutIdentityImage = null;

    this.getSessionStmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    this.insertSessionStmt = this.db.prepare(`
      INSERT INTO sessions (
        session_id,
        custom_name,
        created_at,
        updated_at,
        version,
        pinned,
        archived,
        continuation_session_id,
        initial_commit_head,
        permission_mode,
        branched_from_session_id,
        branched_at_turn,
        workspace,
        team_name,
        team_role,
        paused_reason,
        conversation_id,
        imported_at,
        created_hidden,
        project_name
      ) VALUES (
        @session_id,
        @custom_name,
        @created_at,
        @updated_at,
        @version,
        @pinned,
        @archived,
        @continuation_session_id,
        @initial_commit_head,
        @permission_mode,
        @branched_from_session_id,
        @branched_at_turn,
        @workspace,
        @team_name,
        @team_role,
        @paused_reason,
        @conversation_id,
        @imported_at,
        @archived,
        @project_name
      )
    `);
    this.updateSessionStmt = this.db.prepare(`
      UPDATE sessions SET
        custom_name=@custom_name,
        updated_at=@updated_at,
        pinned=@pinned,
        archived=@archived,
        continuation_session_id=@continuation_session_id,
        initial_commit_head=@initial_commit_head,
        permission_mode=@permission_mode,
        version=@version,
        branched_from_session_id=@branched_from_session_id,
        branched_at_turn=@branched_at_turn,
        workspace=@workspace,
        team_name=@team_name,
        team_role=@team_role,
        paused_reason=@paused_reason,
        conversation_id=@conversation_id,
        imported_at=@imported_at,
        project_name=@project_name
      WHERE session_id=@session_id
    `);
    this.deleteSessionStmt = this.db.prepare('DELETE FROM sessions WHERE session_id = ?');
    this.getAllStmt = this.db.prepare('SELECT * FROM sessions');
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM sessions');
    this.archiveAllStmt = this.db.prepare('UPDATE sessions SET archived=1, updated_at=@updated_at WHERE archived=0');
    this.setMetadataStmt = this.db.prepare('INSERT INTO metadata (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    this.getMetadataStmt = this.db.prepare('SELECT value FROM metadata WHERE key = ?');
  }



  private prepareFileChangeStatements(): void {
    this.insertFileChangeStmt = this.db.prepare(`
      INSERT INTO turn_file_changes (id, session_id, turn_number, tool_name, file_path, old_string, new_string, timestamp)
      VALUES (@id, @session_id, @turn_number, @tool_name, @file_path, @old_string, @new_string, @timestamp)
    `);
    this.getFileChangesStmt = this.db.prepare(`
      SELECT * FROM turn_file_changes WHERE session_id = ? ORDER BY turn_number, id
    `);
  }

  private ensureMetadata(): void {
    const now = new Date().toISOString();
    const schema = this.getMetadataStmt.get('schema_version') as { value?: string } | undefined;
    if (!schema) {
      this.setMetadataStmt.run({ key: 'schema_version', value: '3' });
      this.setMetadataStmt.run({ key: 'created_at', value: now });
      this.setMetadataStmt.run({ key: 'last_updated', value: now });
    }
  }

  private mapRow(row: SessionRow): SessionInfo {
    return {
      custom_name: row.custom_name,
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: row.version,
      pinned: !!row.pinned,
      archived: !!row.archived,
      continuation_session_id: row.continuation_session_id,
      initial_commit_head: row.initial_commit_head,
      permission_mode: row.permission_mode,
      identity_image: row.identity_image ?? undefined,
      pin_character_name: row.pin_character_name ?? undefined,
      pin_character_image: row.pin_character_image ?? undefined,
      last_termination_reason: (row.last_termination_reason as SessionInfo['last_termination_reason']) ?? undefined,
      branched_from_session_id: row.branched_from_session_id ?? undefined,
      branched_at_turn: row.branched_at_turn ?? undefined,
      workspace: row.workspace ?? 'main',
      team_name: row.team_name ?? undefined,
      team_role: row.team_role ?? undefined,
      paused_reason: row.paused_reason ?? undefined,
      conversation_id: row.conversation_id ?? undefined,
      imported_at: row.imported_at ?? undefined,
      last_turn_usage: row.last_turn_usage_json ? parseJson(row.last_turn_usage_json) as SessionInfo['last_turn_usage'] : undefined,
      project_name: row.project_name ?? undefined,
    };
  }

  private createDefaultSession(now: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
      custom_name: '',
      created_at: now,
      updated_at: now,
      version: 3,
      pinned: false,
      archived: false,
      continuation_session_id: '',
      initial_commit_head: '',
      permission_mode: 'default',
      workspace: 'main',
      ...overrides
    };
  }

  private buildInsertSessionParams(sessionId: string, session: SessionInfo): Record<string, unknown> {
    return {
      session_id: sessionId,
      custom_name: session.custom_name,
      created_at: session.created_at,
      updated_at: session.updated_at,
      version: session.version,
      pinned: session.pinned ? 1 : 0,
      archived: session.archived ? 1 : 0,
      continuation_session_id: session.continuation_session_id,
      initial_commit_head: session.initial_commit_head,
      permission_mode: session.permission_mode,
      branched_from_session_id: session.branched_from_session_id || null,
      branched_at_turn: session.branched_at_turn || null,
      workspace: session.workspace,
      imported_at: session.imported_at || null,
      team_name: session.team_name || null,
      team_role: session.team_role || null,
      paused_reason: session.paused_reason || null,
      conversation_id: session.conversation_id || null,
      project_name: session.project_name || null
    };
  }

  private buildUpdateSessionParams(sessionId: string, session: SessionInfo): Record<string, unknown> {
    return {
      session_id: sessionId,
      custom_name: session.custom_name,
      updated_at: session.updated_at,
      pinned: session.pinned ? 1 : 0,
      archived: session.archived ? 1 : 0,
      continuation_session_id: session.continuation_session_id,
      initial_commit_head: session.initial_commit_head,
      permission_mode: session.permission_mode,
      version: session.version,
      branched_from_session_id: session.branched_from_session_id || null,
      branched_at_turn: session.branched_at_turn || null,
      workspace: session.workspace,
      team_name: session.team_name || null,
      team_role: session.team_role || null,
      paused_reason: session.paused_reason || null,
      conversation_id: session.conversation_id || null,
      imported_at: session.imported_at || null,
      project_name: session.project_name || null
    };
  }

  // ===========================================================================
  // SECTION 1: Core Session CRUD
  // ===========================================================================

  async getSessionInfo(sessionId: string): Promise<SessionInfo> {
    try {
      const row = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
      if (row) {
        return this.mapRow(row);
      }

      // Auto-create with archived=true so read-path side effects don't
      // surface old/unknown sessions in the sidebar.  Explicit creation
      // paths (session-lifecycle, updateSessionInfo) set archived=false.
      const now = new Date().toISOString();
      const defaultSession = this.createDefaultSession(now, { archived: true });
      this.insertSessionStmt.run(this.buildInsertSessionParams(sessionId, defaultSession));
      this.setMetadataStmt.run({ key: 'last_updated', value: now });
      return defaultSession;
    } catch (error) {
      this.logger.error('Failed to get session info', { sessionId, error });
      return this.createDefaultSession(new Date().toISOString());
    }
  }

  /**
   * Synchronous version of getSessionInfo that returns null if not found.
   * Does NOT create a default session entry - purely reads from DB.
   * Use this when you need to check archived status without side effects.
   */
  getSessionInfoSync(sessionId: string): SessionInfo | null {
    try {
      const row = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
      if (row) {
        return this.mapRow(row);
      }
      return null;
    } catch (error) {
      this.logger.error('Failed to get session info (sync)', { sessionId, error });
      return null;
    }
  }

  /**
   * Batch form of getSessionInfoSync: one `WHERE session_id IN (...)` instead
   * of one point query per ID.
   *
   * The conversation list route called getSessionInfoSync twice per row, so a
   * 50-conversation page ran 100 synchronous queries and materialized every
   * row's base64 identity_image before the route decided whether the client
   * had even asked for images. `includeIdentityImage: false` drops that column
   * from the projection so the blob never leaves SQLite.
   *
   * Missing IDs are simply absent from the returned map (same "no side
   * effects" contract as getSessionInfoSync).
   */
  getSessionInfoBatch(
    sessionIds: string[],
    options: { includeIdentityImage?: boolean } = {},
  ): Map<string, SessionInfo> {
    const result = new Map<string, SessionInfo>();
    const uniqueIds = [...new Set(sessionIds.filter(id => typeof id === 'string' && id.length > 0))];
    if (uniqueIds.length === 0) return result;

    const includeIdentityImage = options.includeIdentityImage !== false;

    try {
      for (let i = 0; i < uniqueIds.length; i += SessionInfoService.BATCH_LOOKUP_CHUNK) {
        const chunk = uniqueIds.slice(i, i + SessionInfoService.BATCH_LOOKUP_CHUNK);
        const stmt = this.getBatchLookupStatement(chunk.length, includeIdentityImage);
        const rows = stmt.all(...chunk) as Array<SessionRow & { session_id: string }>;
        for (const row of rows) {
          result.set(row.session_id, this.mapRow(row));
        }
      }
    } catch (error) {
      this.logger.error('Failed to get session info (batch)', { count: uniqueIds.length, error });
      return new Map();
    }

    return result;
  }

  /**
   * Prepared statements are cached per (placeholder count, projection). The
   * placeholder count is driven by page size, so the cache stays tiny in
   * practice; the cap is a guard against an unbounded caller.
   */
  private getBatchLookupStatement(count: number, includeIdentityImage: boolean): Database.Statement {
    const key = `${includeIdentityImage ? 'full' : 'noimg'}:${count}`;
    const cached = this.batchLookupStmts.get(key);
    if (cached) return cached;

    if (this.batchLookupStmts.size >= SessionInfoService.BATCH_STMT_CACHE_LIMIT) {
      this.batchLookupStmts.clear();
    }

    const placeholders = new Array(count).fill('?').join(', ');
    const projection = includeIdentityImage ? '*' : this.getColumnsExcludingIdentityImage().join(', ');
    const stmt = this.db.prepare(
      `SELECT ${projection} FROM sessions WHERE session_id IN (${placeholders})`
    );
    this.batchLookupStmts.set(key, stmt);
    return stmt;
  }

  /**
   * Read the real column list from the table rather than hard-coding one, so
   * a future migration can't silently drop a field from the batch projection.
   */
  private getColumnsExcludingIdentityImage(): string[] {
    if (this.columnsWithoutIdentityImage) return this.columnsWithoutIdentityImage;

    const columns = (this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map(column => column.name)
      .filter(name => name !== 'identity_image');

    if (columns.length === 0) {
      throw new Error('sessions table reported no columns');
    }

    this.columnsWithoutIdentityImage = columns;
    return columns;
  }

  /**
   * Build a merged SessionInfo from a conversation ID and an optional segment session ID.
   * Conversation-level values override segment-level values (conv-* is canonical).
   * Returns null if neither ID has session info.
   */
  getMergedSessionInfo(conversationId: string, segmentSessionId?: string): SessionInfo | null {
    const convInfo = this.getSessionInfoSync(conversationId);
    const segmentInfo = segmentSessionId ? this.getSessionInfoSync(segmentSessionId) : null;

    if (!convInfo && !segmentInfo) return null;

    return {
      ...(segmentInfo || {} as SessionInfo),
      ...(convInfo || {} as SessionInfo),
      custom_name: convInfo?.custom_name || segmentInfo?.custom_name || '',
      pinned: convInfo?.pinned ?? segmentInfo?.pinned ?? false,
      archived: convInfo?.archived ?? segmentInfo?.archived ?? false,
      continuation_session_id: convInfo?.continuation_session_id || segmentInfo?.continuation_session_id || '',
      initial_commit_head: convInfo?.initial_commit_head || segmentInfo?.initial_commit_head || '',
      permission_mode: convInfo?.permission_mode || segmentInfo?.permission_mode || 'default',
      paused_reason: convInfo?.paused_reason || segmentInfo?.paused_reason,
      imported_at: convInfo?.imported_at || undefined,
      workspace: convInfo?.workspace || segmentInfo?.workspace || 'main',
      identity_image: convInfo?.identity_image || segmentInfo?.identity_image,
      pin_character_name: convInfo?.pin_character_name || segmentInfo?.pin_character_name,
      pin_character_image: convInfo?.pin_character_image || segmentInfo?.pin_character_image,
      created_at: convInfo?.created_at || segmentInfo?.created_at || new Date().toISOString(),
      updated_at: convInfo?.updated_at || segmentInfo?.updated_at || new Date().toISOString(),
      version: convInfo?.version || segmentInfo?.version || 4,
      conversation_id: conversationId,
      branched_from_session_id: convInfo?.branched_from_session_id || segmentInfo?.branched_from_session_id || undefined,
      branched_at_turn: convInfo?.branched_at_turn ?? segmentInfo?.branched_at_turn ?? undefined,
      team_name: convInfo?.team_name || segmentInfo?.team_name || undefined,
      team_role: convInfo?.team_role || segmentInfo?.team_role || undefined,
    };
  }

  async updateSessionInfo(sessionId: string, updates: Partial<SessionInfo>): Promise<SessionInfo> {
    try {
      const existingRow = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
      const now = new Date().toISOString();
      if (existingRow) {
        const updatedSession: SessionInfo = {
          ...this.mapRow(existingRow),
          ...updates,
          updated_at: now
        };
        this.updateSessionStmt.run(this.buildUpdateSessionParams(sessionId, updatedSession));
        this.setMetadataStmt.run({ key: 'last_updated', value: now });
        return updatedSession;
      } else {
        const newSession = this.createDefaultSession(now, updates);
        this.logger.info('Inserting new session with branch info', {
          sessionId: sessionId.slice(0, 8),
          branched_from: newSession.branched_from_session_id?.slice(0, 8),
          branched_at_turn: newSession.branched_at_turn,
          updates_keys: Object.keys(updates),
        });
        this.insertSessionStmt.run(this.buildInsertSessionParams(sessionId, newSession));
        this.setMetadataStmt.run({ key: 'last_updated', value: now });
        return newSession;
      }
    } catch (error) {
      this.logger.error('Failed to update session info', { sessionId, updates, error });
      throw new Error(`Failed to update session info: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async updateCustomName(sessionId: string, customName: string): Promise<void> {
    await this.updateSessionInfo(sessionId, { custom_name: customName });
  }

  /**
   * Return names already assigned to persistent pinned characters so new
   * characters remain easy to distinguish in the shelf.
   */
  getPinnedCharacterNames(): string[] {
    const rows = this.db.prepare(`
      SELECT pin_character_name
      FROM sessions
      WHERE pin_character_name IS NOT NULL AND pin_character_name != ''
    `).all() as Array<{ pin_character_name: string }>;
    return rows.map(row => row.pin_character_name);
  }

  /**
   * Attach the first generated character and pin the session in one SQLite
   * transaction. If a concurrent request already attached one, preserve the
   * original identity and only apply the pin.
   */
  async attachPinnedCharacterAndPin(
    sessionId: string,
    character: { name: string; imageData: string },
  ): Promise<SessionInfo> {
    try {
      const transaction = this.db.transaction(() => {
        const existing = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
        if (!existing) {
          throw new Error(`Session ${sessionId} does not exist`);
        }

        const now = new Date().toISOString();
        const hasCharacter = Boolean(existing.pin_character_name && existing.pin_character_image);
        if (hasCharacter) {
          this.db.prepare(`
            UPDATE sessions SET pinned = 1, updated_at = ? WHERE session_id = ?
          `).run(now, sessionId);
        } else {
          this.db.prepare(`
            UPDATE sessions
            SET pin_character_name = ?, pin_character_image = ?, pinned = 1, updated_at = ?
            WHERE session_id = ?
          `).run(character.name, character.imageData, now, sessionId);
        }
        this.setMetadataStmt.run({ key: 'last_updated', value: now });

        const updated = this.getSessionStmt.get(sessionId) as SessionRow;
        return this.mapRow(updated);
      });

      return transaction();
    } catch (error) {
      this.logger.error('Failed to attach pinned character', { sessionId, error });
      throw new Error(`Failed to attach pinned character: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Set the identity image for a session. This is a one-time operation
   * that doesn't update the session's updated_at timestamp.
   */
  async setIdentityImage(sessionId: string, imageData: string): Promise<void> {
    try {
      const stmt = this.db.prepare('UPDATE sessions SET identity_image = ? WHERE session_id = ?');
      stmt.run(imageData, sessionId);
      this.logger.debug('Identity image set for session', { sessionId });
    } catch (error) {
      this.logger.error('Failed to set identity image', { sessionId, error });
      throw new Error(`Failed to set identity image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Set identity image only if the session does not already have one.
   * Returns true when the image was written, false when an image already existed.
   */
  async setIdentityImageIfMissing(sessionId: string, imageData: string): Promise<boolean> {
    try {
      const existing = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
      if (!existing) {
        // Session row doesn't exist yet — skip rather than auto-inserting
        // with archived=true, which poisons new sessions before the
        // lifecycle has a chance to register them properly.
        this.logger.debug('setIdentityImageIfMissing: session not yet in DB, skipping', {
          sessionId: sessionId.slice(0, 12)
        });
        return false;
      }

      const stmt = this.db.prepare(`
        UPDATE sessions
        SET identity_image = ?
        WHERE session_id = ?
          AND (identity_image IS NULL OR identity_image = '')
      `);
      const result = stmt.run(imageData, sessionId);
      return result.changes > 0;
    } catch (error) {
      this.logger.error('Failed to set identity image if missing', { sessionId, error });
      throw new Error(`Failed to set identity image if missing: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if a session already has an identity image.
   */
  async hasIdentityImage(sessionId: string): Promise<boolean> {
    try {
      const row = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
      return row?.identity_image != null;
    } catch (error) {
      this.logger.error('Failed to check identity image', { sessionId, error });
      return false;
    }
  }

  /**
   * Update the last termination reason for a session.
   * Called when a turn is captured to persist why the session ended.
   */
  async setLastTerminationReason(sessionId: string, reason: string): Promise<void> {
    try {
      const stmt = this.db.prepare('UPDATE sessions SET last_termination_reason = ? WHERE session_id = ?');
      stmt.run(reason, sessionId);
      this.logger.debug('Last termination reason set for session', { sessionId: sessionId.slice(0, 8), reason });
    } catch (error) {
      this.logger.error('Failed to set last termination reason', { sessionId, error });
      // Don't throw - this is non-critical metadata
    }
  }

  /**
   * Get MCP servers for a session.
   */
  getMcpServers(sessionId: string): Array<{ name: string; status: string }> | null {
    try {
      const row = this.db.prepare('SELECT mcp_servers FROM sessions WHERE session_id = ?').get(sessionId) as { mcp_servers: string | null } | undefined;
      if (row?.mcp_servers) {
        return parseMcpServersJson(row.mcp_servers);
      }
      return null;
    } catch (error) {
      this.logger.error('Failed to get MCP servers', { sessionId, error });
      return null;
    }
  }

  /**
   * Read MCP server names from ~/.claude.json as a fallback for sessions
   * that predate MCP persistence. Returns configured server names with
   * status "configured" (runtime status unknown). Cached after first read.
   */
  private _configuredMcpServersCache: Array<{ name: string; status: string }> | null | undefined;

  getConfiguredMcpServersFallback(): Array<{ name: string; status: string }> | null {
    if (this._configuredMcpServersCache !== undefined) {
      return this._configuredMcpServersCache;
    }

    try {
      const claudeJsonPath = path.join(process.env.HOME || os.homedir(), '.claude.json');
      if (!fs.existsSync(claudeJsonPath)) {
        this._configuredMcpServersCache = null;
        return null;
      }

      const parsed: unknown = parseJson(fs.readFileSync(claudeJsonPath, 'utf-8'));
      if (!isJsonRecord(parsed)) {
        this._configuredMcpServersCache = null;
        return null;
      }

      const mcpServers = parsed.mcpServers;
      if (!isJsonRecord(mcpServers)) {
        this._configuredMcpServersCache = null;
        return null;
      }

      const servers = Object.keys(mcpServers).map(name => ({
        name,
        status: 'configured',
      }));

      this._configuredMcpServersCache = servers.length > 0 ? servers : null;
      return this._configuredMcpServersCache;
    } catch (error) {
      this.logger.debug('Failed to read MCP servers from ~/.claude.json', { error });
      this._configuredMcpServersCache = null;
      return null;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.logger.info('Deleting session info', { sessionId });
    try {
      const result = this.deleteSessionStmt.run(sessionId);
      if (result.changes > 0) {
        const now = new Date().toISOString();
        this.setMetadataStmt.run({ key: 'last_updated', value: now });
        this.logger.info('Session info deleted successfully', { sessionId });
      } else {
        this.logger.debug('Session info not found for deletion', { sessionId });
      }
    } catch (error) {
      this.logger.error('Failed to delete session info', { sessionId, error });
      throw new Error(`Failed to delete session info: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getAllSessionInfo(): Promise<Record<string, SessionInfo>> {
    this.logger.debug('Getting all session info');
    try {
      const rows = this.getAllStmt.all() as Array<SessionRow & { session_id: string }>;
      const result: Record<string, SessionInfo> = {};
      for (const row of rows) {
        result[row.session_id] = this.mapRow(row);
      }
      return result;
    } catch (error) {
      this.logger.error('Failed to get all session info', error);
      return {};
    }
  }

  async getStats(): Promise<{ sessionCount: number; dbSize: number; lastUpdated: string }> {
    try {
      const countRow = this.countStmt.get() as { count: number };
      let dbSize = 0;
      if (this.dbPath !== ':memory:') {
        try {
          const stats = fs.statSync(this.dbPath);
          dbSize = stats.size;
        } catch {
          dbSize = 0;
        }
      }
      const lastUpdatedRow = this.getMetadataStmt.get('last_updated') as { value?: string } | undefined;
      return {
        sessionCount: countRow.count,
        dbSize,
        lastUpdated: lastUpdatedRow?.value || new Date().toISOString()
      };
    } catch (error) {
      this.logger.error('Failed to get database stats', error);
      return {
        sessionCount: 0,
        dbSize: 0,
        lastUpdated: new Date().toISOString()
      };
    }
  }

  reinitializePaths(customConfigDir?: string): void {
    this.initializePaths(customConfigDir);
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getConfigDir(): string {
    return this.configDir;
  }

  /**
   * Resolve a short session ID prefix to the full session ID.
   * Returns null if no matching session is found.
   */
  async resolveSessionId(sessionIdPrefix: string): Promise<string | null> {
    // If it's already a full UUID (36 chars), return as-is
    if (sessionIdPrefix.length === 36) {
      return sessionIdPrefix;
    }

    try {
      const row = this.db.prepare(`
        SELECT session_id FROM sessions
        WHERE session_id LIKE ?
        LIMIT 1
      `).get(`${sessionIdPrefix}%`) as { session_id: string } | undefined;

      return row?.session_id || null;
    } catch (error) {
      this.logger.debug('Failed to resolve session ID', { error, prefix: sessionIdPrefix });
      return null;
    }
  }

  async archiveAllSessions(): Promise<number> {
    this.logger.info('Archiving all sessions');
    try {
      const now = new Date().toISOString();
      const transaction = this.db.transaction(() => {
        const info = this.archiveAllStmt.run({ updated_at: now });
        if (info.changes > 0) {
          this.setMetadataStmt.run({ key: 'last_updated', value: now });
        }
        return info.changes;
      });
      const archivedCount = transaction();
      this.logger.info('Sessions archived successfully', { archivedCount });
      return archivedCount;
    } catch (error) {
      this.logger.error('Failed to archive all sessions', error);
      throw new Error(`Failed to archive all sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async syncMissingSessions(sessionIds: string[]): Promise<number> {
    try {
      const now = new Date().toISOString();
      // Default to archived=1 so filesystem-discovered sessions that never had
      // a DB row stay hidden.  Sessions created through normal startup paths
      // (session-lifecycle, updateSessionInfo) explicitly set archived=false.
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO sessions (
          session_id,
          custom_name,
          created_at,
          updated_at,
          version,
          pinned,
          archived,
          continuation_session_id,
          initial_commit_head,
          permission_mode,
          created_hidden
        ) VALUES (
          @session_id,
          '',
          @now,
          @now,
          3,
          0,
          1,
          '',
          '',
          'default',
          1
        )
      `);
      const transaction = this.db.transaction((ids: string[]) => {
        let inserted = 0;
        for (const id of ids) {
          const info = insert.run({ session_id: id, now });
          if (info.changes > 0) inserted++;
        }
        if (inserted > 0) {
          this.setMetadataStmt.run({ key: 'last_updated', value: now });
        }
        return inserted;
      });
      return transaction(sessionIds);
    } catch (error) {
      this.logger.error('Failed to sync missing sessions', error);
      throw new Error(`Failed to sync missing sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Resolve any ID to the canonical conversation ID when available.
   * Delegates to the shared resolve-canonical-id utility.
   */
  resolveCanonicalSessionId(id: string): string {
    return resolveCanonicalId(this.db, id);
  }

  /**
   * Look up the real segment for a recovered daemon process.
   * Used during startup to populate the registry with canonical segment data
   * so that findRuntimeActiveSegment can match the segment in the conversation.
   */
  getSegmentForRecovery(conversationId: string, providerSessionId: string): { segmentId: string; model?: string } | null {
    try {
      const row = this.db.prepare(`
        SELECT segment_id, model
        FROM conversation_segments
        WHERE conversation_id = ? AND provider_session_id = ?
        ORDER BY sequence_number DESC
        LIMIT 1
      `).get(conversationId, providerSessionId) as { segment_id?: string; model?: string } | undefined;
      if (row?.segment_id) {
        return { segmentId: row.segment_id, model: row.model ?? undefined };
      }
    } catch {
      // Table may not exist during early init.
    }
    return null;
  }

  /**
   * Resolve a conversation ID (conv-*) to the latest Claude provider session ID.
   * Returns the input unchanged if it's already a provider session ID or has no mapping.
   */
  resolveToProviderSessionId(id: string): string {
    if (!id.startsWith('conv-')) return id;

    try {
      const latestClaudeSegment = this.db.prepare(`
        SELECT provider_session_id
        FROM conversation_segments
        WHERE conversation_id = ? AND provider = 'claude'
        ORDER BY sequence_number DESC
        LIMIT 1
      `).get(id) as { provider_session_id?: string } | undefined;

      if (latestClaudeSegment?.provider_session_id) {
        return latestClaudeSegment.provider_session_id;
      }
    } catch {
      // Fall through to legacy mapping lookup.
    }

    try {
      const row = this.db.prepare(`
        SELECT session_id
        FROM sessions
        WHERE conversation_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(id) as { session_id?: string } | undefined;
      return row?.session_id || id;
    } catch {
      return id;
    }
  }

  /**
   * Get all non-archived session IDs (for refresh operations)
   */
  getNonArchivedSessionIds(): string[] {
    try {
      const rows = this.db.prepare('SELECT session_id FROM sessions WHERE archived = 0').all() as { session_id: string }[];
      return rows.map(r => r.session_id);
    } catch (error) {
      this.logger.error('Failed to get non-archived session IDs', error);
      return [];
    }
  }

  /**
   * Fast path for archived sessions - returns session + insights data directly from DB.
   * This avoids parsing JSONL files which is extremely slow for 1000+ archived sessions.
   *
   * @param limit - Maximum number of sessions to return
   * @param offset - Number of sessions to skip (for pagination)
   * @returns Array of session data with insights, sorted by updated_at desc
   */
  getArchivedSessionsWithInsights(limit: number, offset: number): Array<{
    sessionId: string;
    sessionInfo: SessionInfo;
    insights: InsightsRecord | null;
  }> {
    const startTime = Date.now();
    try {
      // Join sessions with insights for archived sessions, sorted by most recent
      const rows = this.db.prepare(`
        SELECT
          s.session_id,
          s.*,
          i.purpose, i.theme, i.tags,
          i.message_count, i.computed_at, i.patched_at, i.stale,
          i.lines_added, i.lines_removed, i.edit_count, i.write_count, i.metrics_updated_at
        FROM sessions s
        LEFT JOIN session_insights i ON s.session_id = i.session_id
        WHERE s.archived = 1
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset) as Array<SessionRow & {
        session_id: string;
        context?: string | null;
        tags?: string | null;
        theme?: string | null;
        computed_at?: string;
        stale?: number;
        patched_at?: string | null;
        purpose?: string | null;
        message_count?: number | null;
        lines_added?: number;
        lines_removed?: number;
        edit_count?: number;
        write_count?: number;
        metrics_updated_at?: string | null;
      }>;

      const results = rows.map(row => ({
        sessionId: row.session_id,
        sessionInfo: this.mapRow(row),
        insights: row.computed_at ? {
          session_id: row.session_id,
          context: row.context ? parseJson(row.context) as InsightsRecord['context'] : null,
          tags: row.tags ? parseJson(row.tags) as InsightsRecord['tags'] : null,
          theme: row.theme ?? null,
          computed_at: row.computed_at,
          stale: !!(row.stale),
          message_count: row.message_count ?? undefined,
          patched_at: row.patched_at ?? undefined,
          purpose: row.purpose ?? undefined,
          lines_added: row.lines_added ?? undefined,
          lines_removed: row.lines_removed ?? undefined,
          edit_count: row.edit_count ?? undefined,
          write_count: row.write_count ?? undefined,
          metrics_updated_at: row.metrics_updated_at ?? undefined,
        } satisfies InsightsRecord : null,
      }));

      this.logger.debug('getArchivedSessionsWithInsights', {
        limit,
        offset,
        returnedCount: results.length,
        durationMs: Date.now() - startTime
      });

      return results;
    } catch (error) {
      this.logger.error('Failed to get archived sessions with insights', error);
      return [];
    }
  }

  /**
   * Get total count of archived sessions (for pagination)
   */
  getArchivedSessionCount(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM sessions WHERE archived = 1').get() as { count: number };
      return row.count;
    } catch (error) {
      this.logger.error('Failed to get archived session count', error);
      return 0;
    }
  }

  // ===========================================================================
  // File Changes (for walkthrough generation)
  // ===========================================================================

  /**
   * Record a file change from an Edit or Write tool call.
   * Called by TurnCaptureService when processing tool calls.
   */
  insertFileChange(change: {
    sessionId: string;
    turnNumber: number;
    toolName: 'Edit' | 'Write';
    filePath: string;
    oldString: string | null;
    newString: string;
    timestamp: string;
  }): void {
    const id = `${change.sessionId}-${change.turnNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.insertFileChangeStmt.run({
      id,
      session_id: change.sessionId,
      turn_number: change.turnNumber,
      tool_name: change.toolName,
      file_path: change.filePath,
      old_string: change.oldString,
      new_string: change.newString,
      timestamp: change.timestamp,
    });
  }

  /**
   * Get all file changes for a session, ordered by turn number.
   */
  getFileChanges(sessionId: string): Array<{
    id: string;
    sessionId: string;
    turnNumber: number;
    toolName: string;
    filePath: string;
    oldString: string | null;
    newString: string;
    timestamp: string;
  }> {
    const rows = this.getFileChangesStmt.all(sessionId) as Array<{
      id: string;
      session_id: string;
      turn_number: number;
      tool_name: string;
      file_path: string;
      old_string: string | null;
      new_string: string;
      timestamp: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      turnNumber: row.turn_number,
      toolName: row.tool_name,
      filePath: row.file_path,
      oldString: row.old_string,
      newString: row.new_string,
      timestamp: row.timestamp,
    }));
  }

  /**
   * Copy session_turns from source session to new branch session.
   * Only copies turns with turn_number <= afterTurn.
   * Generates new IDs for the copied turns.
   * @returns Number of turns copied
   */
  copyTurnsForBranch(sourceSessionId: string, newSessionId: string, afterTurn: number): number {
    try {
      // Get turns to copy
      const turns = this.db.prepare(`
        SELECT turn_number, timestamp, headline, actions, tag, icon, exit_code, tool_count, incomplete, termination_reason
        FROM session_turns
        WHERE session_id = ? AND turn_number <= ?
      `).all(sourceSessionId, afterTurn) as Array<{
        turn_number: number;
        timestamp: string;
        headline: string;
        actions: string;
        tag: string;
        icon: string;
        exit_code: number | null;
        tool_count: number;
        incomplete: number;
        termination_reason: string;
      }>;

      if (turns.length === 0) {
        return 0;
      }

      // Insert with new session ID and new IDs
      const insertStmt = this.db.prepare(`
        INSERT INTO session_turns (id, session_id, turn_number, timestamp, headline, actions, tag, icon, exit_code, tool_count, incomplete, termination_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const turn of turns) {
        const newId = `${newSessionId}-turn-${turn.turn_number}`;
        insertStmt.run(
          newId,
          newSessionId,
          turn.turn_number,
          turn.timestamp,
          turn.headline,
          turn.actions,
          turn.tag,
          turn.icon,
          turn.exit_code,
          turn.tool_count,
          turn.incomplete,
          turn.termination_reason
        );
      }

      this.logger.debug('Copied turns for branch', {
        sourceSession: sourceSessionId.slice(0, 8),
        newSession: newSessionId.slice(0, 8),
        count: turns.length,
      });

      return turns.length;
    } catch (error) {
      this.logger.error('Failed to copy turns for branch', { error, sourceSessionId, newSessionId });
      throw error;
    }
  }

  // ===========================================================================
  // Review Analysis Cache
  // ===========================================================================

  getReviewAnalysisCache(sessionId: string): {
    turnCount: number;
    generatedAt: string;
    analysis: unknown;
  } | null {
    try {
      const row = this.db.prepare(`
        SELECT turn_count, generated_at, analysis_json
        FROM review_analysis_cache
        WHERE session_id = ?
      `).get(sessionId) as {
        turn_count: number;
        generated_at: string;
        analysis_json: string;
      } | undefined;

      if (!row) return null;
      return {
        turnCount: row.turn_count,
        generatedAt: row.generated_at,
        analysis: parseJson(row.analysis_json),
      };
    } catch (error) {
      this.logger.error('Failed to get review analysis cache', { error, sessionId });
      return null;
    }
  }

  setReviewAnalysisCache(sessionId: string, turnCount: number, analysis: unknown): void {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO review_analysis_cache (session_id, turn_count, generated_at, analysis_json)
        VALUES (?, ?, ?, ?)
      `).run(sessionId, turnCount, new Date().toISOString(), JSON.stringify(analysis));
    } catch (error) {
      this.logger.error('Failed to set review analysis cache', { error, sessionId });
    }
  }

  // ===========================================================================
  // Session Events (assistant-first observability)
  // ===========================================================================

  /**
   * Record a structured session event for debugging provider switches and session lifecycles.
   */
  recordSessionEvent(params: {
    sessionId: string;
    traceId?: string | null;
    eventType: string;
    provider?: Provider | null;
    streamingId?: string | null;
    threadId?: string | null;
    messageId?: string | null;
    source?: 'client' | 'server';
    timestamp?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const id = randomUUID();
    try {
      const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;
      this.db.prepare(`
        INSERT INTO session_events (
          id, session_id, trace_id, event_type, provider, streaming_id, thread_id, message_id,
          timestamp, source, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        params.sessionId,
        params.traceId || null,
        params.eventType,
        params.provider || null,
        params.streamingId || null,
        params.threadId || null,
        params.messageId || null,
        params.timestamp || new Date().toISOString(),
        params.source || 'server',
        metadataJson
      );
      this.logger.debug('Session event recorded', {
        id: id.slice(0, 8),
        sessionId: params.sessionId.slice(0, 8),
        eventType: params.eventType,
        provider: params.provider,
        traceId: params.traceId ? params.traceId.slice(0, 8) : undefined,
      });
      return id;
    } catch (error) {
      this.logger.error('Failed to record session event', { error, params });
      return id;
    }
  }

  /**
   * Get session events for debugging.
   */
  private buildSessionEventsQuery(params: {
    sessionId: string;
    traceId?: string;
    limit?: number;
    since?: string;
    types?: string[];
  }): { sql: string; args: Array<string | number> } {
    const conditions: string[] = ['session_id = ?'];
    const args: Array<string | number> = [params.sessionId];

    if (params.traceId) {
      conditions.push('trace_id = ?');
      args.push(params.traceId);
    }

    if (params.since) {
      conditions.push('timestamp >= ?');
      args.push(params.since);
    }

    if (params.types && params.types.length > 0) {
      const placeholders = params.types.map(() => '?').join(', ');
      conditions.push(`event_type IN (${placeholders})`);
      args.push(...params.types);
    }

    const limit = params.limit ?? 200;
    const sql = `
      SELECT * FROM session_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp ASC
      LIMIT ?
    `;
    args.push(limit);

    return { sql, args };
  }

  private parseSessionEventMetadata(metadataJson: string | null): Record<string, unknown> | null {
    if (!metadataJson) {
      return null;
    }

    try {
      return parseJson(metadataJson) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private mapSessionEventRow(row: SessionEventRow): SessionEventRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      traceId: row.trace_id,
      eventType: row.event_type,
      provider: row.provider,
      streamingId: row.streaming_id,
      threadId: row.thread_id,
      messageId: row.message_id,
      timestamp: row.timestamp,
      source: row.source,
      metadata: this.parseSessionEventMetadata(row.metadata_json),
    };
  }

  getSessionEvents(params: {
    sessionId: string;
    traceId?: string;
    limit?: number;
    since?: string;
    types?: string[];
  }): SessionEventRecord[] {
    try {
      const { sql, args } = this.buildSessionEventsQuery(params);
      const rows = this.db.prepare(sql).all(...args) as SessionEventRow[];
      return rows.map(row => this.mapSessionEventRow(row));
    } catch (error) {
      this.logger.error('Failed to get session events', { error, params });
      return [];
    }
  }

  // ===========================================================================
  // SECTION 10: Context Transfers (cross-provider context sharing)
  // ===========================================================================

  /**
   * Record a context transfer between providers.
   * Called when messages from one provider are injected into another's context.
   */
  recordContextTransfer(params: {
    conversationId: string;
    fromProvider: Provider;
    toProvider: Provider;
    sourceMessageCount: number;
    sourceFirstMessageId?: string;
    sourceLastMessageId?: string;
    contextPreview?: string;
    contextCharCount: number;
    traceId?: string;
  }): string {
    const id = `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const transferredAt = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO context_transfers (
          id, conversation_id, from_provider, to_provider, transferred_at,
          source_message_count, source_first_message_id, source_last_message_id,
          context_preview, context_char_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        params.conversationId,
        params.fromProvider,
        params.toProvider,
        transferredAt,
        params.sourceMessageCount,
        params.sourceFirstMessageId || null,
        params.sourceLastMessageId || null,
        params.contextPreview?.slice(0, 500) || null,
        params.contextCharCount
      );
      this.recordSessionEvent({
        sessionId: params.conversationId,
        traceId: params.traceId,
        eventType: 'context_transfer_recorded',
        provider: params.toProvider,
        source: 'server',
        timestamp: transferredAt,
        metadata: {
          id,
          fromProvider: params.fromProvider,
          toProvider: params.toProvider,
          sourceMessageCount: params.sourceMessageCount,
          sourceFirstMessageId: params.sourceFirstMessageId || null,
          sourceLastMessageId: params.sourceLastMessageId || null,
          contextCharCount: params.contextCharCount,
        },
      });
      this.logger.debug('Context transfer recorded', {
        id,
        conversationId: params.conversationId.slice(0, 8),
        fromProvider: params.fromProvider,
        toProvider: params.toProvider,
        messageCount: params.sourceMessageCount,
      });
      return id;
    } catch (error) {
      this.logger.error('Failed to record context transfer', { error, params });
      return id; // Return ID anyway for boundary marking
    }
  }

  /**
   * Get the most recent context transfer to a provider.
   * Used to determine which messages have already been shared.
   */
  getLastContextTransfer(conversationId: string, toProvider: Provider): {
    id: string;
    fromProvider: Provider;
    transferredAt: string;
    sourceLastMessageId: string | null;
  } | null {
    try {
      const row = this.db.prepare(`
        SELECT id, from_provider, transferred_at, source_last_message_id
        FROM context_transfers
        WHERE conversation_id = ? AND to_provider = ?
        ORDER BY transferred_at DESC
        LIMIT 1
      `).get(conversationId, toProvider) as {
        id: string;
        from_provider: string;
        transferred_at: string;
        source_last_message_id: string | null;
      } | undefined;

      if (!row) return null;

      return {
        id: row.id,
        fromProvider: row.from_provider as Provider,
        transferredAt: row.transferred_at,
        sourceLastMessageId: row.source_last_message_id,
      };
    } catch (error) {
      this.logger.error('Failed to get last context transfer', { error, conversationId, toProvider });
      return null;
    }
  }

  /**
   * Get context transfer history for a conversation.
   * Useful for debugging context sharing issues.
   */
  getContextTransferHistory(conversationId: string, limit = 20): Array<{
    id: string;
    fromProvider: Provider;
    toProvider: Provider;
    transferredAt: string;
    sourceMessageCount: number;
    sourceFirstMessageId: string | null;
    sourceLastMessageId: string | null;
    contextPreview: string | null;
    contextCharCount: number;
  }> {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM context_transfers
        WHERE conversation_id = ?
        ORDER BY transferred_at DESC
        LIMIT ?
      `).all(conversationId, limit) as Array<{
        id: string;
        from_provider: string;
        to_provider: string;
        transferred_at: string;
        source_message_count: number;
        source_first_message_id: string | null;
        source_last_message_id: string | null;
        context_preview: string | null;
        context_char_count: number;
      }>;

      return rows.map(row => ({
        id: row.id,
        fromProvider: row.from_provider as Provider,
        toProvider: row.to_provider as Provider,
        transferredAt: row.transferred_at,
        sourceMessageCount: row.source_message_count,
        sourceFirstMessageId: row.source_first_message_id,
        sourceLastMessageId: row.source_last_message_id,
        contextPreview: row.context_preview,
        contextCharCount: row.context_char_count,
      }));
    } catch (error) {
      this.logger.error('Failed to get context transfer history', { error, conversationId });
      return [];
    }
  }
}
