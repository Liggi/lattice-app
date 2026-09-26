/**
 * InsightAuditRepository - Audit logging for insight operations.
 *
 * Tracks insight generation, patching, and recompute operations
 * for debugging and observability.
 *
 * Tables managed:
 * - insight_event_audit
 */

import Database from 'better-sqlite3';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import type { InsightTrigger } from './insight-types.js';
import { parseJson } from '../../utils/json.js';

export interface AuditEventParams {
  traceId: string;
  sessionId: string;
  eventType: 'quick_check' | 'patch' | 'force_patch' | 'generate' | 'skip' | 'recompute';
  trigger: InsightTrigger;
  actionContent?: string[];
  beforeState?: {
    mission?: string;
    purpose?: string;
  };
  afterState?: {
    mission?: string;
    purpose?: string;
  };
  llmResponse?: string;
  patchedFields?: string[];
  durationMs?: number;
  skippedReason?: string;
}

export interface EventAuditRecord {
  traceId: string;
  sessionId: string;
  eventType: string;
  trigger: string;
  actionContent: string[] | null;
  beforeState: object | null;
  afterState: object | null;
  llmResponse: string | null;
  patchedFields: string[] | null;
  durationMs: number | null;
  skippedReason: string | null;
  createdAt: string;
}

export class InsightAuditRepository {
  private static instance: InsightAuditRepository;
  private logger: Logger;
  private tablesEnsured = false;

  // Retention: keep at most this many rows in insight_event_audit.
  // Older rows are pruned at startup (first ensureTables() call).
  private readonly AUDIT_MAX_ROWS = 10_000;

  private stmtInsertEvent!: Database.Statement;

  constructor(private db: Database.Database) {
    this.logger = createLogger('InsightAuditRepository');
  }

  static getInstance(): InsightAuditRepository {
    if (!InsightAuditRepository.instance) {
      InsightAuditRepository.instance = new InsightAuditRepository(DatabaseProvider.getInstance().getDb());
    }
    return InsightAuditRepository.instance;
  }

  static resetInstance(): void {
    InsightAuditRepository.instance = null as unknown as InsightAuditRepository;
  }

  private ensureTables(): void {
    if (this.tablesEnsured) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS insight_event_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        trigger TEXT NOT NULL,
        action_content TEXT,
        before_state TEXT,
        after_state TEXT,
        llm_response TEXT,
        patched_fields TEXT,
        duration_ms INTEGER,
        skipped_reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_insight_event_audit_trace_id ON insight_event_audit(trace_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_insight_event_audit_session_id ON insight_event_audit(session_id)
    `);

    this.stmtInsertEvent = this.db.prepare(`
      INSERT INTO insight_event_audit (
        trace_id, session_id, event_type, trigger,
        action_content, before_state, after_state,
        llm_response, patched_fields, duration_ms, skipped_reason
      ) VALUES (
        @traceId, @sessionId, @eventType, @trigger,
        @actionContent, @beforeState, @afterState,
        @llmResponse, @patchedFields, @durationMs, @skippedReason
      )
    `);

    this.tablesEnsured = true;

    this.pruneOldAuditRows();
  }

  private pruneOldAuditRows(): void {
    try {
      const countRow = this.db.prepare('SELECT COUNT(*) as cnt FROM insight_event_audit').get() as { cnt: number } | undefined;
      const totalRows = countRow?.cnt ?? 0;

      if (totalRows > this.AUDIT_MAX_ROWS) {
        const toDelete = totalRows - this.AUDIT_MAX_ROWS;
        this.db.prepare(`
          DELETE FROM insight_event_audit
          WHERE id IN (
            SELECT id FROM insight_event_audit
            ORDER BY created_at ASC
            LIMIT ?
          )
        `).run(toDelete);

        this.logger.info('Pruned old insight audit rows', {
          totalBefore: totalRows,
          deleted: toDelete,
          retained: this.AUDIT_MAX_ROWS,
        });
      }
    } catch (error) {
      this.logger.debug('Failed to prune audit rows', { error });
    }
  }

  /**
   * Audit event-driven insight operations with full context for debugging.
   */
  auditEvent(params: AuditEventParams): void {
    try {
      this.ensureTables();

      this.stmtInsertEvent.run({
        traceId: params.traceId,
        sessionId: params.sessionId,
        eventType: params.eventType,
        trigger: params.trigger,
        actionContent: params.actionContent ? JSON.stringify(params.actionContent) : null,
        beforeState: params.beforeState ? JSON.stringify(params.beforeState) : null,
        afterState: params.afterState ? JSON.stringify(params.afterState) : null,
        llmResponse: params.llmResponse || null,
        patchedFields: params.patchedFields ? JSON.stringify(params.patchedFields) : null,
        durationMs: params.durationMs || null,
        skippedReason: params.skippedReason || null
      });
    } catch (error) {
      this.logger.debug('Failed to audit event insight', { error });
    }
  }

  /**
   * Get full event audit history for a session (for dev tools).
   * Returns complete records with before/after state for debugging.
   */
  getFullAuditForSession(sessionId: string, options?: {
    limit?: number;
    eventTypes?: string[];
    triggers?: string[];
    since?: string;
  }): EventAuditRecord[] {
    try {
      this.ensureTables();

      let sql = `
        SELECT * FROM insight_event_audit
        WHERE session_id = ?
      `;
      const params: (string | number)[] = [sessionId];

      if (options?.eventTypes && options.eventTypes.length > 0) {
        sql += ` AND event_type IN (${options.eventTypes.map(() => '?').join(', ')})`;
        params.push(...options.eventTypes);
      }

      if (options?.triggers && options.triggers.length > 0) {
        sql += ` AND trigger IN (${options.triggers.map(() => '?').join(', ')})`;
        params.push(...options.triggers);
      }

      if (options?.since) {
        sql += ` AND created_at >= ?`;
        params.push(options.since);
      }

      sql += ` ORDER BY created_at DESC`;

      if (options?.limit) {
        sql += ` LIMIT ?`;
        params.push(options.limit);
      }

      const rows = this.db.prepare(sql).all(...params) as Array<{
        trace_id: string;
        session_id: string;
        event_type: string;
        trigger: string;
        action_content: string | null;
        before_state: string | null;
        after_state: string | null;
        llm_response: string | null;
        patched_fields: string | null;
        duration_ms: number | null;
        skipped_reason: string | null;
        created_at: string;
      }>;

      return rows.map(r => ({
        traceId: r.trace_id,
        sessionId: r.session_id,
        eventType: r.event_type,
        trigger: r.trigger,
        actionContent: r.action_content ? parseJson(r.action_content) as string[] : null,
        beforeState: r.before_state ? parseJson(r.before_state) as Record<string, unknown> : null,
        afterState: r.after_state ? parseJson(r.after_state) as Record<string, unknown> : null,
        llmResponse: r.llm_response,
        patchedFields: r.patched_fields ? parseJson(r.patched_fields) as string[] : null,
        durationMs: r.duration_ms,
        skippedReason: r.skipped_reason,
        createdAt: r.created_at
      }));
    } catch (error) {
      this.logger.debug('Failed to get full audit for session', { error });
      return [];
    }
  }
}
