#!/usr/bin/env npx tsx
/**
 * Backfill Session Summaries
 *
 * Generates LLM-authored session summaries for the most recent eligible
 * sessions. The summaries feed the session-index block injected into future
 * Lattice agents' system prompts.
 *
 * Eligibility: >=10 messages OR >=5 min OR >=5 tool uses (matches
 * SessionAnalysisService — no point summarising trivial one-shot sessions).
 *
 * Usage:
 *   npx tsx scripts/backfill-session-summaries.ts                # default: 30 most recent eligible
 *   npx tsx scripts/backfill-session-summaries.ts --limit 50     # custom limit
 *   npx tsx scripts/backfill-session-summaries.ts --force        # regenerate even if summary already exists
 *   npx tsx scripts/backfill-session-summaries.ts --session <id> # single session by id
 *   npx tsx scripts/backfill-session-summaries.ts --dry-run      # show what would run, no LLM calls
 *
 * Idempotent: by default skips sessions that already have a complete summary.
 */

import { ConfigService } from '../src/services/infrastructure/config-service.js';
import { DatabaseProvider } from '../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../src/services/sessions/session-info-service.js';
import { SessionSummaryService, IDLE_GRACE_MIN } from '../src/services/sessions/session-summary-service.js';
import { SqliteEventStorageAdapter } from '../src/harness/sqlite-event-storage.js';
import { initEventMessageReader } from '../src/harness/event-message-reader.js';

// ============================================================================
// CLI
// ============================================================================

const args = process.argv.slice(2);

function getFlag(name: string): boolean {
  return args.includes(`--${name}`);
}
function getValue(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const dryRun = getFlag('dry-run');
const force = getFlag('force');
const limit = Number(getValue('limit') ?? '30');
const singleSessionId = getValue('session');

if (!Number.isFinite(limit) || limit <= 0) {
  console.error(`Invalid --limit: ${getValue('limit')}`);
  process.exit(1);
}

// ============================================================================
// Main
// ============================================================================

interface SessionRow {
  session_id: string;
  custom_name: string;
  updated_at: string;
}

async function main(): Promise<void> {
  // Bootstrap: ConfigService gives the Anthropic factory access to the API key
  // from ~/.lattice/config.json (or ANTHROPIC_API_KEY env var). SessionInfoService
  // ensures the schema (including session_summaries table) is bootstrapped.
  await ConfigService.getInstance().initialize();
  const sessionInfoService = SessionInfoService.getInstance();
  await sessionInfoService.initialize();

  // The summary service reads via readMessages(sessionId), which goes through
  // the harness EventMessageReader singleton. In the live server this is wired
  // up by harness/setup.ts; in a script we have to do it ourselves.
  const db = DatabaseProvider.getInstance().getDb();
  const eventStorage = new SqliteEventStorageAdapter(db);
  initEventMessageReader(eventStorage);

  const summaryService = new SessionSummaryService(sessionInfoService);
  await summaryService.initialize();

  // Pick candidates
  let candidates: SessionRow[];
  if (singleSessionId) {
    const row = db
      .prepare('SELECT session_id, custom_name, updated_at FROM sessions WHERE session_id = ?')
      .get(singleSessionId) as SessionRow | undefined;
    if (!row) {
      console.error(`Session not found: ${singleSessionId}`);
      process.exit(1);
    }
    candidates = [row];
  } else {
    // Pull more than `limit` from the table — eligibility will filter out
    // trivial sessions, so we need a buffer.
    const fetchSize = Math.max(limit * 4, 60);
    // Apply idle grace via MAX(harness_events.timestamp), NOT sessions.updated_at
    // — the latter only bumps on archive ops, so it would frequently let
    // currently-active sessions through. Use --session <id> to bypass when
    // intentional. NB: don't filter by archived — archive is a UI hide, not a
    // delete, and the bulk of past Lattice work lives in archived sessions.
    const idleCutoffMs = Date.now() - IDLE_GRACE_MIN * 60_000;
    candidates = db
      .prepare(`
        WITH last_activity AS (
          SELECT session_id, MAX(timestamp) AS last_ts
          FROM harness_events
          GROUP BY session_id
        )
        SELECT s.session_id, s.custom_name, s.updated_at
        FROM sessions s
        JOIN last_activity la ON la.session_id = s.session_id
        WHERE la.last_ts <= ?
        ORDER BY la.last_ts DESC
        LIMIT ?
      `)
      .all(idleCutoffMs, fetchSize) as SessionRow[];
  }

  console.log(`\nBackfilling session summaries`);
  console.log(`  candidates pulled : ${candidates.length}`);
  console.log(`  limit             : ${limit}`);
  console.log(`  force             : ${force}`);
  console.log(`  dry run           : ${dryRun}`);
  console.log('');

  let summarised = 0;
  let skippedExisting = 0;
  let skippedIneligible = 0;
  let failed = 0;

  for (const row of candidates) {
    if (summarised >= limit && !singleSessionId) break;

    const sid = row.session_id;
    const sidShort = sid.slice(0, 12);
    const label = row.custom_name?.trim() || '(unnamed)';

    // Existing-summary check
    if (!force) {
      const existing = summaryService.getSummary(sid);
      if (existing && existing.status === 'complete') {
        skippedExisting++;
        console.log(`SKIP  ${sidShort}  ${label}  (already summarised)`);
        continue;
      }
    }

    // Eligibility check
    let eligibility;
    try {
      eligibility = summaryService.isEligible(sid);
    } catch (err) {
      console.log(`ERROR ${sidShort}  ${label}  (eligibility check failed: ${(err as Error).message})`);
      failed++;
      continue;
    }
    if (!eligibility.eligible) {
      skippedIneligible++;
      console.log(`SKIP  ${sidShort}  ${label}  (${eligibility.reason})`);
      continue;
    }

    if (dryRun) {
      // Estimate render size to show which sessions will need hierarchical
      // chunking. Imports `readMessages` lazily to avoid pulling harness
      // internals into the main script unless we actually use them here.
      const { readMessages } = await import('../src/harness/event-message-reader.js');
      const msgs = readMessages(sid);
      let approxChars = 0;
      for (const m of msgs) {
        for (const b of m.content) {
          if (b.type === 'text') approxChars += b.text.length;
          else if (b.type === 'tool_use') approxChars += 80;
        }
      }
      const path = approxChars > 500_000
        ? `chunked (~${Math.ceil(approxChars / 150_000)} chunks)`
        : 'single-call';
      console.log(
        `WOULD ${sidShort}  ${label}  (${eligibility.reason}, ~${Math.round(approxChars / 1000)}KB → ${path})`,
      );
      summarised++;
      continue;
    }

    // Generate
    process.stdout.write(`GEN   ${sidShort}  ${label}  ... `);
    const start = Date.now();
    try {
      const summary = await summaryService.generateSummary(sid);
      const ms = Date.now() - start;
      summarised++;
      console.log(
        `done in ${ms}ms  project=${summary.project ?? '?'}  tags=[${summary.tags.join(', ')}]`,
      );
      console.log(`        ${summary.title ?? '(no title)'}`);
    } catch (err) {
      const ms = Date.now() - start;
      failed++;
      console.log(`FAILED in ${ms}ms: ${(err as Error).message}`);
    }
  }

  console.log('');
  console.log(`Summary:`);
  console.log(`  ${summarised} summarised`);
  console.log(`  ${skippedExisting} skipped (already summarised)`);
  console.log(`  ${skippedIneligible} skipped (ineligible)`);
  console.log(`  ${failed} failed`);
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
