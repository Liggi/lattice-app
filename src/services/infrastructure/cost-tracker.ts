/**
 * CostTracker - Tracks LLM API costs for insights generation.
 *
 * Provides:
 * - Per-call cost logging with session, operation, model, tokens
 * - Summary queries (today, this week, by operation, by model)
 * - Cost estimation using current Anthropic pricing
 *
 * Design decisions:
 * - Separate table from session insights for clean separation
 * - Uses same database file for simplicity
 * - Costs stored in USD for consistency
 */

import Database from 'better-sqlite3';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import { DatabaseProvider } from './database-provider.js';
import type { LLMOperationType } from '../insights/insight-types.js';

/**
 * Per-1M-token list prices, verified 2026-08-28.
 *
 * This is a ledger's price book, so it deliberately keeps entries for models
 * nobody should pick today — historical rows still have to price correctly.
 * stale-model-ok.
 *
 * Keep it current when a model ships. It went five months without the 5-family
 * while the generators ran on exactly those models, so every one of those calls
 * fell through to DEFAULT_PRICING instead. Sonnet 5 really costs $2/$10; the old
 * default charged $3/$15, making the estimate 18% high. Silent either way, which
 * is the problem — a price book that is quietly wrong reads exactly like one
 * that is right.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  // Current
  'claude-opus-5-5': { input: 4.0, output: 20.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-fable-5-1': { input: 10.0, output: 50.0 },
  'claude-fable-5': { input: 10.0, output: 50.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  // Superseded — retained so old ledger rows price correctly. stale-model-ok.
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-opus-4-5-20251101': { input: 15.0, output: 75.0 },
  'claude-opus-4-5': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  // Other providers
  'gemini-3.1-pro-preview': { input: 2.0, output: 12.0 },
  // TypeSafe publishes no price page. $0.042/M input with output free is the
  // early-access rate quoted by third parties (Requesty, 2026-09); unconfirmed.
  'jev-latest': { input: 0.042, output: 0 },
};

/**
 * Unknown models price at the top of the table rather than the middle. An
 * unpriced model is a gap in this file, and the estimate should read high
 * enough to get noticed instead of blending into the noise.
 */
const DEFAULT_PRICING = { input: 10.0, output: 50.0 };

/**
 * Prompt-caching multipliers on the base input rate (verified 2026-08-28).
 *
 * These exist because `usage.input_tokens` is the *uncached remainder only* —
 * the full prompt is `input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens`. Recording only `input_tokens`, as this tracker did
 * until now, means that the day anyone enables prompt caching the meter starts
 * under-reporting with no error and no visible change. Nothing here uses
 * caching today (no `cache_control` anywhere in the codebase), which is exactly
 * why it needs handling before it becomes load-bearing rather than after.
 */
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute TTL; a 1h TTL would be 2.0
const CACHE_READ_MULTIPLIER = 0.1;

/** Which process spent the money. Answers "broken down by source". */
export type SpendSource = 'lattice' | 'ambient-scan' | 'daemon' | 'script';

/** Which bill it lands on. Three separate invoices, so keep them separable. */
export type SpendProvider = 'anthropic' | 'openai' | 'google' | 'typesafe';

