#!/usr/bin/env -S npx tsx
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { CONFIG_DIR } from '../src/utils/constants.js';

const CONSOLIDATION_MIGRATION_KEY = 'session_insights_conversation_consolidated_v1';

export type GuardrailCommand = 'dry-run' | 'verify' | 'drift' | 'orphan-segments';

export interface ParsedArgs {
  command: GuardrailCommand;
  dbPath: string;
  json: boolean;
  apply: boolean;
}

export interface MigrationPreviewRow {
  conversationId: string;
  legacyRows: number;
  canonicalRowExists: boolean;
  latestComputedAt: string | null;
}

export interface MigrationDryRunReport {
  dbPath: string;
  migrationApplied: boolean;
  splitInsightsRows: number;
  affectedConversations: number;
  potentialInsertConversations: number;
  potentialMergeConversations: number;
  legacyRowsThatWouldDelete: number;
  preview: MigrationPreviewRow[];
}

export interface InvariantMetrics {
  dbPath: string;
  migrationApplied: boolean;
  mappedSessionCount: number;
  canonicalInsightsRowCount: number;
  splitInsightsRows: number;
  segmentSessionConversationMismatches: number;
  orphanSegmentsTotal: number;
  orphanSegmentsLinkedViaCodexSessions: number;
  orphanSegmentsMissingLinkage: number;
}

export interface InvariantIssue {
  code: string;
  message: string;
  count: number;
}

export interface VerificationReport {
  ok: boolean;
  metrics: InvariantMetrics;
  failures: InvariantIssue[];
  warnings: InvariantIssue[];
}

export interface OrphanSegmentReport {
  dbPath: string;
  orphanSegmentsTotal: number;
  orphanSegmentsLinkedViaCodexSessions: number;
  orphanSegmentsMissingLinkage: number;
  candidateSessionRows: number;
  conflictedCandidates: number;
  insertedSessionRows: number;
  preview: Array<{
    segmentId: string;
    conversationId: string;
    provider: string;
    providerSessionId: string;
    createdAt: string;
    linkedViaCodexSession: boolean;
  }>;
}

function printHelp(): void {
  console.error(`Usage:
  pnpm -s diag:db:migration:dry-run [--json] [--db /path/to/session-info.db]
  pnpm -s diag:db:verify [--json] [--db /path/to/session-info.db]
  pnpm -s diag:db:drift [--json] [--db /path/to/session-info.db]
  pnpm -s diag:db:orphan-segments [--json] [--db /path/to/session-info.db] [--apply]
`);
}

function defaultDbPath(): string {
  return path.join(CONFIG_DIR, 'session-info.db');
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2).filter((token) => token !== '--');
  const commandToken = args[0];
  if (!commandToken || commandToken === '--help' || commandToken === '-h') {
    throw new Error('help');
  }
  if (
    commandToken !== 'dry-run'
    && commandToken !== 'verify'
    && commandToken !== 'drift'
    && commandToken !== 'orphan-segments'
  ) {
    throw new Error(`Unknown command "${commandToken}"`);
  }

  let dbPath = defaultDbPath();
  let json = false;
  let apply = false;

  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--db') {
      const next = args[i + 1];
      if (!next) {
        throw new Error('--db requires a value');
      }
      dbPath = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === '--apply') {
      apply = true;
      continue;
    }
    throw new Error(`Unknown argument "${token}"`);
  }

  if (apply && commandToken !== 'orphan-segments') {
    throw new Error('--apply is only valid for orphan-segments');
  }

  return {
    command: commandToken,
    dbPath,
    json,
    apply,
  };
}

