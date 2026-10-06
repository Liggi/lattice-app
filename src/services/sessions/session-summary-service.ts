/**
 * SessionSummaryService
 *
 * Produces per-session summaries that feed the session index injected into
 * future Lattice agents' system prompts. The agent reading the index sees:
 * project, title, 2–4 sentence summary, anything notable, and tags — enough
 * to know whether to drill deeper into a sibling session's transcript.
 *
 * Sibling of SessionAnalysisService: same DB, same eligibility heuristic
 * (>=10 messages OR >=5 min OR >=5 tools), but generates an LLM-authored
 * digest instead of pure metric extraction.
 *
 * Generator: claude-opus-5 (alias-only ID — no date suffix).
 * Opus tier picked for accuracy on the gotcha-only notable convention and
 * typed-tag adherence. ~30–60 summaries/month, cost is order tens of dollars.
 *
 * Provenance: every row records generator_version + generator_model +
 * generated_at so a stale or regressed summary can be diagnosed and selectively
 * regenerated.
 */

import { userProjects } from '../user-profile.js';
import Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { backgroundTextClient, backgroundProvenance } from '../infrastructure/background-text-client.js';
import { getCostTracker } from '../infrastructure/cost-tracker.js';
import { SessionInfoService } from './session-info-service.js';
import { readMessages, countMessages } from '../../harness/event-message-reader.js';
import { parseJson } from '../../utils/json.js';
import type { UnifiedMessage } from '@/types/unified-messages.js';
import { allowGeneration } from '../infrastructure/generation-gates.js';

// ============================================================================
// Configuration
// ============================================================================

/** Bump when the prompt, schema, or post-processing changes meaningfully. */
const GENERATOR_VERSION = 'v3';

/** Generator model. Alias-only (no date suffix) — see KB landscape doc. */
const GENERATOR_MODEL = 'claude-opus-5-5';

/**
 * Pinned off. On the 5-family an
 * OMITTED `thinking` means adaptive thinking is ON (measured 2026-08-28:
 * opus-5 emitted a thinking block even for a one-word reply). Summarising is
 * not reasoning, and MAX_OUTPUT_TOKENS below was tuned for text output only —
 * adaptive thinking spending it reproduces the 2026-08-09 empty-body incident.
 */
const GENERATOR_THINKING: Anthropic.ThinkingConfigParam = { type: 'disabled' };

/**
 * Output budget for both summary calls — the per-chunk pass and the final one.
 *
 * A safety net, not a target. Both prompts ask for a handful of bullets or one
 * small JSON object, and the model is billed on what it writes rather than on
 * the cap, so a tight cap buys nothing and costs whole calls. At 1,500 it was
 * truncating 78 times a day (measured 2026-08-27), and a truncated FINAL call
 * is worse than a wasted one: `callLLM` scans for a `{...}` object, and a
 * response cut mid-JSON has no closing brace, so the run dies on a parse error
 * that says nothing about the budget.
 *
 * Both calls are non-streaming, so this has to stay under the SDK's
 * non-streaming ceiling of ~21,333 tokens — `calculateNonstreamingTimeout`
 * throws above it rather than sending the request. 8,000 clears that
 * comfortably and is several times the largest output either prompt
 * legitimately produces.
 */
const MAX_OUTPUT_TOKENS = 8_000;

/**
 * Eligibility thresholds (mirrors SessionAnalysisService.isEligible). Sessions
 * smaller than this aren't worth summarising — they pollute the index and
 * waste tokens.
 */
const MIN_MESSAGES = 10;
const MIN_DURATION_MIN = 5;
const MIN_TOOL_USES = 5;

/**
 * Above this stored-event count a session is eligible without reconstruction.
 * Messages never outnumber events, and no real session this large falls under
 * every threshold — while reconstructing one of these just to compare against
 * MIN_* is exactly the whole-history read that froze the event loop for tens
 * of seconds on the 30-minute sweep (2026-08-07 investigation).
 */
const EVENT_COUNT_CLEARLY_ELIGIBLE = 500;

/**
 * If the lossless rendered transcript is at most this many chars, send it
 * directly to the generator in one call. ~500K chars ≈ ~125K tokens, well
 * under Opus 4.7's 1M context with plenty of headroom for prompt + output.
 */
const SINGLE_CALL_CHAR_THRESHOLD = 500_000;

/**
 * For sessions that exceed the single-call threshold, split into chunks of
 * roughly this many chars and summarise each chunk independently. The chunk
 * summaries are then concatenated and fed into the final summarisation pass.
 * ~150K chars ≈ ~37K tokens — leaves headroom in the chunk-summary call for
 * the prompt + a few-paragraph output.
 */
const CHUNK_CHAR_TARGET = 150_000;

/** Tools we count as file-touching for the deterministic files_touched list. */
const FILE_TOUCH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Recognised tag namespace prefixes. Anything else is dropped on normalise. */
const TAG_PREFIXES = ['project:', 'tech:', 'concern:', 'produces:'];

/**
 * Per-tick cap for the periodic auto-gen loop. Bounds the worst case (large
 * backlog at startup) — the loop processes at most this many summaries per
 * tick, falling through to the next tick to clear remaining work.
 */