/**
 * Adds a column to an existing table when it isn't there yet. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, and this runs on every boot.
 */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export interface LLMCallRecord {
  sessionId: string;
  operation: LLMOperationType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  traceId?: string;
  /** Defaults to 'lattice' — the server's own calls. */
  source?: SpendSource;
  /** Defaults to 'anthropic'. Set it for OpenAI and Gemini calls. */
  provider?: SpendProvider;
  /** 'endpoint': a server the user saved, whose price Lattice does not know; logged at no cost. */
  billingKind?: 'chatgpt-plan' | 'endpoint';
  /**
   * Prompt-cache tokens, straight from `usage`. Pass these whenever the
   * provider reports them — `inputTokens` alone is the uncached remainder, so
   * omitting these under-reports the true prompt size and its cost.
   */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface CostSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface CostSummaryResponse {
  today: CostSummary;
  thisWeek: CostSummary;
  thisMonth: CostSummary;
  allTime: CostSummary;
  byOperation: Record<string, CostSummary>;
  byModel: Record<string, CostSummary>;
  recentCalls: Array<{
    sessionId: string;
    operation: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
    createdAt: string;
  }>;
}

export class CostTracker {
  private logger: Logger;
  private db: Database.Database | null = null;
  private isInitialized = false;
  private dbPath: string;
  private configDir: string;

  // Prepared statements for performance
  private insertStmt: Database.Statement | null = null;
  private summaryStmt: Database.Statement | null = null;

  constructor(testDbPath?: string) {
    this.logger = createLogger('CostTracker');
    this.testDbPath = testDbPath;
    this.configDir = '';
    this.dbPath = '';
  }

  private testDbPath?: string;

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      const providerArg = this.testDbPath === ':memory:' ? ':memory:' : undefined;
      const provider = DatabaseProvider.getInstance(providerArg);
      this.db = provider.getDb();
      this.dbPath = provider.getDbPath();

      // Create llm_costs table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS llm_costs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          estimated_cost_usd REAL NOT NULL,
          duration_ms INTEGER NOT NULL,
          trace_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_llm_costs_session ON llm_costs(session_id);
        CREATE INDEX IF NOT EXISTS idx_llm_costs_created ON llm_costs(created_at);
        CREATE INDEX IF NOT EXISTS idx_llm_costs_operation ON llm_costs(operation);
      `);

      // `source` and `provider` were added 2026-08-28, when this table turned
      // out to be Anthropic-and-Lattice-only while three other things on the
      // machine were spending: voice (OpenAI), Gemini, and a standalone
      // ambient-scan process. A daily total drawn from this table without them
      // reads as complete and is not. Backfilled rows are all Lattice/Anthropic,
      // which is true of everything written before today.
      addColumnIfMissing(this.db, 'llm_costs', 'source', "TEXT NOT NULL DEFAULT 'lattice'");
      addColumnIfMissing(this.db, 'llm_costs', 'provider', "TEXT NOT NULL DEFAULT 'anthropic'");
      this.db.exec(`CREATE TABLE IF NOT EXISTS chatgpt_plan_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        operation TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_llm_costs_source ON llm_costs(source);');

      // Cache columns, added the same day for the same reason: `input_tokens`
      // is the uncached remainder, so a row without these silently describes a
      // smaller prompt than actually ran. Defaulting to 0 is correct for every
      // existing row — no call site has ever set cache_control.
      addColumnIfMissing(this.db, 'llm_costs', 'cache_creation_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(this.db, 'llm_costs', 'cache_read_input_tokens', 'INTEGER NOT NULL DEFAULT 0');

      this.prepareStatements();
      this.isInitialized = true;
      this.logger.info('Cost tracker initialized');
    } catch (error) {
      this.logger.error('Failed to initialize cost tracker', { error });
      throw error;
    }
  }

  private prepareStatements(): void {
    if (!this.db) return;

    this.insertStmt = this.db.prepare(`
      INSERT INTO llm_costs (session_id, operation, model, input_tokens, output_tokens, estimated_cost_usd, duration_ms, trace_id, source, provider, cache_creation_input_tokens, cache_read_input_tokens, created_at)
      VALUES (@sessionId, @operation, @model, @inputTokens, @outputTokens, @estimatedCostUsd, @durationMs, @traceId, @source, @provider, @cacheCreationInputTokens, @cacheReadInputTokens, datetime('now'))
    `);
  }

  /**
   * Cost in USD for one call.
   *
   * Cached tokens are billed at their own rates rather than the base input
   * rate, so they are priced separately: reads at a tenth, writes at a
   * premium. `inputTokens` is only the uncached remainder — adding the three
   * together is what reconstructs the true prompt.
   */
  private calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens = 0,
    cacheReadInputTokens = 0,
  ): number {
    const pricing = PRICING[model] || DEFAULT_PRICING;
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    const cacheWriteCost =
      (cacheCreationInputTokens / 1_000_000) * pricing.input * CACHE_WRITE_MULTIPLIER;
    const cacheReadCost =
      (cacheReadInputTokens / 1_000_000) * pricing.input * CACHE_READ_MULTIPLIER;
    return inputCost + outputCost + cacheWriteCost + cacheReadCost;
  }

  /**
   * Log an LLM API call with its cost.
   */
  log(record: LLMCallRecord): void {
    if (!this.isInitialized || !this.insertStmt) {
      this.logger.warn('Cost tracker not initialized, skipping log');
      return;
    }

    if (record.billingKind === 'chatgpt-plan') {
      this.db!.prepare(`INSERT INTO chatgpt_plan_usage
        (session_id, operation, model, input_tokens, output_tokens, cached_tokens, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(record.sessionId, record.operation, record.model,
        record.inputTokens, record.outputTokens, record.cacheReadInputTokens ?? 0, record.durationMs);
      return;
    }

    const cacheCreationInputTokens = record.cacheCreationInputTokens ?? 0;
    const cacheReadInputTokens = record.cacheReadInputTokens ?? 0;
    const estimatedCostUsd = record.billingKind === 'endpoint' ? 0 : this.calculateCost(
      record.model,
      record.inputTokens,
      record.outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    );

    try {
      this.insertStmt.run({
        sessionId: record.sessionId,
        operation: record.operation,
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        estimatedCostUsd,
        durationMs: record.durationMs,
        traceId: record.traceId || null,
        source: record.source ?? 'lattice',
        provider: record.provider ?? 'anthropic',
        cacheCreationInputTokens,
        cacheReadInputTokens,
      });

      this.logger.debug('Cost logged', {
        sessionId: record.sessionId.slice(0, 8),
        operation: record.operation,
        model: record.model.split('-').slice(-2).join('-'), // Just version part
        tokens: `${record.inputTokens}/${record.outputTokens}`,
        cost: `$${estimatedCostUsd.toFixed(4)}`,
        durationMs: record.durationMs,
      });
    } catch (error) {
      this.logger.error('Failed to log cost', { error, record });
    }
  }

  /**
   * Get cost summary for different time periods.
   */
  getSummary(): CostSummaryResponse {
    if (!this.isInitialized || !this.db) {
      return this.emptySummaryResponse();
    }

    // Must match SQLite datetime('now') format: 'YYYY-MM-DD HH:MM:SS'
    const formatForSQLite = (date: Date): string => {
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
    };

    const now = new Date();
    const todayStart = formatForSQLite(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    const weekStart = formatForSQLite(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
    const monthStart = formatForSQLite(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));

    // Helper to query summary for a date range
    const querySummary = (startDate?: string): CostSummary => {
      const sql = startDate
        ? `SELECT
             COUNT(*) as calls,
             COALESCE(SUM(input_tokens), 0) as inputTokens,
             COALESCE(SUM(output_tokens), 0) as outputTokens,
             COALESCE(SUM(estimated_cost_usd), 0) as estimatedCostUsd
           FROM llm_costs
           WHERE created_at >= ?`
        : `SELECT
             COUNT(*) as calls,
             COALESCE(SUM(input_tokens), 0) as inputTokens,
             COALESCE(SUM(output_tokens), 0) as outputTokens,
             COALESCE(SUM(estimated_cost_usd), 0) as estimatedCostUsd
           FROM llm_costs`;

      interface SummaryRow {
        calls: number;
        inputTokens: number;
        outputTokens: number;
        estimatedCostUsd: number;
      }
      const row = startDate
        ? this.db!.prepare(sql).get(startDate) as SummaryRow | undefined
        : this.db!.prepare(sql).get() as SummaryRow | undefined;

      return {
        calls: row?.calls || 0,
        inputTokens: row?.inputTokens || 0,
        outputTokens: row?.outputTokens || 0,
        totalTokens: (row?.inputTokens || 0) + (row?.outputTokens || 0),
        estimatedCostUsd: row?.estimatedCostUsd || 0,
      };
    };

    // Query by operation
    interface OperationRow {
      operation: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
    }
    const byOperationRows = this.db.prepare(`
      SELECT
        operation,
        COUNT(*) as calls,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(estimated_cost_usd), 0) as estimatedCostUsd
      FROM llm_costs
      GROUP BY operation
    `).all() as OperationRow[];

    const byOperation: Record<string, CostSummary> = {};
    for (const row of byOperationRows) {
      byOperation[row.operation] = {
        calls: row.calls,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.inputTokens + row.outputTokens,
        estimatedCostUsd: row.estimatedCostUsd,
      };
    }

    // Query by model
    interface ModelRow {
      model: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
    }
    const byModelRows = this.db.prepare(`
      SELECT
        model,
        COUNT(*) as calls,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(estimated_cost_usd), 0) as estimatedCostUsd
      FROM llm_costs
      GROUP BY model
    `).all() as ModelRow[];

    const byModel: Record<string, CostSummary> = {};
    for (const row of byModelRows) {
      byModel[row.model] = {
        calls: row.calls,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.inputTokens + row.outputTokens,
        estimatedCostUsd: row.estimatedCostUsd,
      };
    }

    // Get recent calls for debugging/visibility
    interface RecentCallRow {
      sessionId: string;
      operation: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      durationMs: number;
      createdAt: string;
    }
    const recentCalls = this.db.prepare(`
      SELECT
        session_id as sessionId,
        operation,
        model,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        estimated_cost_usd as estimatedCostUsd,
        duration_ms as durationMs,
        created_at as createdAt
      FROM llm_costs
      ORDER BY created_at DESC
      LIMIT 20
    `).all() as RecentCallRow[];

    return {
      today: querySummary(todayStart),
      thisWeek: querySummary(weekStart),
      thisMonth: querySummary(monthStart),
      allTime: querySummary(),
      byOperation,
      byModel,
      recentCalls,
    };
  }

  getPlanUsage(): { calls: number; inputTokens: number; outputTokens: number } {
    if (!this.isInitialized || !this.db) return { calls: 0, inputTokens: 0, outputTokens: 0 };
    return this.db.prepare(`SELECT COUNT(*) as calls, COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens FROM chatgpt_plan_usage`).get() as { calls: number; inputTokens: number; outputTokens: number };
  }

  /**
   * Get costs for a specific session.
   */
  getSessionCosts(sessionId: string): CostSummary & { recentCalls: Array<{
    operation: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
    createdAt: string;
  }> } {
    if (!this.isInitialized || !this.db) {
      return {
        ...this.emptySummary(),
        recentCalls: [],
      };
    }

    interface SessionSummaryRow {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
    }
    const summary = this.db.prepare(`
      SELECT
        COUNT(*) as calls,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(estimated_cost_usd), 0) as estimatedCostUsd
      FROM llm_costs
      WHERE session_id = ?
    `).get(sessionId) as SessionSummaryRow | undefined;

    interface SessionRecentCallRow {
      operation: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      durationMs: number;
      createdAt: string;
    }
    const recentCalls = this.db.prepare(`
      SELECT
        operation,
        model,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        estimated_cost_usd as estimatedCostUsd,
        duration_ms as durationMs,
        created_at as createdAt
      FROM llm_costs
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(sessionId) as SessionRecentCallRow[];

    return {
      calls: summary?.calls || 0,
      inputTokens: summary?.inputTokens || 0,
      outputTokens: summary?.outputTokens || 0,
      totalTokens: (summary?.inputTokens || 0) + (summary?.outputTokens || 0),
      estimatedCostUsd: summary?.estimatedCostUsd || 0,
      recentCalls,
    };
  }

  /**
   * Get time-series data for charts.
   * Returns costs aggregated by time bucket (minute, hour, or day).
   */
  getTimeSeries(options: {
    bucket?: 'minute' | 'hour' | 'day';
    startDate?: string;
    endDate?: string;
    sessionId?: string;
  } = {}): Array<{
    timestamp: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    byOperation: Record<string, number>;
  }> {
    if (!this.isInitialized || !this.db) {
      return [];
    }

    // Normalize ISO dates to SQLite format (YYYY-MM-DD HH:MM:SS)
    const normalizeDate = (dateStr?: string): string | undefined => {
      if (!dateStr) return undefined;
      // If it's already in SQLite format (has space, no T), return as-is
      if (dateStr.includes(' ') && !dateStr.includes('T')) return dateStr;
      // Convert ISO format to SQLite format
      const date = new Date(dateStr);
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
    };

    const { bucket = 'hour', sessionId } = options;
    const startDate = normalizeDate(options.startDate);
    const endDate = normalizeDate(options.endDate);

    // SQLite strftime format based on bucket
    const formatMap = {
      minute: '%Y-%m-%d %H:%M',
      hour: '%Y-%m-%d %H:00',
      day: '%Y-%m-%d',
    };
    const format = formatMap[bucket];

    // Build WHERE clause
    const conditions: string[] = [];
    const params: (string | undefined)[] = [];

    if (startDate) {
      conditions.push('created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('created_at <= ?');
      params.push(endDate);
    }
    if (sessionId) {
      conditions.push('session_id = ?');
      params.push(sessionId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Main aggregation query
    interface TimeSeriesRow {
      timestamp: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
    }
    const mainQuery = `
      SELECT
        strftime('${format}', created_at) as timestamp,
        COUNT(*) as calls,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(estimated_cost_usd), 0) as estimatedCostUsd
      FROM llm_costs
      ${whereClause}
      GROUP BY strftime('${format}', created_at)
      ORDER BY timestamp ASC
    `;
    const mainRows = this.db.prepare(mainQuery).all(...params) as TimeSeriesRow[];

    // Per-operation breakdown query
    interface OperationBreakdownRow {
      timestamp: string;
      operation: string;
      cost: number;
    }
    const opQuery = `
      SELECT
        strftime('${format}', created_at) as timestamp,
        operation,
        COALESCE(SUM(estimated_cost_usd), 0) as cost
      FROM llm_costs
      ${whereClause}
      GROUP BY strftime('${format}', created_at), operation
      ORDER BY timestamp ASC
    `;
    const opRows = this.db.prepare(opQuery).all(...params) as OperationBreakdownRow[];

    // Build lookup for per-operation costs
    const opLookup: Record<string, Record<string, number>> = {};
    for (const row of opRows) {
      if (!opLookup[row.timestamp]) {
        opLookup[row.timestamp] = {};
      }
      opLookup[row.timestamp][row.operation] = row.cost;
    }

    // Combine results
    return mainRows.map(row => ({
      timestamp: row.timestamp,
      calls: row.calls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      estimatedCostUsd: row.estimatedCostUsd,
      byOperation: opLookup[row.timestamp] || {},
    }));
  }

  private emptySummary(): CostSummary {
    return {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
  }

  private emptySummaryResponse(): CostSummaryResponse {
    const empty = this.emptySummary();
    return {
      today: empty,
      thisWeek: empty,
      thisMonth: empty,
      allTime: empty,
      byOperation: {},
      byModel: {},
      recentCalls: [],
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    // Don't close the shared DB connection — just release our reference
    this.db = null;
    this.isInitialized = false;
  }
}

// Singleton instance
let instance: CostTracker | null = null;

export function getCostTracker(): CostTracker {
  if (!instance) {
    instance = new CostTracker();
  }
  return instance;
}