function getNumber(
  db: Database.Database,
  sql: string,
  params: Database.BindParameters = [],
): number {
  const row = db.prepare(sql).get(params) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function isMigrationApplied(db: Database.Database): boolean {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(CONSOLIDATION_MIGRATION_KEY) as
    | { value?: string }
    | undefined;
  return row?.value === 'true';
}

const SPLIT_INSIGHTS_WHERE = `
  FROM session_insights i
  JOIN sessions s ON s.session_id = i.session_id
  WHERE s.conversation_id LIKE 'conv-%'
    AND s.conversation_id IS NOT NULL
    AND i.session_id NOT LIKE 'conv-%'
`;

const ORPHAN_SEGMENTS_WHERE = `
  FROM conversation_segments seg
  LEFT JOIN sessions s ON s.session_id = seg.provider_session_id
  WHERE s.session_id IS NULL
`;

function hasCodexSessionsTable(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name = 'codex_sessions'
  `).get() as { count?: number } | undefined;

  return Number(row?.count ?? 0) > 0;
}

export function collectMigrationDryRun(
  db: Database.Database,
  dbPath: string,
): MigrationDryRunReport {
  const splitInsightsRows = getNumber(
    db,
    `SELECT COUNT(*) AS count ${SPLIT_INSIGHTS_WHERE}`
  );

  const affectedConversations = getNumber(
    db,
    `SELECT COUNT(DISTINCT s.conversation_id) AS count ${SPLIT_INSIGHTS_WHERE}`
  );

  const potentialInsertConversations = getNumber(
    db,
    `
      SELECT COUNT(*) AS count
      FROM (
        SELECT DISTINCT s.conversation_id
        ${SPLIT_INSIGHTS_WHERE}
          AND NOT EXISTS (
            SELECT 1
            FROM session_insights canonical
            WHERE canonical.session_id = s.conversation_id
          )
      )
    `,
  );

  const preview = db.prepare(`
    SELECT
      s.conversation_id AS conversationId,
      COUNT(*) AS legacyRows,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM session_insights canonical
          WHERE canonical.session_id = s.conversation_id
        ) THEN 1
        ELSE 0
      END AS canonicalRowExists,
      MAX(i.computed_at) AS latestComputedAt
    ${SPLIT_INSIGHTS_WHERE}
    GROUP BY s.conversation_id
    ORDER BY legacyRows DESC, conversationId ASC
    LIMIT 20
  `).all() as Array<{
    conversationId: string;
    legacyRows: number;
    canonicalRowExists: 0 | 1;
    latestComputedAt: string | null;
  }>;

  return {
    dbPath,
    migrationApplied: isMigrationApplied(db),
    splitInsightsRows,
    affectedConversations,
    potentialInsertConversations,
    potentialMergeConversations: Math.max(affectedConversations - potentialInsertConversations, 0),
    legacyRowsThatWouldDelete: splitInsightsRows,
    preview: preview.map((row) => ({
      conversationId: row.conversationId,
      legacyRows: Number(row.legacyRows || 0),
      canonicalRowExists: row.canonicalRowExists === 1,
      latestComputedAt: row.latestComputedAt,
    })),
  };
}

export function collectInvariantMetrics(
  db: Database.Database,
  dbPath: string,
): InvariantMetrics {
  const codexSessionsTableExists = hasCodexSessionsTable(db);
  const codexLinkedClause = codexSessionsTableExists
    ? `seg.provider = 'codex' AND EXISTS (
         SELECT 1
         FROM codex_sessions cs
         WHERE cs.thread_id = seg.provider_session_id
       )`
    : '0';

  return {
    dbPath,
    migrationApplied: isMigrationApplied(db),
    mappedSessionCount: getNumber(
      db,
      "SELECT COUNT(*) AS count FROM sessions WHERE conversation_id LIKE 'conv-%' AND conversation_id IS NOT NULL",
    ),
    canonicalInsightsRowCount: getNumber(
      db,
      "SELECT COUNT(*) AS count FROM session_insights WHERE session_id LIKE 'conv-%'",
    ),
    splitInsightsRows: getNumber(
      db,
      `SELECT COUNT(*) AS count ${SPLIT_INSIGHTS_WHERE}`,
    ),
    segmentSessionConversationMismatches: getNumber(
      db,
      `
        SELECT COUNT(*) AS count
        FROM conversation_segments seg
        JOIN sessions s ON s.session_id = seg.provider_session_id
        WHERE s.conversation_id IS NOT NULL
          AND s.conversation_id != seg.conversation_id
      `,
    ),
    orphanSegmentsTotal: getNumber(
      db,
      `SELECT COUNT(*) AS count ${ORPHAN_SEGMENTS_WHERE}`,
    ),
    orphanSegmentsLinkedViaCodexSessions: getNumber(
      db,
      `
        SELECT COUNT(*) AS count
        ${ORPHAN_SEGMENTS_WHERE}
          AND (${codexLinkedClause})
      `,
    ),
    orphanSegmentsMissingLinkage: getNumber(
      db,
      `
        SELECT COUNT(*) AS count
        ${ORPHAN_SEGMENTS_WHERE}
          AND NOT (${codexLinkedClause})
      `,
    ),
  };
}

export function verifyInvariants(metrics: InvariantMetrics): VerificationReport {
  const failures: InvariantIssue[] = [];
  const warnings: InvariantIssue[] = [];

  if (metrics.splitInsightsRows > 0) {
    failures.push({
      code: 'split_insights_rows',
      message: 'Found provider-keyed session_insights rows for sessions already mapped to canonical conv-* IDs.',
      count: metrics.splitInsightsRows,
    });
  }

  if (metrics.segmentSessionConversationMismatches > 0) {
    failures.push({
      code: 'segment_session_conversation_mismatch',
      message: 'Found conversation_segments rows where provider session mapping disagrees with sessions.conversation_id.',
      count: metrics.segmentSessionConversationMismatches,
    });
  }

  if (!metrics.migrationApplied && metrics.mappedSessionCount > 0) {
    warnings.push({
      code: 'migration_state_not_marked',
      message: `Metadata key ${CONSOLIDATION_MIGRATION_KEY} is not marked true.`,
      count: 1,
    });
  }

  if (metrics.orphanSegmentsMissingLinkage > 0) {
    warnings.push({
      code: 'orphan_segments_missing_linkage',
      message: 'Found orphan conversation_segments rows that are not linked via codex_sessions and need reconciliation.',
      count: metrics.orphanSegmentsMissingLinkage,
    });
  }

  return {
    ok: failures.length === 0,
    metrics,
    failures,
    warnings,
  };
}

export function collectOrphanSegmentsReport(
  db: Database.Database,
  dbPath: string,
  options: { apply: boolean },
): OrphanSegmentReport {
  const codexSessionsTableExists = hasCodexSessionsTable(db);
  const codexLinkedClause = codexSessionsTableExists
    ? `seg.provider = 'codex' AND EXISTS (
         SELECT 1
         FROM codex_sessions cs
         WHERE cs.thread_id = seg.provider_session_id
       )`
    : '0';

  const orphanSegmentsTotal = getNumber(db, `SELECT COUNT(*) AS count ${ORPHAN_SEGMENTS_WHERE}`);
  const orphanSegmentsLinkedViaCodexSessions = getNumber(
    db,
    `
      SELECT COUNT(*) AS count
      ${ORPHAN_SEGMENTS_WHERE}
        AND (${codexLinkedClause})
    `,
  );
  const orphanSegmentsMissingLinkage = getNumber(
    db,
    `
      SELECT COUNT(*) AS count
      ${ORPHAN_SEGMENTS_WHERE}
        AND NOT (${codexLinkedClause})
    `,
  );

  const preview = db.prepare(`
    SELECT
      seg.segment_id AS segmentId,
      seg.conversation_id AS conversationId,
      seg.provider AS provider,
      seg.provider_session_id AS providerSessionId,
      seg.created_at AS createdAt,
      CASE
        WHEN (${codexLinkedClause}) THEN 1
        ELSE 0
      END AS linkedViaCodexSession
    ${ORPHAN_SEGMENTS_WHERE}
    ORDER BY seg.created_at DESC
    LIMIT 20
  `).all() as Array<{
    segmentId: string;
    conversationId: string;
    provider: string;
    providerSessionId: string;
    createdAt: string;
    linkedViaCodexSession: 0 | 1;
  }>;

  const candidates = db.prepare(`
    SELECT
      seg.provider_session_id AS providerSessionId,
      MIN(seg.created_at) AS createdAt,
      MAX(seg.created_at) AS updatedAt,
      MIN(seg.conversation_id) AS conversationId,
      COUNT(DISTINCT seg.conversation_id) AS conversationCount
    ${ORPHAN_SEGMENTS_WHERE}
      AND NOT (${codexLinkedClause})
    GROUP BY seg.provider_session_id
  `).all() as Array<{
    providerSessionId: string;
    createdAt: string | null;
    updatedAt: string | null;
    conversationId: string;
    conversationCount: number;
  }>;

  const insertableCandidates = candidates.filter((candidate) => Number(candidate.conversationCount) === 1);
  const conflictedCandidates = candidates.length - insertableCandidates.length;

  let insertedSessionRows = 0;
  if (options.apply && insertableCandidates.length > 0) {
    const now = new Date().toISOString();
    const upsertStmt = db.prepare(`
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
        workspace,
        conversation_id
      ) VALUES (
        @sessionId,
        '',
        @createdAt,
        @updatedAt,
        1,
        0,
        0,
        '',
        '',
        'default',
        'main',
        @conversationId
      )
      ON CONFLICT(session_id) DO NOTHING
    `);

    const tx = db.transaction(() => {
      let changes = 0;
      for (const candidate of insertableCandidates) {
        const result = upsertStmt.run({
          sessionId: candidate.providerSessionId,
          createdAt: candidate.createdAt ?? now,
          updatedAt: candidate.updatedAt ?? candidate.createdAt ?? now,
          conversationId: candidate.conversationId,
        });
        changes += result.changes;
      }
      return changes;
    });

    insertedSessionRows = tx();
  }

  return {
    dbPath,
    orphanSegmentsTotal,
    orphanSegmentsLinkedViaCodexSessions,
    orphanSegmentsMissingLinkage,
    candidateSessionRows: insertableCandidates.length,
    conflictedCandidates,
    insertedSessionRows,
    preview: preview.map((row) => ({
      segmentId: row.segmentId,
      conversationId: row.conversationId,
      provider: row.provider,
      providerSessionId: row.providerSessionId,
      createdAt: row.createdAt,
      linkedViaCodexSession: row.linkedViaCodexSession === 1,
    })),
  };
}

function printDryRunText(report: MigrationDryRunReport): void {
  console.log('[db-guardrails] migration dry-run');
  console.log(`db: ${report.dbPath}`);
  console.log(`migrationApplied: ${report.migrationApplied}`);
  console.log(`splitInsightsRows: ${report.splitInsightsRows}`);
  console.log(`affectedConversations: ${report.affectedConversations}`);
  console.log(`potentialInsertConversations: ${report.potentialInsertConversations}`);
  console.log(`potentialMergeConversations: ${report.potentialMergeConversations}`);
  console.log(`legacyRowsThatWouldDelete: ${report.legacyRowsThatWouldDelete}`);
  if (report.preview.length > 0) {
    console.log('preview:');
    for (const row of report.preview) {
      console.log(
        `  - ${row.conversationId} legacyRows=${row.legacyRows} canonicalRowExists=${row.canonicalRowExists} latestComputedAt=${row.latestComputedAt ?? 'n/a'}`
      );
    }
  }
}

function printVerificationText(report: VerificationReport): void {
  console.log(`[db-guardrails] invariants ${report.ok ? 'PASS' : 'FAIL'}`);
  console.log(`db: ${report.metrics.dbPath}`);
  console.log(`migrationApplied: ${report.metrics.migrationApplied}`);
  console.log(`mappedSessionCount: ${report.metrics.mappedSessionCount}`);
  console.log(`canonicalInsightsRowCount: ${report.metrics.canonicalInsightsRowCount}`);
  console.log(`splitInsightsRows: ${report.metrics.splitInsightsRows}`);
  console.log(`segmentSessionConversationMismatches: ${report.metrics.segmentSessionConversationMismatches}`);
  console.log(`orphanSegmentsTotal: ${report.metrics.orphanSegmentsTotal}`);
  console.log(`orphanSegmentsLinkedViaCodexSessions: ${report.metrics.orphanSegmentsLinkedViaCodexSessions}`);
  console.log(`orphanSegmentsMissingLinkage: ${report.metrics.orphanSegmentsMissingLinkage}`);

  if (report.failures.length > 0) {
    console.log('failures:');
    for (const failure of report.failures) {
      console.log(`  - ${failure.code} count=${failure.count} :: ${failure.message}`);
    }
  }

  if (report.warnings.length > 0) {
    console.log('warnings:');
    for (const warning of report.warnings) {
      console.log(`  - ${warning.code} count=${warning.count} :: ${warning.message}`);
    }
  }
}

function printOrphanSegmentsText(report: OrphanSegmentReport, apply: boolean): void {
  console.log(`[db-guardrails] orphan-segments ${apply ? 'APPLY' : 'AUDIT'}`);
  console.log(`db: ${report.dbPath}`);
  console.log(`orphanSegmentsTotal: ${report.orphanSegmentsTotal}`);
  console.log(`orphanSegmentsLinkedViaCodexSessions: ${report.orphanSegmentsLinkedViaCodexSessions}`);
  console.log(`orphanSegmentsMissingLinkage: ${report.orphanSegmentsMissingLinkage}`);
  console.log(`candidateSessionRows: ${report.candidateSessionRows}`);
  console.log(`conflictedCandidates: ${report.conflictedCandidates}`);
  console.log(`insertedSessionRows: ${report.insertedSessionRows}`);

  if (report.preview.length > 0) {
    console.log('preview:');
    for (const row of report.preview) {
      console.log(
        `  - ${row.segmentId} conv=${row.conversationId} provider=${row.provider} providerSessionId=${row.providerSessionId} codexLinked=${row.linkedViaCodexSession}`
      );
    }
  }
}

export function runCommand(args: ParsedArgs): number {
  if (!fs.existsSync(args.dbPath)) {
    throw new Error(`Database not found at ${args.dbPath}`);
  }

  const readonly = !(args.command === 'orphan-segments' && args.apply);
  const db = new Database(args.dbPath, { readonly });
  try {
    if (args.command === 'dry-run') {
      const report = collectMigrationDryRun(db, args.dbPath);
      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printDryRunText(report);
      }
      return 0;
    }

    if (args.command === 'drift') {
      const metrics = collectInvariantMetrics(db, args.dbPath);
      const report = verifyInvariants(metrics);
      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printVerificationText(report);
      }
      return 0;
    }

    if (args.command === 'orphan-segments') {
      const report = collectOrphanSegmentsReport(db, args.dbPath, { apply: args.apply });
      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printOrphanSegmentsText(report, args.apply);
      }
      return 0;
    }

    const metrics = collectInvariantMetrics(db, args.dbPath);
    const report = verifyInvariants(metrics);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printVerificationText(report);
    }
    return report.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

function isMain(): boolean {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    const parsed = parseArgs(process.argv);
    process.exitCode = runCommand(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'help') {
      printHelp();
      process.exitCode = 2;
    } else {
      console.error(`[db-guardrails] ${message}`);
      printHelp();
      process.exitCode = 1;
    }
  }
}