const TICK_MAX_SUMMARIES = 5;

/**
 * Idle grace before a session becomes a summarisation candidate. Sessions
 * touched within this window are skipped — they may still be active and
 * summarising them now would freeze a partial state. (refresh-on-update in
 * the auto-loop catches resumed sessions later, but immediate-summary on a
 * mid-flight session still ships a partial summary in the meantime.) Tuned
 * conservatively; can revisit. Exported so the backfill script applies the
 * same grace as the auto-loop.
 */
export const IDLE_GRACE_MIN = 30;

/**
 * Backlog cutoff for the auto-gen loop. Sessions ended more than this many
 * days ago are NOT auto-summarised — `listRecentForIndex` caps the rendered
 * block at the 30 most-recent summaries, so summarising a months-old session
 * pays Opus to never appear in the index. Older sessions can still be
 * summarised explicitly via `scripts/backfill-session-summaries.ts --force`.
 */
const AUTO_GEN_CUTOFF_DAYS = 7;

/**
 * Project names fed to the LLM as project-name hints, from `user.projects` in
 * config. Also used by the cwd-to-project matcher in
 * buildSystemPromptIndexBlock, so the heuristic stays in sync with the prompt.
 */
export function knownProjects(): string[] {
  return userProjects();
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Best-effort cwd → project name. Returns the first KNOWN_PROJECTS entry whose
 * name appears as a path segment of `cwd`, or null. Used for project-priority
 * ordering of the system-prompt index block. Naive on purpose — false matches
 * just affect ordering, not correctness.
 */
export function detectProjectFromCwd(cwd: string): string | null {
  if (!cwd) return null;
  const segments = cwd.split('/').filter(Boolean);
  for (const project of knownProjects()) {
    if (segments.includes(project)) return project;
  }
  return null;
}

/**
 * Render-time fallback for the project label. Prefers the LLM-extracted
 * `project` field; if null, looks for a `project:<name>` typed tag (the LLM
 * sometimes nails the project in tags but leaves the field null for
 * non-KNOWN_PROJECTS); otherwise renders `[?]`.
 */
export function formatProjectLabel(project: string | null, tags: string[]): string {
  if (project) return `[${project}]`;
  const projectTag = tags.find((t) => t.startsWith('project:'));
  if (projectTag) return `[${projectTag.slice('project:'.length)}]`;
  return '[?]';
}

// ============================================================================
// Types
// ============================================================================

export interface SessionSummary {
  sessionId: string;
  project: string | null;
  title: string | null;
  summary: string | null;
  notable: string | null;
  tags: string[];
  filesTouched: string[];
  eventCount: number | null;
  startedAt: string | null;
  endedAt: string | null;
  status: 'pending' | 'generating' | 'complete' | 'failed';
  errorMessage: string | null;
  generatorVersion: string | null;
  generatorModel: string | null;
  generatedAt: string | null;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
  messageCount: number;
  durationMinutes: number | null;
  toolUseCount: number;
}

interface LLMOutput {
  modelUsed?: string;
  project?: string | null;
  title?: string;
  summary?: string;
  notable?: string;
  tags?: string[];
}

interface SummaryRow {
  session_id: string;
  project: string | null;
  title: string | null;
  summary: string | null;
  notable: string | null;
  tags: string | null;
  files_touched: string | null;
  event_count: number | null;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  error_message: string | null;
  generator_version: string | null;
  generator_model: string | null;
  generated_at: string | null;
}

// ============================================================================
// Service
// ============================================================================

export class SessionSummaryService {
  private static instance: SessionSummaryService;
  private logger: Logger;
  private sessionInfoService: SessionInfoService;
  private db!: Database.Database;
  private isInitialized = false;

  // Prepared statements
  private getStmt!: Database.Statement;
  private upsertStmt!: Database.Statement;
  private listRecentStmt!: Database.Statement;
  private listKnownTagsStmt!: Database.Statement;
  private listNeedsSummaryStmt!: Database.Statement;

  // Scheduler state — guards against overlapping ticks when a previous tick
  // is still in flight (long Opus calls on chunked sessions can exceed the
  // tick interval).
  private tickInFlight = false;

  constructor(sessionInfoService?: SessionInfoService) {
    this.logger = createLogger('SessionSummaryService');
    this.sessionInfoService = sessionInfoService ?? SessionInfoService.getInstance();
  }

  static getInstance(): SessionSummaryService {
    if (!SessionSummaryService.instance) {
      SessionSummaryService.instance = new SessionSummaryService();
    }
    return SessionSummaryService.instance;
  }

  static resetInstance(): void {
    SessionSummaryService.instance = null as unknown as SessionSummaryService;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    await this.sessionInfoService.initialize();
    this.db = DatabaseProvider.getInstance().getDb();

    // Table itself is created by session-info-migrations.ts. Just wire prepared
    // statements here.
    this.prepareStatements();
    this.isInitialized = true;
    this.logger.info('SessionSummaryService initialized');
  }

  private prepareStatements(): void {
    this.getStmt = this.db.prepare(
      'SELECT * FROM session_summaries WHERE session_id = ?',
    );

    this.upsertStmt = this.db.prepare(`
      INSERT INTO session_summaries (
        session_id, project, title, summary, notable, tags, files_touched,
        event_count, started_at, ended_at, status, error_message,
        generator_version, generator_model, generated_at
      ) VALUES (
        @sessionId, @project, @title, @summary, @notable, @tags, @filesTouched,
        @eventCount, @startedAt, @endedAt, @status, @errorMessage,
        @generatorVersion, @generatorModel, @generatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        project           = excluded.project,
        title             = excluded.title,
        summary           = excluded.summary,
        notable           = excluded.notable,
        tags              = excluded.tags,
        files_touched     = excluded.files_touched,
        event_count       = excluded.event_count,
        started_at        = excluded.started_at,
        ended_at          = excluded.ended_at,
        status            = excluded.status,
        error_message     = excluded.error_message,
        generator_version = excluded.generator_version,
        generator_model   = excluded.generator_model,
        generated_at      = excluded.generated_at
    `);

    this.listRecentStmt = this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE status = 'complete'
      ORDER BY datetime(ended_at) DESC
      LIMIT ?
    `);

    this.listKnownTagsStmt = this.db.prepare(`
      SELECT tags FROM session_summaries
      WHERE status = 'complete' AND tags IS NOT NULL
      ORDER BY datetime(generated_at) DESC
      LIMIT 200
    `);

    // Sessions that need a summary, in any of three cases:
    //   1. No existing summary row
    //   2. Row in 'pending' status (never reached generation)
    //   3. Row in 'complete' status BUT the session has had events after the
    //      summary's covered range (refresh-on-substantive-update). Catches
    //      resumed sessions whose existing summary is now stale.
    // 'generating' and 'failed' rows are skipped — 'failed' requires manual
    // --force to retry, 'generating' means another process is on it.
    //
    // Activity is measured against MAX(harness_events.timestamp), NOT
    // sessions.updated_at — the latter only bumps on archive ops, so it
    // freezes at session-create and would make idle grace and refresh both
    // dead-code. harness_events.timestamp is integer epoch ms;
    // session_summaries.ended_at is ISO 8601, converted via unixepoch() * 1000.
    //
    // Cost, measured — the old comment here claimed the backlog cutoff "uses
    // idx_harness_events_ts", which reads as a seek and is not what happens.
    // That index is (session_id, timestamp): session_id leads, so a bare
    // `timestamp >= ?` cannot seek on it. EXPLAIN QUERY PLAN against the live
    // DB (~/.lattice/session-info.db, opened read-only, 2026-08-27) returns
    //   SCAN harness_events USING COVERING INDEX idx_harness_events_ts
    // — a FULL scan of that index, every 30-minute tick. It is covering, so it
    // never touches the `data` column and the scan is cheaper than the table
    // size suggests, but it is still linear in total events.
    //
    // A plain (timestamp) index does NOT fix it, and was measured not to: with
    // no sqlite_stat1 in the database (none has ever been written — no ANALYZE
    // has run), the planner values this index's free GROUP BY ordering above a
    // range seek and keeps the full scan. What does fix it is ANALYZE: on an
    // 800k-row replica the plan became a skip-scan,
    //   SEARCH harness_events USING COVERING INDEX idx_harness_events_ts
    //     (ANY(session_id) AND timestamp>?)
    // and the query went 16.2ms -> 1.6ms, using the index that already exists.
    // The live DB has ~2,064 distinct session_ids, the regime where skip-scan
    // is strongest. Left undone deliberately: ANALYZE writes to a 5.3GB
    // production database and is its own decision.
    this.listNeedsSummaryStmt = this.db.prepare(`
      WITH recent_activity AS (
        SELECT session_id, MAX(timestamp) AS last_ts
        FROM harness_events
        WHERE timestamp >= ?
        GROUP BY session_id
      )
      SELECT ra.session_id, ra.last_ts
      FROM recent_activity ra
      JOIN sessions s ON s.session_id = ra.session_id
      LEFT JOIN session_summaries ss ON ss.session_id = s.session_id
      WHERE ra.last_ts <= ?
        AND (
          ss.session_id IS NULL
          OR ss.status = 'pending'
          OR (ss.status = 'complete' AND (
              ss.ended_at IS NULL
              OR ra.last_ts > unixepoch(ss.ended_at) * 1000
          ))
        )
      ORDER BY ra.last_ts DESC
      LIMIT ?
    `);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  getSummary(sessionId: string): SessionSummary | null {
    const row = this.getStmt.get(sessionId) as SummaryRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Whether this session is worth summarising. Mirrors
   * SessionAnalysisService.isEligible thresholds so summary coverage matches
   * analysis coverage.
   */
  isEligible(sessionId: string): EligibilityResult {
    // Settle big sessions on a bare COUNT(*) — no history read, no JSON parse.
    const eventCount = countMessages(sessionId);
    if (eventCount >= EVENT_COUNT_CLEARLY_ELIGIBLE) {
      return {
        eligible: true,
        reason: `${eventCount} stored events`,
        messageCount: eventCount,
        toolUseCount: 0,
        durationMinutes: null,
      };
    }

    // Small session: exact check needs the messages, but the read is bounded
    // by EVENT_COUNT_CLEARLY_ELIGIBLE events.
    const messages = readMessages(sessionId);
    const messageCount = messages.length;
    const toolUseCount = this.countToolUses(messages);

    let durationMinutes: number | null = null;
    if (messages.length >= 2) {
      const firstTs = new Date(messages[0].timestamp).getTime();
      const lastTs = new Date(messages[messages.length - 1].timestamp).getTime();
      if (Number.isFinite(firstTs) && Number.isFinite(lastTs)) {
        durationMinutes = Math.round((lastTs - firstTs) / 60_000);
      }
    }

    const base = { messageCount, toolUseCount, durationMinutes };

    if (messageCount >= MIN_MESSAGES) {
      return { eligible: true, reason: `${messageCount} messages`, ...base };
    }
    if (durationMinutes !== null && durationMinutes >= MIN_DURATION_MIN) {
      return { eligible: true, reason: `${durationMinutes} min`, ...base };
    }
    if (toolUseCount >= MIN_TOOL_USES) {
      return { eligible: true, reason: `${toolUseCount} tool uses`, ...base };
    }
    return {
      eligible: false,
      reason: `too small (${messageCount} msgs / ${durationMinutes ?? 0} min / ${toolUseCount} tools)`,
      ...base,
    };
  }

  /**
   * Generate (or regenerate) a summary for a session. Always writes a row —
   * on failure, status='failed' with error_message populated.
   */
  async generateSummary(sessionId: string): Promise<SessionSummary> {
    const messages = readMessages(sessionId);
    if (messages.length === 0) {
      throw new Error(`No messages found for session ${sessionId}`);
    }

    const eventCount = messages.length;
    const startedAt = messages[0].timestamp;
    const endedAt = messages[messages.length - 1].timestamp;
    const filesTouched = this.extractFilesTouched(messages);

    // Mark generating (so concurrent runs see it in flight)
    this.upsertRow({
      sessionId,
      project: null,
      title: null,
      summary: null,
      notable: null,
      tags: [],
      filesTouched,
      eventCount,
      startedAt,
      endedAt,
      status: 'generating',
      errorMessage: null,
      generatorVersion: GENERATOR_VERSION,
      generatorModel: GENERATOR_MODEL,
      generatedAt: null,
    });

    try {
      // Lossless render — keep all user + assistant text in full, tool calls
      // as one-liners, drop thinking + tool_results.
      const renderedPerMessage = this.renderMessages(messages);
      const totalChars = renderedPerMessage.reduce((sum, s) => sum + s.length + 1, 0);

      let transcriptForFinal: string;
      let chunkCount = 0;
      if (totalChars <= SINGLE_CALL_CHAR_THRESHOLD) {
        transcriptForFinal = renderedPerMessage.join('\n');
      } else {
        // Hierarchical: chunk → Sonnet-summarise each → concat summaries.
        const chunks = this.chunkRendered(renderedPerMessage, CHUNK_CHAR_TARGET);
        chunkCount = chunks.length;
        this.logger.info('Session exceeds single-call threshold; chunking', {
          sessionId: sessionId.slice(0, 8),
          totalChars,
          chunkCount,
        });
        const chunkSummaries = await this.summariseChunks(sessionId, chunks);
        transcriptForFinal = this.formatChunkedTranscript(chunkSummaries);
      }

      const knownTags = this.getKnownTags();
      const prompt = this.buildPrompt({
        sessionId,
        startedAt,
        endedAt,
        eventCount,
        filesTouched,
        knownTags,
        transcript: transcriptForFinal,
        chunked: chunkCount > 0,
        chunkCount,
      });

      const llmOutput = await this.callLLM(sessionId, prompt);

      const generatedAt = new Date().toISOString();
      const final: SessionSummary = {
        sessionId,
        project: this.normalizeString(llmOutput.project ?? null),
        title: this.normalizeString(llmOutput.title ?? null),
        summary: this.normalizeString(llmOutput.summary ?? null),
        notable: this.normalizeString(llmOutput.notable ?? null),
        tags: this.normalizeTags(llmOutput.tags ?? []),
        filesTouched,
        eventCount,
        startedAt,
        endedAt,
        status: 'complete',
        errorMessage: null,
        generatorVersion: GENERATOR_VERSION,
        generatorModel: llmOutput.modelUsed ?? GENERATOR_MODEL,
        generatedAt,
      };
      this.upsertRow(final);
      this.logger.info('Generated session summary', {
        sessionId: sessionId.slice(0, 8),
        project: final.project,
        title: final.title,
        tags: final.tags,
      });
      return final;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.upsertRow({
        sessionId,
        project: null,
        title: null,
        summary: null,
        notable: null,
        tags: [],
        filesTouched,
        eventCount,
        startedAt,
        endedAt,
        status: 'failed',
        errorMessage,
        generatorVersion: GENERATOR_VERSION,
        generatorModel: GENERATOR_MODEL,
        generatedAt: new Date().toISOString(),
      });
      this.logger.error('Failed to generate session summary', {
        sessionId: sessionId.slice(0, 8),
        error: errorMessage,
      });
      throw error;
    }
  }

  /**
   * One pass of the periodic auto-gen loop. Find sessions that need a summary
   * (no row, or row in a non-terminal/non-in-flight state) and have been idle
   * for at least IDLE_GRACE_MIN minutes. Process up to TICK_MAX_SUMMARIES of
   * them serially. Skipped on overlap (previous tick still in flight).
   *
   * Idempotent. Safe to call repeatedly. Failures are recorded as
   * status='failed' rows — they will NOT be retried on subsequent ticks
   * (manual `--force` via the backfill script is required to retry a failed
   * session). Per-session errors are logged but don't abort the tick.
   */
  async runScheduledTick(): Promise<{
    skippedOverlap: boolean;
    candidatesFound: number;
    summarised: number;
    failed: number;
    skippedIneligible: number;
  }> {
    // Feature switch, checked per tick so turning it back on needs no restart.
    if (!allowGeneration('sessionSummary')) {
      return { skippedOverlap: false, candidatesFound: 0, summarised: 0, failed: 0, skippedIneligible: 0 };
    }

    if (this.tickInFlight) {
      this.logger.debug('Scheduled tick skipped — previous tick still in flight');
      return { skippedOverlap: true, candidatesFound: 0, summarised: 0, failed: 0, skippedIneligible: 0 };
    }
    this.tickInFlight = true;

    let summarised = 0;
    let failed = 0;
    let skippedIneligible = 0;

    try {
      // Cutoffs as integer epoch ms (harness_events.timestamp is int ms).
      // Order matters in the prepared statement: backlog cutoff (lower bound,
      // applied inside the CTE) first, then idle cutoff (upper bound).
      const nowMs = Date.now();
      const idleCutoffMs = nowMs - IDLE_GRACE_MIN * 60_000;
      const backlogCutoffMs = nowMs - AUTO_GEN_CUTOFF_DAYS * 24 * 60 * 60_000;
      const candidates = this.listNeedsSummaryStmt.all(
        backlogCutoffMs,
        idleCutoffMs,
        TICK_MAX_SUMMARIES * 4, // overfetch — eligibility check may filter some out
      ) as Array<{ session_id: string; last_ts: number }>;

      if (candidates.length === 0) {
        return { skippedOverlap: false, candidatesFound: 0, summarised: 0, failed: 0, skippedIneligible: 0 };
      }

      this.logger.info('Scheduled tick: candidates found', {
        candidatesFound: candidates.length,
        cap: TICK_MAX_SUMMARIES,
      });

      for (const row of candidates) {
        if (summarised >= TICK_MAX_SUMMARIES) break;

        const sid = row.session_id;
        let eligible = false;
        try {
          const result = this.isEligible(sid);
          eligible = result.eligible;
        } catch (err) {
          this.logger.debug('Eligibility check threw — treating as ineligible', {
            sessionId: sid.slice(0, 8),
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (!eligible) {
          skippedIneligible++;
          continue;
        }

        try {
          await this.generateSummary(sid);
          summarised++;
        } catch {
          // generateSummary already logged + persisted status='failed'. Just count.
          failed++;
        }
      }

      return { skippedOverlap: false, candidatesFound: candidates.length, summarised, failed, skippedIneligible };
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Recent completed summaries for system-prompt injection. Caller decides
   * how to render — service just returns rows ordered by ended_at DESC.
   */
  listRecentForIndex(opts: { limit?: number } = {}): SessionSummary[] {
    const limit = opts.limit ?? 30;
    const rows = this.listRecentStmt.all(limit) as SummaryRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Build the markdown block that gets spliced into the system prompt of new
   * Lattice sessions. The point: future agents are aware of what other
   * sessions on this machine have done, so they can pattern-match against
   * prior work instead of reinventing it.
   *
   * Ordering: sessions whose `project` matches the current cwd come first,
   * then most-recent-first across the rest. Empty string returned when there
   * are no completed summaries (so the caller's `.filter(Boolean)` drops it
   * cleanly).
   */
  buildSystemPromptIndexBlock(opts: { cwd?: string; limit?: number } = {}): string {
    const limit = opts.limit ?? 30;
    const cwdProject = opts.cwd ? detectProjectFromCwd(opts.cwd) : null;

    const all = this.listRecentStmt.all(limit) as SummaryRow[];
    if (all.length === 0) return '';

    const summaries = all.map((r) => this.mapRow(r));

    // Stable sort: matching-project entries first (preserving ended_at DESC
    // within each group). Array.prototype.sort is stable in modern V8 / Node.
    if (cwdProject) {
      summaries.sort((a, b) => {
        const aMatch = a.project === cwdProject ? 0 : 1;
        const bMatch = b.project === cwdProject ? 0 : 1;
        return aMatch - bMatch;
      });
    }

    const lines: string[] = [];
    lines.push('## Past Lattice sessions');
    lines.push('');
    lines.push(
      `The following is an orientation index of recent Claude Code sessions run on this machine via Lattice — title + date + a \`notable\` line for gotchas/retractions/surprises. Use it to recognise that prior work exists, then drill into the full session via the \`lattice\` CLI (\`lattice session show / transcript / inputs / tools / grep <conv>\`) when you need substance. The index is deliberately thin; do not treat the absence of detail here as the absence of work.`,
    );
    if (cwdProject) {
      lines.push('');
      lines.push(
        `Sessions matching the current project (\`${cwdProject}\`) are listed first, then the rest in reverse-chronological order.`,
      );
    } else {
      lines.push('');
      lines.push('Listed in reverse-chronological order.');
    }
    lines.push('');

    for (const s of summaries) {
      const date = (s.endedAt ?? '').slice(0, 10);
      const projectLabel = formatProjectLabel(s.project, s.tags);
      const titleLine = s.title ?? '(untitled session)';
      lines.push(`### ${projectLabel} ${titleLine}`);
      const meta: string[] = [];
      meta.push(`id: \`${s.sessionId}\``);
      if (date) meta.push(date);
      lines.push(`- ${meta.join(' · ')}`);
      if (s.notable && s.notable.toLowerCase().trim() !== 'none') {
        lines.push(`- notable: ${s.notable}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // --------------------------------------------------------------------------
  // Private — rendering / extraction
  // --------------------------------------------------------------------------

  private countToolUses(messages: UnifiedMessage[]): number {
    let count = 0;
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') count++;
      }
    }
    return count;
  }

  private extractFilesTouched(messages: UnifiedMessage[]): string[] {
    const seen = new Set<string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type !== 'tool_use') continue;
        if (!FILE_TOUCH_TOOLS.has(block.name)) continue;
        const fp = block.input?.file_path;
        if (typeof fp === 'string' && fp.length > 0) {
          seen.add(fp);
        }
      }
    }
    return Array.from(seen);
  }

  /**
   * Render UnifiedMessage[] losslessly into one string per message.
   *
   * - User text: full content, no truncation
   * - Assistant text: full content, no truncation
   * - Tool calls: one-line summary (`[tool: Name (key_arg)]`)
   * - Thinking: dropped (internal reasoning, not load-bearing for summary)
   * - Tool results: dropped (already enormous; excluded from rendering)
   *
   * Returns one string per message (could be multi-line if the message has
   * both text and tool_use blocks). Caller decides whether to send the joined
   * transcript directly or to chunk it for hierarchical summarisation.
   */
  private renderMessages(messages: UnifiedMessage[]): string[] {
    const out: string[] = [];
    for (const msg of messages) {
      const tag = msg.role === 'user' ? 'USER' : msg.role === 'assistant' ? 'ASSISTANT' : 'SYSTEM';
      const lines: string[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          lines.push(`${tag}: ${block.text}`);
        } else if (block.type === 'tool_use') {
          const arg = this.summariseToolInput(block.name, block.input);
          lines.push(`${tag} [tool: ${block.name}${arg ? ` ${arg}` : ''}]`);
        }
        // tool_result, thinking, image, document, code → skip
      }
      if (lines.length > 0) {
        out.push(lines.join('\n'));
      }
    }
    return out;
  }

  /**
   * Group per-message rendered strings into chunks of approximately
   * `targetChars` each, splitting only at message boundaries. The last chunk
   * may be smaller. Never splits a message in half.
   */
  private chunkRendered(rendered: string[], targetChars: number): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let currentChars = 0;
    for (const msg of rendered) {
      const msgLen = msg.length + 1;
      // If adding this message overflows AND we already have content, flush.
      if (currentChars + msgLen > targetChars && current.length > 0) {
        chunks.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(msg);
      currentChars += msgLen;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  private summariseToolInput(name: string, input: Record<string, unknown>): string {
    if (!input) return '';
    if (typeof input.file_path === 'string') return `(${input.file_path})`;
    if (typeof input.command === 'string') {
      return `(${this.truncate(input.command, 120)})`;
    }
    if (typeof input.pattern === 'string') return `(${this.truncate(input.pattern, 80)})`;
    if (typeof input.url === 'string') return `(${input.url})`;
    if (typeof input.query === 'string') return `(${this.truncate(input.query, 80)})`;
    return '';
  }

  private truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return `${s.slice(0, n)}…`;
  }

  // --------------------------------------------------------------------------
  // Private — hierarchical summarisation
  // --------------------------------------------------------------------------

  /**
   * Sonnet-summarise each chunk in parallel (bounded concurrency to stay
   * under rate limits). One failed chunk fails the whole session — we don't
   * silently degrade; the next backfill run can retry.
   */
  private async summariseChunks(
    sessionId: string,
    chunks: string[][],
  ): Promise<string[]> {
    const concurrency = 3;
    const results: string[] = new Array<string>(chunks.length);
    let nextIdx = 0;

    const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= chunks.length) return;
        results[idx] = await this.summariseChunk(sessionId, idx, chunks.length, chunks[idx]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  private async summariseChunk(
    sessionId: string,
    idx: number,
    total: number,
    chunk: string[],
  ): Promise<string> {
    const client = backgroundTextClient.getClient('sessionSummary');
    if (!client) {
      throw new Error('Anthropic client unavailable (no API key configured)');
    }

    const chunkText = chunk.join('\n');
    const prompt = `You are summarising chunk ${idx + 1} of ${total} from a long Claude Code session that won't fit in a single LLM call.

This is a *partial* view. Don't try to characterise the whole session — only what happened in this slice.

Capture:
1. What the user (USER) directed the agent to do during this chunk (paraphrased).
2. What the agent actually did — concrete actions, files touched, decisions made, problems hit.
3. Anything notable: blockers, surprising findings, things abandoned, gotchas worth remembering.

Be terse and information-dense — this summary will be concatenated with summaries of other chunks and fed to a final summarisation pass. 4–8 short bullet points is the right shape. Do not include preamble or wrap-up; just the bullets.

=== Chunk ${idx + 1} of ${total} ===
${chunkText}
=== End chunk ${idx + 1} ===

Bullets:`;

    const startTime = Date.now();
    const response = await client.messages.create({
      model: GENERATOR_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: GENERATOR_THINKING,
      messages: [{ role: 'user', content: prompt }],
    });
    const durationMs = Date.now() - startTime;

    try {
      getCostTracker().log({
        sessionId,
        operation: 'SESSION_SUMMARY',
        ...backgroundProvenance(response, GENERATOR_MODEL),
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
        durationMs,
      });
    } catch (err) {
      this.logger.debug('Cost tracking failed (chunk)', { error: err });
    }

    // A truncated chunk summary is still usable — it is bullets, and the final
    // pass reads it as prose — so this stays a warn and the text below is kept.
    if (response.stop_reason === 'max_tokens') {
      this.logger.warn('Chunk summary hit max_tokens', {
        sessionId: sessionId.slice(0, 8),
        idx,
        total,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
    }

    const text = response.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    if (text.length === 0) {
      throw new Error(`Empty chunk summary returned for chunk ${idx + 1}/${total}`);
    }
    return text;
  }

  private formatChunkedTranscript(chunkSummaries: string[]): string {
    const parts: string[] = [
      `This session was too long to include verbatim. Below are bullet-point summaries of ${chunkSummaries.length} consecutive chunks of the conversation, in chronological order:`,
      '',
    ];
    chunkSummaries.forEach((summary, idx) => {
      parts.push(`=== Chunk ${idx + 1} of ${chunkSummaries.length} ===`);
      parts.push(summary);
      parts.push('');
    });
    return parts.join('\n');
  }

  // --------------------------------------------------------------------------
  // Private — LLM
  // --------------------------------------------------------------------------

  private buildPrompt(args: {
    sessionId: string;
    startedAt: string;
    endedAt: string;
    eventCount: number;
    filesTouched: string[];
    knownTags: string[];
    transcript: string;
    chunked: boolean;
    chunkCount: number;
  }): string {
    const {
      sessionId, startedAt, endedAt, eventCount, filesTouched,
      knownTags, transcript, chunked, chunkCount,
    } = args;

    const filesBlock = filesTouched.length > 0
      ? filesTouched.slice(0, 30).map((f) => `  - ${f}`).join('\n')
      : '  (none recorded)';

    const tagsBlock = knownTags.length > 0
      ? knownTags.slice(0, 50).join(', ')
      : '(none yet — this is one of the first sessions being summarised)';

    const transcriptLabel = chunked
      ? `Chunked summaries (this session was too long to include verbatim, so it was split into ${chunkCount} chronological chunks and each was summarised separately):`
      : 'Conversation transcript (USER/ASSISTANT roles, [tool: name (arg)] for tool calls; tool results and thinking blocks omitted):';

    return `You are summarising a Claude Code session for an index that helps future agents
understand what happened in past Lattice sessions and decide whether to read more.

Output STRICT JSON matching this schema (no preamble, no markdown fences):

{
  "project": "string or null — best guess at which project this session was about",
  "title":   "string — 5–10 word phrase capturing what this session was about",
  "summary": "string — 2–4 sentences describing what was actually done overall",
  "notable": "string — GOTCHA-ONLY. Fill ONLY when there is a real gotcha worth flagging in the index: a decision reversed mid-session, a non-obvious blocker, a surprising finding, an explicit retraction or correction by the user or assistant, a non-trivial dead end. If the session ran without anything surprising, output the exact word \\"none\\". DO NOT use this field as continuation of the summary.",
  "tags":    ["array of 3–7 typed kebab-case tags — see Tags rules below"]
}

Tags rules (READ CAREFULLY — strict):
  EVERY tag MUST start with one of these namespace prefixes. Tags without a prefix are INVALID and will be rejected:
    project:<name>     — primary project worked on (use a project hint below)
    tech:<thing>       — technologies/services/libraries ACTUALLY TOUCHED in this session (not just mentioned in passing, not adjacent context)
    concern:<thing>    — cross-cutting concerns (e.g. concern:testing, concern:hallucination-retraction, concern:performance, concern:schema-migration)
    produces:<thing>   — concrete artifact produced (e.g. produces:wiki-page, produces:kb-rule, produces:eval, produces:bugfix)

  Use 3–7 tags total. PREFER REUSING tags from prior summaries (shown below). HOWEVER: existing summaries may contain LEGACY UNPREFIXED tags — DO NOT copy them verbatim. Wrap each in the appropriate namespace, OR drop it entirely. Never emit a tag without a prefix.

  Be conservative on tech:*. Only tag technologies actually touched in this session. Do not infer tech tags from passing references.

Project hints (pick the closest match if obvious from the conversation, otherwise pick a sensible custom name or null):
${knownProjects().map((p) => `  - ${p}`).join('\n') || '  (none configured)'}

Existing tags from prior summaries:
${tagsBlock}

Session metadata:
  - session_id: ${sessionId}
  - started: ${startedAt}
  - ended:   ${endedAt}
  - events:  ${eventCount}
  - files touched (first 30):
${filesBlock}

${transcriptLabel}

---
${transcript}
---

Remember: respond ONLY with the JSON object. No preamble. No markdown code fences. No commentary.`;
  }

  private async callLLM(sessionId: string, prompt: string): Promise<LLMOutput> {
    const client = backgroundTextClient.getClient('sessionSummary');
    if (!client) {
      throw new Error('Anthropic client unavailable (no API key configured)');
    }

    const startTime = Date.now();
    const response = await client.messages.create({
      model: GENERATOR_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: GENERATOR_THINKING,
      messages: [{ role: 'user', content: prompt }],
    });
    const durationMs = Date.now() - startTime;

    // Cost tracking (best-effort)
    try {
      getCostTracker().log({
        sessionId,
        operation: 'SESSION_SUMMARY',
        ...backgroundProvenance(response, GENERATOR_MODEL),
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
        durationMs,
      });
    } catch (err) {
      this.logger.debug('Cost tracking failed', { error: err });
    }

    const truncated = response.stop_reason === 'max_tokens';
    if (truncated) {
      this.logger.warn('Session summary hit max_tokens', {
        sessionId: sessionId.slice(0, 8),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        outputTokens: response.usage?.output_tokens ?? null,
      });
    }

    const text = response.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    // Strip optional markdown fence if the model added one despite the prompt.
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Name the budget when the budget is what happened. A response cut off
      // mid-JSON has no closing brace, so it lands here looking like the model
      // ignored the format instruction — which sends the next reader to the
      // prompt instead of to the cap.
      if (truncated) {
        throw new Error(
          `Session summary hit the ${MAX_OUTPUT_TOKENS}-token output cap before closing its JSON `
          + `object — raise MAX_OUTPUT_TOKENS or shorten the transcript. Got: ${text.slice(0, 200)}`,
        );
      }
      throw new Error(`No JSON object in LLM response: ${text.slice(0, 200)}`);
    }

    const parsed = parseJson(jsonMatch[0]) as LLMOutput;
    return { ...parsed, modelUsed: response.model || GENERATOR_MODEL };
  }

  // --------------------------------------------------------------------------
  // Private — DB row plumbing
  // --------------------------------------------------------------------------

  private upsertRow(s: SessionSummary): void {
    this.upsertStmt.run({
      sessionId: s.sessionId,
      project: s.project,
      title: s.title,
      summary: s.summary,
      notable: s.notable,
      tags: JSON.stringify(s.tags),
      filesTouched: JSON.stringify(s.filesTouched),
      eventCount: s.eventCount,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status,
      errorMessage: s.errorMessage,
      generatorVersion: s.generatorVersion,
      generatorModel: s.generatorModel,
      generatedAt: s.generatedAt,
    });
  }

  private mapRow(row: SummaryRow): SessionSummary {
    return {
      sessionId: row.session_id,
      project: row.project,
      title: row.title,
      summary: row.summary,
      notable: row.notable,
      tags: this.safeParseStringArray(row.tags),
      filesTouched: this.safeParseStringArray(row.files_touched),
      eventCount: row.event_count,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: row.status as SessionSummary['status'],
      errorMessage: row.error_message,
      generatorVersion: row.generator_version,
      generatorModel: row.generator_model,
      generatedAt: row.generated_at,
    };
  }

  private safeParseStringArray(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const parsed = parseJson(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      // fallthrough
    }
    return [];
  }

  private normalizeString(s: string | null | undefined): string | null {
    if (s === null || s === undefined) return null;
    const trimmed = String(s).trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeTags(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of raw) {
      if (typeof t !== 'string') continue;
      const tag = t.trim().toLowerCase().replace(/\s+/g, '-');
      if (tag.length === 0 || seen.has(tag)) continue;
      // Defense-in-depth: drop tags that don't follow the typed-tag convention.
      // Prompt instructs the model to wrap or drop legacy unprefixed tags, but
      // adherence isn't 100% — silently drop here so the index never ingests
      // unprefixed tags.
      if (!TAG_PREFIXES.some((p) => tag.startsWith(p))) continue;
      seen.add(tag);
      out.push(tag);
    }
    return out;
  }

  /**
   * Pull the recent tag vocabulary so the LLM converges on stable tag names
   * across runs (mitigates index-fragmentation from free-form tags).
   */
  private getKnownTags(): string[] {
    const rows = this.listKnownTagsStmt.all() as Array<{ tags: string | null }>;
    const counts = new Map<string, number>();
    for (const row of rows) {
      const tags = this.safeParseStringArray(row.tags);
      for (const t of tags) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
  }
}
