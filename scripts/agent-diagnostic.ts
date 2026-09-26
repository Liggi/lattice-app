#!/usr/bin/env -S npx tsx
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from '../src/utils/constants.js';

const execFile = promisify(execFileCb);

export type PatternSeverity = 'critical' | 'warning' | 'info';
export type AssessmentStatus = 'healthy' | 'degraded' | 'broken';

export interface LogPattern {
  key: string;
  severity: PatternSeverity;
  include: RegExp;
  exclude?: RegExp[];
}

export interface PatternMatchSummary {
  key: string;
  severity: PatternSeverity;
  count: number;
  latest: string[];
  recentCount?: number;
  recentWindowLines?: number;
  lastSeenLinesAgo?: number;
}

export interface ParsedArgs {
  command: 'snapshot' | 'session';
  sessionId?: string;
  baseUrl: string;
  tailLines: number;
  analysisLines: number;
  timeoutMs: number;
}

export interface DiagnosisItem {
  id: string;
  severity: PatternSeverity;
  confidence: number;
  title: string;
  evidence: string[];
}

export interface DiagnosticAssessment {
  status: AssessmentStatus;
  confidence: number;
  likelyRootCauses: DiagnosisItem[];
  nextProbeCommands: string[];
}

const LOG_ROOT = path.join(CONFIG_DIR, 'logs');
/** systemd unit prefix, as scripts/service-names.sh derives it. */
const SERVICE_PREFIX = path.basename(CONFIG_DIR).replace(/^\./, '');
const SERVER_JSONL_LOG = path.join(LOG_ROOT, 'server.jsonl');
const DAEMON_JSONL_LOG = path.join(LOG_ROOT, 'daemon.jsonl');
const EVENT_JOURNAL = path.join(LOG_ROOT, 'events.jsonl');
const ANSI_REGEX = /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;

const TOOL_CANDIDATES: ReadonlyArray<{
  command: string;
  purpose: string;
  docs: string;
}> = [
  {
    command: 'lnav',
    purpose: 'query large logs with SQL and timeline views',
    docs: 'https://docs.lnav.org/en/latest/',
  },
  {
    command: 'vector',
    purpose: 'stream/route logs, metrics, and traces from one pipeline',
    docs: 'https://vector.dev/docs/',
  },
  {
    command: 'otelcol',
    purpose: 'OpenTelemetry collector for unified traces/metrics/logs',
    docs: 'https://opentelemetry.io/docs/collector/',
  },
  {
    command: 'jq',
    purpose: 'shape and filter JSON payloads from debug endpoints',
    docs: 'https://jqlang.org/manual/',
  },
];

export const DEFAULT_LOG_PATTERNS: ReadonlyArray<LogPattern> = [
  {
    key: 'unhandled_error',
    severity: 'critical',
    include: /\[ErrorHandler\].*Unhandled error/i,
  },
  {
    key: 'process_crash',
    severity: 'critical',
    include: /(CLAUDE_PROCESS_EXITED_EARLY|process exited early|process-error|exit code [1-9]\d*)/i,
    exclude: [/\(INTERRUPTED\)|turn \d+/i],
  },
  {
    key: 'timeout',
    severity: 'warning',
    // Match real timeout/error signals while avoiding benign telemetry fields
    // like `timeoutMs` in slow-request reports.
    include: /(ETIMEDOUT|timed out|\btimeout\b|request aborted)/i,
  },
  {
    key: 'connection_reset',
    severity: 'warning',
    include: /(ECONNRESET|socket hang up|connection reset)/i,
  },
  {
    key: 'conversation_not_found',
    severity: 'info',
    include: /CONVERSATION_NOT_FOUND/i,
  },
  {
    key: 'session_not_ready',
    severity: 'info',
    include: /(SESSION_NOT_READY|not ready for insights computation)/i,
  },
  {
    key: 'insights_failures',
    severity: 'warning',
    include: /(Failed to (compute|generate|handle) insights|\[BACKGROUND REGEN\] Failed|Failed to process session update)/i,
  },
  {
    key: 'credits_exhausted',
    severity: 'warning',
    include: /(ANTHROPIC_NO_CREDITS|credits exhausted)/i,
  },
];

// ==========================================================================
// Daemon process lifecycle parsing
// ==========================================================================

export interface DaemonProcessEvent {
  timestamp: string;
  type: 'spawn' | 'init' | 'sigterm' | 'close';
  streamingId: string;
  pid?: number;
  exitCode?: number;
  sessionId?: string;
  model?: string;
}

/**
 * Parse daemon log lines for process lifecycle events related to a specific session.
 * Matches by session ID directly and by streaming IDs associated with that session.
 */
export function parseDaemonProcessEvents(
  daemonLines: string[],
  sessionIdOrPrefix: string,
): DaemonProcessEvent[] {
  const events: DaemonProcessEvent[] = [];
  // First pass: find all streaming IDs associated with this session
  const sessionStreamingIds = new Set<string>();

  for (const line of daemonLines) {
    // Process closed lines include sessionId — extract streamingId from them.
    // We intentionally use includes() on the full line so callers can pass either
    // a full session id or an 8-char prefix.
    if (!line.includes('Process closed') || !line.includes(sessionIdOrPrefix)) continue;
    const closeMatch = line.match(/"streamingId":"([^"]+)"/);
    if (closeMatch?.[1]) {
      sessionStreamingIds.add(closeMatch[1]);
      sessionStreamingIds.add(closeMatch[1].slice(0, 8));
    }
  }

  // Second pass: collect all lifecycle events for those streaming IDs
  for (const line of daemonLines) {
    const ts = extractTimestamp(line);
    if (!ts) continue;

    // Check if line references any known streaming ID or the session ID directly
    const isRelevant = line.includes(sessionIdOrPrefix)
      || [...sessionStreamingIds].some(sid => line.includes(sid));
    if (!isRelevant) continue;

    const sidMatch = line.match(/"streamingId":"([^"]+)"/);
    const streamingId = sidMatch ? sidMatch[1].slice(0, 8) : '?';

    if (line.includes('Spawning conversation') || line.includes('Process spawned')) {
      const pidMatch = line.match(/"pid":(\d+)/);
      events.push({
        timestamp: ts,
        type: 'spawn',
        streamingId,
        pid: pidMatch ? Number(pidMatch[1]) : undefined,
      });
    } else if (line.includes('System init')) {
      const modelMatch = line.match(/"model":"([^"]+)"/);
      events.push({
        timestamp: ts,
        type: 'init',
        streamingId,
        model: modelMatch ? modelMatch[1] : undefined,
      });
    } else if (line.includes('Sending SIGTERM')) {
      const pidMatch = line.match(/"pid":(\d+)/);
      events.push({
        timestamp: ts,
        type: 'sigterm',
        streamingId,
        pid: pidMatch ? Number(pidMatch[1]) : undefined,
      });
    } else if (line.includes('Process closed')) {
      const codeMatch = line.match(/"code":(\d+)/);
      const sessMatch = line.match(/"sessionId":"([^"]+)"/);
      const pidMatch = line.match(/"pid":(\d+)/);
      events.push({
        timestamp: ts,
        type: 'close',
        streamingId,
        exitCode: codeMatch ? Number(codeMatch[1]) : undefined,
        sessionId: sessMatch ? sessMatch[1].slice(0, 8) : undefined,
        pid: pidMatch ? Number(pidMatch[1]) : undefined,
      });
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}

function extractTimestamp(line: string): string | null {
  // ISO format: [2026-02-14T15:00:43.162Z]
  const isoMatch = line.match(/\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\]?/);
  if (isoMatch) return isoMatch[1];
  // Time-only format: 03:00:43 PM
  const timeMatch = line.match(/(\d{2}:\d{2}:\d{2}\s+[AP]M)/);
  if (timeMatch) return timeMatch[1];
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

export function normalizeTokenList(tokens: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const token of tokens) {
    const value = token?.trim();
    if (!value || value.length < 4) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeLogLine(line: string): string {
  return stripAnsi(line).replace(/\s+/g, ' ').trim();
}

export function analyzeLogLines(
  lines: string[],
  patterns: ReadonlyArray<LogPattern> = DEFAULT_LOG_PATTERNS,
  maxLatest = 6,
  recentWindowLines = 120
): PatternMatchSummary[] {
  const normalizedLines = lines.map(normalizeLogLine).filter(Boolean);
  const normalizedRecentWindowLines = Math.max(1, Math.min(recentWindowLines, normalizedLines.length || 1));
  const recentStartIndex = Math.max(0, normalizedLines.length - normalizedRecentWindowLines);

  return patterns.map((pattern) => {
    const matches: string[] = [];
    let recentCount = 0;
    let lastSeenIndex = -1;

    for (let index = 0; index < normalizedLines.length; index += 1) {
      const line = normalizedLines[index];
      if (!pattern.include.test(line)) continue;
      if (pattern.exclude && pattern.exclude.some((excludePattern) => excludePattern.test(line))) continue;
      matches.push(line);
      lastSeenIndex = index;
      if (index >= recentStartIndex) {
        recentCount += 1;
      }
    }

    return {
      key: pattern.key,
      severity: pattern.severity,
      count: matches.length,
      latest: matches.slice(-maxLatest),
      recentCount,
      recentWindowLines: normalizedRecentWindowLines,
      lastSeenLinesAgo: lastSeenIndex === -1 ? undefined : Math.max(0, normalizedLines.length - 1 - lastSeenIndex),
    };
  });
}

export function collectTokenHits(
  lines: string[],
  tokens: string[],
  maxPerToken = 20
): Record<string, string[]> {
  const normalizedLines = lines.map(normalizeLogLine).filter(Boolean);
  const result: Record<string, string[]> = {};
  for (const token of normalizeTokenList(tokens)) {
    const hits = normalizedLines.filter((line) => line.includes(token)).slice(-maxPerToken);
    if (hits.length > 0) {
      result[token] = hits;
    }
  }
  return result;
}

function getPatternCount(matches: PatternMatchSummary[], key: string): number {
  return matches.find((entry) => entry.key === key)?.count ?? 0;
}

function getPatternSummary(matches: PatternMatchSummary[], key: string): PatternMatchSummary | null {
  return matches.find((entry) => entry.key === key) ?? null;
}

function addCause(
  causes: DiagnosisItem[],
  params: {
    id: string;
    severity: PatternSeverity;
    title: string;
    confidence: number;
    evidence: string[];
  }
): void {
  causes.push({
    id: params.id,
    severity: params.severity,
    title: params.title,
    confidence: clamp(params.confidence, 0.05, 0.99),
    evidence: params.evidence.slice(0, 8),
  });
}

function summarizeStatus(causes: DiagnosisItem[]): DiagnosticAssessment {
  if (causes.length === 0) {
    return {
      status: 'healthy',
      confidence: 0.95,
      likelyRootCauses: [],
      nextProbeCommands: [],
    };
  }

  const critical = causes.filter((cause) => cause.severity === 'critical');
  const weightedConfidence = causes.reduce((sum, cause) => sum + cause.confidence, 0) / causes.length;

  const status: AssessmentStatus = critical.length > 0 ? 'broken' : 'degraded';
  return {
    status,
    confidence: clamp(weightedConfidence, 0.4, 0.99),
    likelyRootCauses: causes,
    nextProbeCommands: [],
  };
}

export function buildSnapshotAssessment(params: {
  services: {
    latticeServerState: string;
    latticeDaemonState: string;
  };
  api: {
    rootHealthOk: boolean;
    activeSessionsOk: boolean;
    stateReconciliationOk: boolean;
    stateReconciliationDivergenceCount: number | null;
    conversationIntegrityOk: boolean;
    conversationIntegritySummary: {
      canonicalEmptyButSegmentsHaveMessages: number | null;
      segmentsWrongConversationLink: number | null;
      segmentsMissingSessionInfo: number | null;
    };
  };
  serverPatternMatches: PatternMatchSummary[];
}): DiagnosticAssessment {
  const causes: DiagnosisItem[] = [];

  if (params.services.latticeServerState !== 'active') {
    addCause(causes, {
      id: 'server_inactive',
      severity: 'critical',
      confidence: 0.97,
      title: 'lattice-server is not active',
      evidence: [`systemd reported state: ${params.services.latticeServerState}`],
    });
  }

  if (params.services.latticeDaemonState !== 'active') {
    addCause(causes, {
      id: 'daemon_inactive',
      severity: 'critical',
      confidence: 0.94,
      title: 'lattice-daemon is not active',
      evidence: [`systemd reported state: ${params.services.latticeDaemonState}`],
    });
  }

  if (!params.api.rootHealthOk) {
    addCause(causes, {
      id: 'api_unhealthy',
      severity: 'critical',
      confidence: 0.9,
      title: 'root health endpoint failed',
      evidence: ['GET /health returned non-ok response'],
    });
  }

  if (!params.api.activeSessionsOk) {
    addCause(causes, {
      id: 'active_sessions_probe_failed',
      severity: 'warning',
      confidence: 0.72,
      title: 'active sessions debug endpoint failed',
      evidence: ['GET /api/debug/active-sessions returned non-ok response'],
    });
  }

  if (!params.api.stateReconciliationOk) {
    addCause(causes, {
      id: 'state_reconciliation_probe_failed',
      severity: 'warning',
      confidence: 0.7,
      title: 'state reconciliation debug endpoint failed',
      evidence: ['GET /api/debug/state-reconciliation returned non-ok response'],
    });
  }

  if ((params.api.stateReconciliationDivergenceCount ?? 0) > 0) {
    addCause(causes, {
      id: 'state_reconciliation_divergences',
      severity: 'warning',
      confidence: clamp(0.6 + Math.min(params.api.stateReconciliationDivergenceCount ?? 0, 10) * 0.03, 0.6, 0.9),
      title: 'active state diverges across status manager / daemon / Codex DB',
      evidence: [
        `divergenceCount: ${params.api.stateReconciliationDivergenceCount}`,
        'Inspect /api/debug/state-reconciliation for specific mismatches',
      ],
    });
  }

  if (!params.api.conversationIntegrityOk) {
    addCause(causes, {
      id: 'conversation_integrity_probe_failed',
      severity: 'warning',
      confidence: 0.68,
      title: 'conversation integrity debug endpoint failed',
      evidence: ['GET /api/debug/conversation-integrity returned non-ok response'],
    });
  }

  const integrityAnomalyCount =
    (params.api.conversationIntegritySummary.canonicalEmptyButSegmentsHaveMessages ?? 0)
    + (params.api.conversationIntegritySummary.segmentsWrongConversationLink ?? 0)
    + (params.api.conversationIntegritySummary.segmentsMissingSessionInfo ?? 0);

  if (integrityAnomalyCount > 0) {
    addCause(causes, {
      id: 'conversation_integrity_anomalies',
      severity: 'warning',
      confidence: clamp(0.62 + Math.min(integrityAnomalyCount, 15) * 0.02, 0.62, 0.9),
      title: 'conversation integrity scan found persistence/linkage anomalies',
      evidence: [
        `canonicalEmptyButSegmentsHaveMessages: ${params.api.conversationIntegritySummary.canonicalEmptyButSegmentsHaveMessages ?? 0}`,
        `segmentsWrongConversationLink: ${params.api.conversationIntegritySummary.segmentsWrongConversationLink ?? 0}`,
        `segmentsMissingSessionInfo: ${params.api.conversationIntegritySummary.segmentsMissingSessionInfo ?? 0}`,
      ],
    });
  }

  const unhandledErrors = getPatternCount(params.serverPatternMatches, 'unhandled_error');
  const processCrashes = getPatternCount(params.serverPatternMatches, 'process_crash');
  const insightFailures = getPatternCount(params.serverPatternMatches, 'insights_failures');
  const timeoutSummary = getPatternSummary(params.serverPatternMatches, 'timeout');
  const timeouts = timeoutSummary?.count ?? 0;
  const recentTimeouts = timeoutSummary?.recentCount ?? timeouts;
  const timeoutRecentWindowLines = timeoutSummary?.recentWindowLines ?? 120;

  if (processCrashes > 0) {
    addCause(causes, {
      id: 'process_crash_signals',
      severity: 'critical',
      confidence: clamp(0.7 + Math.min(processCrashes, 5) * 0.04, 0.7, 0.92),
      title: 'process crash signals detected in recent server logs',
      evidence: [`process_crash matches: ${processCrashes}`],
    });
  }

  if (unhandledErrors > 0) {
    addCause(causes, {
      id: 'unhandled_server_errors',
      severity: 'warning',
      confidence: clamp(0.58 + Math.min(unhandledErrors, 8) * 0.035, 0.58, 0.86),
      title: 'unhandled server errors detected in recent server logs',
      evidence: [`unhandled_error matches: ${unhandledErrors}`],
    });
  }

  if (insightFailures >= 3) {
    addCause(causes, {
      id: 'insights_failure_burst',
      severity: 'warning',
      confidence: clamp(0.55 + Math.min(insightFailures, 10) * 0.03, 0.55, 0.85),
      title: 'insights failures appear elevated in recent logs',
      evidence: [`insights_failures matches: ${insightFailures}`],
    });
  }

  // Require elevated timeout signals in the most recent slice to avoid stale-log false positives.
  if (recentTimeouts >= 6 || (timeouts >= 15 && recentTimeouts >= 3)) {
    addCause(causes, {
      id: 'request_timeout_burst',
      severity: 'warning',
      confidence: clamp(0.5 + Math.min(recentTimeouts, 30) * 0.015, 0.5, 0.82),
      title: 'timeout-related log signals are elevated',
      evidence: [
        `timeout matches (window): ${timeouts}`,
        `timeout matches (last ${timeoutRecentWindowLines} lines): ${recentTimeouts}`,
      ],
    });
  }

  const base = summarizeStatus(causes);
  const probeCommands = dedupeStrings([
    'pnpm service:status',
    `tail -n 200 ${SERVER_JSONL_LOG}`,
    `tail -n 200 ${DAEMON_JSONL_LOG}`,
    `tail -n 100 ${EVENT_JOURNAL} | jq -c 'select(.severity=="warn" or .severity=="error")'`,
    base.status !== 'healthy' ? 'pnpm -s diag:agent > /tmp/lattice-diag.json' : '',
    processCrashes > 0 || unhandledErrors > 0 ? 'curl -s "http://127.0.0.1:3001/api/debug/active-sessions" | jq .' : '',
    (params.api.stateReconciliationDivergenceCount ?? 0) > 0
      ? 'curl -s "http://127.0.0.1:3001/api/debug/state-reconciliation" | jq .summary,.divergences'
      : '',
    integrityAnomalyCount > 0
      ? 'curl -s "http://127.0.0.1:3001/api/debug/conversation-integrity?limit=50&offset=0" | jq .summary,.anomalies.canonicalEmptyButSegmentsHaveMessages[:5]'
      : '',
  ]);

  return {
    ...base,
    nextProbeCommands: probeCommands,
  };
}

function parseBackendSessionDiagnosis(diagnosticData: unknown): DiagnosisItem[] {
  if (!isRecord(diagnosticData)) return [];
  const diagnosis = diagnosticData.diagnosis;
  if (!Array.isArray(diagnosis)) return [];

  const causes: DiagnosisItem[] = [];
  for (const entry of diagnosis) {
    if (!isRecord(entry)) continue;
    const message = typeof entry.message === 'string' ? entry.message : null;
    const level = typeof entry.level === 'string' ? entry.level : 'info';
    if (!message) continue;

    const severity: PatternSeverity = level === 'warning'
      ? 'warning'
      : level === 'error' || level === 'critical'
        ? 'critical'
        : 'info';

    addCause(causes, {
      id: `backend_${causes.length + 1}`,
      severity,
      confidence: severity === 'critical' ? 0.86 : severity === 'warning' ? 0.74 : 0.62,
      title: message,
      evidence: ['reported by /api/debug/sessions/:id/diagnostic'],
    });
  }

  return causes;
}

export function buildSessionAssessment(params: {
  requestedSessionId: string;
  resolvedSessionId: string;
  diagnosticOk: boolean;
  diagnosticData?: unknown;
  eventsOk: boolean;
  eventsData?: unknown;
  stateReconciliationRelevantDivergenceCount?: number | null;
  stateReconciliationRelevantKeys?: string[];
  switchHistoryOk?: boolean;
  switchHistoryData?: unknown;
  messageLinkageOk?: boolean;
  messageLinkageData?: unknown;
  traceIds: string[];
  tokenHitCount: number;
  daemonProcessEvents?: DaemonProcessEvent[];
}): DiagnosticAssessment {
  const causes: DiagnosisItem[] = [];
  let suggestRepair = false;

  if (!params.diagnosticOk) {
    addCause(causes, {
      id: 'session_diagnostic_unavailable',
      severity: 'critical',
      confidence: 0.9,
      title: 'session diagnostic endpoint failed',
      evidence: [`GET /api/debug/sessions/${params.resolvedSessionId}/diagnostic returned non-ok response`],
    });
  }

  causes.push(...parseBackendSessionDiagnosis(params.diagnosticData));

  if (!params.eventsOk) {
    addCause(causes, {
      id: 'session_events_unavailable',
      severity: 'warning',
      confidence: 0.78,
      title: 'session events endpoint failed',
      evidence: [`GET /api/debug/sessions/${params.resolvedSessionId}/events returned non-ok response`],
    });
  }

  const relevantStateDivergences = params.stateReconciliationRelevantDivergenceCount ?? 0;
  if (relevantStateDivergences > 0) {
    addCause(causes, {
      id: 'state_reconciliation_session_divergences',
      severity: 'warning',
      confidence: clamp(0.72 + Math.min(relevantStateDivergences, 8) * 0.03, 0.72, 0.9),
      title: 'active-state divergence detected for this session/conversation',
      evidence: [
        `relevantDivergenceCount: ${relevantStateDivergences}`,
        ...(params.stateReconciliationRelevantKeys && params.stateReconciliationRelevantKeys.length > 0
          ? [`keys: ${params.stateReconciliationRelevantKeys.join(', ')}`]
          : []),
      ],
    });
  }

  if (params.switchHistoryOk === false) {
    addCause(causes, {
      id: 'switch_history_unavailable',
      severity: 'warning',
      confidence: 0.76,
      title: 'switch-history debug endpoint failed',
      evidence: [`GET /api/debug/conversations/${params.resolvedSessionId}/switch-history returned non-ok response`],
    });
  }

  if (isRecord(params.switchHistoryData) && isRecord(params.switchHistoryData.anomalies)) {
    const anomalies = params.switchHistoryData.anomalies;
    const multipleActiveSegments = anomalies.multipleActiveSegments === true;
    const duplicateSequenceNumbers = anomalies.duplicateSequenceNumbers === true;
    const latestSegmentMismatch = anomalies.latestSegmentMismatch === true;

    const providerSwitchesMissingSegments = Array.isArray(anomalies.providerSwitchesMissingSegments)
      ? anomalies.providerSwitchesMissingSegments.length
      : 0;

    if (multipleActiveSegments) {
      addCause(causes, {
        id: 'multiple_active_segments',
        severity: 'warning',
        confidence: 0.86,
        title: 'conversation has multiple active segments (provider switch state likely corrupted)',
        evidence: ['switch-history.anomalies.multipleActiveSegments=true'],
      });
    }

    if (duplicateSequenceNumbers) {
      addCause(causes, {
        id: 'duplicate_segment_sequence_numbers',
        severity: 'warning',
        confidence: 0.8,
        title: 'conversation has duplicate segment sequence numbers',
        evidence: ['switch-history.anomalies.duplicateSequenceNumbers=true'],
      });
    }

    if (latestSegmentMismatch) {
      addCause(causes, {
        id: 'latest_segment_mismatch',
        severity: 'info',
        confidence: 0.72,
        title: 'conversation latestSegmentId does not match expected latest segment by sequence number',
        evidence: ['switch-history.anomalies.latestSegmentMismatch=true'],
      });
    }

    if (providerSwitchesMissingSegments > 0) {
      addCause(causes, {
        id: 'provider_switch_missing_segment',
        severity: 'warning',
        confidence: clamp(0.7 + Math.min(providerSwitchesMissingSegments, 5) * 0.05, 0.7, 0.9),
        title: 'provider switch events reference missing segments',
        evidence: [`providerSwitchesMissingSegments: ${providerSwitchesMissingSegments}`],
      });
    }
  }

  if (params.messageLinkageOk === false) {
    addCause(causes, {
      id: 'message_linkage_unavailable',
      severity: 'warning',
      confidence: 0.78,
      title: 'message linkage debug endpoint failed',
      evidence: [`GET /api/debug/conversations/${params.resolvedSessionId}/message-linkage returned non-ok response`],
    });
  }

  if (isRecord(params.messageLinkageData) && isRecord(params.messageLinkageData.anomalies)) {
    const anomalies = params.messageLinkageData.anomalies;
    const canonicalEmptyButSegmentsHave = anomalies.canonicalEmptyButSegmentsHaveMessages === true;

    if (canonicalEmptyButSegmentsHave) {
      suggestRepair = true;
      addCause(causes, {
        id: 'messages_under_legacy_store_key',
        severity: 'warning',
        confidence: 0.85,
        title: 'canonical conv-* message store is empty but legacy segment store keys contain messages',
        evidence: [
          'message-linkage.anomalies.canonicalEmptyButSegmentsHaveMessages=true',
          'Likely a store-key migration/linkage issue (messages persisted under provider session key instead of conv-*).',
        ],
      });
    }

    const wrongConversationLinks = Array.isArray(anomalies.segmentsWrongConversationLink)
      ? anomalies.segmentsWrongConversationLink.length
      : 0;
    if (wrongConversationLinks > 0) {
      suggestRepair = true;
      addCause(causes, {
        id: 'segment_conversation_link_mismatch',
        severity: 'info',
        confidence: clamp(0.65 + Math.min(wrongConversationLinks, 5) * 0.04, 0.65, 0.85),
        title: 'one or more provider segments link to a different conversation_id in session-info',
        evidence: [`segmentsWrongConversationLink: ${wrongConversationLinks}`],
      });
    }

    const missingSessionInfoLinks = Array.isArray(anomalies.segmentsMissingSessionInfo)
      ? anomalies.segmentsMissingSessionInfo.length
      : 0;
    if (missingSessionInfoLinks > 0) {
      suggestRepair = true;
      addCause(causes, {
        id: 'segment_session_info_missing',
        severity: 'warning',
        confidence: clamp(0.7 + Math.min(missingSessionInfoLinks, 5) * 0.05, 0.7, 0.9),
        title: 'one or more provider segments have no session-info row',
        evidence: [`segmentsMissingSessionInfo: ${missingSessionInfoLinks}`],
      });
    }
  }

  if (isRecord(params.messageLinkageData) && Array.isArray(params.messageLinkageData.stores)) {
    const stores = params.messageLinkageData.stores;
    const totalMessages = stores.reduce((sum: number, store: unknown) => {
      if (!isRecord(store) || !isRecord(store.counts)) return sum;
      const count = toNumber(store.counts.total) ?? 0;
      return sum + count;
    }, 0);

    if (totalMessages === 0) {
      addCause(causes, {
        id: 'no_persisted_messages',
        severity: 'warning',
        confidence: 0.82,
        title: 'no messages found in message store for this conversation and its segments',
        evidence: ['message-linkage stores show total=0 across all store keys'],
      });
    }
  }

  if (isRecord(params.eventsData) && isRecord(params.eventsData.summary)) {
    const summary = params.eventsData.summary;
    if (isRecord(summary.anomalies)) {
      const anomalies = summary.anomalies;
      const overlapping = toNumber(anomalies.overlappingStreams) ?? 0;
      const duplicates = toNumber(anomalies.duplicateMessageCompletes) ?? 0;
      const missingTransfer = anomalies.missingContextTransfer === true;

      if (overlapping > 0) {
        addCause(causes, {
          id: 'overlapping_streams',
          severity: 'warning',
          confidence: clamp(0.68 + Math.min(overlapping, 5) * 0.05, 0.68, 0.88),
          title: 'overlapping stream connections detected for this session',
          evidence: [`overlappingStreams: ${overlapping}`],
        });
      }

      if (duplicates > 0) {
        addCause(causes, {
          id: 'duplicate_message_complete',
          severity: 'warning',
          confidence: clamp(0.65 + Math.min(duplicates, 6) * 0.04, 0.65, 0.86),
          title: 'duplicate message_complete events detected',
          evidence: [`duplicateMessageCompletes: ${duplicates}`],
        });
      }

      if (missingTransfer) {
        addCause(causes, {
          id: 'missing_context_transfer',
          severity: 'info',
          confidence: 0.63,
          title: 'session appears to have missing context-transfer event',
          evidence: ['events summary flagged missingContextTransfer=true'],
        });
      }
    }

    if (isRecord(summary.durationsMs)) {
      const durations = summary.durationsMs;
      const toFirstMessage = toNumber(durations.toFirstMessage);
      if (toFirstMessage !== null && toFirstMessage > 60000) {
        addCause(causes, {
          id: 'slow_first_message',
          severity: 'warning',
          confidence: 0.7,
          title: 'session took unusually long to produce first message',
          evidence: [`toFirstMessage=${toFirstMessage}ms`],
        });
      }
    }
  }

  if (params.traceIds.length === 0) {
    addCause(causes, {
      id: 'missing_trace_ids',
      severity: 'info',
      confidence: 0.55,
      title: 'no trace IDs were found for this session window',
      evidence: ['traceIds array is empty'],
    });
  }

  if (params.tokenHitCount === 0) {
    addCause(causes, {
      id: 'no_log_hits',
      severity: 'info',
      confidence: 0.52,
      title: 'session/token correlation returned no log hits in scanned window',
      evidence: ['logTokenHits was empty'],
    });
  }

  // Analyze daemon process lifecycle
  if (params.daemonProcessEvents && params.daemonProcessEvents.length > 0) {
    const events = params.daemonProcessEvents;
    const sigterms = events.filter(e => e.type === 'sigterm');
    const closes = events.filter(e => e.type === 'close');
    const spawns = events.filter(e => e.type === 'spawn');
    const sigtermKills = closes.filter(e => e.exitCode === 143);

    if (sigterms.length > 0) {
      addCause(causes, {
        id: 'daemon_sigterm_kills',
        severity: sigterms.length > 1 ? 'warning' : 'info',
        confidence: clamp(0.75 + Math.min(sigterms.length, 3) * 0.06, 0.75, 0.93),
        title: `daemon sent SIGTERM to session process ${sigterms.length} time(s)`,
        evidence: sigterms.map(e => `${e.timestamp} SIGTERM -> pid:${e.pid} streaming:${e.streamingId}`),
      });
    }

    if (sigtermKills.length > 0 && spawns.length > sigtermKills.length) {
      addCause(causes, {
        id: 'process_churn',
        severity: 'warning',
        confidence: 0.85,
        title: 'session was killed and re-spawned multiple times (process churn)',
        evidence: [
          `spawns: ${spawns.length}, kills(143): ${sigtermKills.length}`,
          ...sigtermKills.map(e => `${e.timestamp} close(143) streaming:${e.streamingId} pid:${e.pid}`)
        ],
      });
    }

    // Check if last event is a close with no subsequent spawn (= session dead)
    const lastEvent = events[events.length - 1];
    if (lastEvent.type === 'close') {
      addCause(causes, {
        id: 'last_daemon_event_is_close',
        severity: 'warning',
        confidence: 0.82,
        title: 'last daemon event for session is a process close (session may be inactive)',
        evidence: [
          `${lastEvent.timestamp} close(${lastEvent.exitCode}) streaming:${lastEvent.streamingId} pid:${lastEvent.pid}`
        ],
      });
    }
  }

  const base = summarizeStatus(causes);

  const nextProbeCommands = dedupeStrings([
    `pnpm -s diag:agent:session -- ${params.requestedSessionId} > /tmp/lattice-session-diag.json`,
    `curl -s "http://127.0.0.1:3001/api/debug/sessions/${params.resolvedSessionId}/diagnostic" | jq .`,
    `curl -s "http://127.0.0.1:3001/api/debug/sessions/${params.resolvedSessionId}/events?limit=120" | jq .summary`,
    `curl -s "http://127.0.0.1:3001/api/debug/sessions/${params.resolvedSessionId}/audit-trail?limit=120" | jq .`,
    `curl -s "http://127.0.0.1:3001/api/debug/conversations/${params.resolvedSessionId}/switch-history?eventsLimit=150&contextLimit=20" | jq .anomalies,.traceSummaries`,
    `curl -s "http://127.0.0.1:3001/api/debug/conversations/${params.resolvedSessionId}/message-linkage" | jq .anomalies,.stores[].counts`,
    suggestRepair
      ? `curl -s -X POST "http://127.0.0.1:3001/api/debug/conversations/${params.resolvedSessionId}/repair" | jq .planned`
      : '',
    `rg "${params.resolvedSessionId.slice(0, 8)}" ${SERVER_JSONL_LOG} | tail -n 80`,
  ]);

  return {
    ...base,
    nextProbeCommands,
  };
}

function toInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let baseUrl = 'http://127.0.0.1:3001';
  let tailLines = 3000;
  let analysisLines = 600;
  let timeoutMs = 4500;

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--') {
      continue;
    }
    if (value === '--base-url') {
      baseUrl = argv[i + 1] || baseUrl;
      i += 1;
      continue;
    }
    if (value === '--tail-lines') {
      tailLines = toInteger(argv[i + 1], tailLines, 200, 30000);
      i += 1;
      continue;
    }
    if (value === '--analysis-lines') {
      analysisLines = toInteger(argv[i + 1], analysisLines, 100, 30000);
      i += 1;
      continue;
    }
    if (value === '--timeout-ms') {
      timeoutMs = toInteger(argv[i + 1], timeoutMs, 500, 20000);
      i += 1;
      continue;
    }
    positional.push(value);
  }

  const command = (positional[0] || 'snapshot') as 'snapshot' | 'session';
  if (command !== 'snapshot' && command !== 'session') {
    throw new Error(`Unknown command "${command}". Use "snapshot" or "session".`);
  }

  const sessionId = command === 'session' ? positional[1] : undefined;
  if (command === 'session' && !sessionId) {
    throw new Error('Session mode requires a session ID: pnpm diag:agent:session -- <sessionId>');
  }

  return { command, sessionId, baseUrl, tailLines, analysisLines: Math.min(analysisLines, tailLines), timeoutMs };
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFile('which', [command], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function getServiceState(service: string): Promise<{ service: string; state: string; error?: string }> {
  try {
    const { stdout } = await execFile('systemctl', ['--user', 'is-active', service], { timeout: 3000 });
    return { service, state: stdout.trim() || 'unknown' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { service, state: 'unknown', error: message };
  }
}

async function tailLogFile(filePath: string, tailLines: number): Promise<string[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const { stdout } = await execFile('tail', ['-n', String(tailLines), filePath], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
    return stdout.split('\n').map(normalizeStructuredLogLine).filter(Boolean);
  } catch {
    return [];
  }
}

async function tailRawFileLines(filePath: string, tailLines: number): Promise<string[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const { stdout } = await execFile('tail', ['-n', String(tailLines), filePath], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeStructuredLogLine(rawLine: string): string {
  const parsed = safeJsonParse(rawLine);
  if (!isRecord(parsed)) {
    return normalizeLogLine(rawLine);
  }

  const ts = typeof parsed.time === 'string'
    ? parsed.time
    : typeof parsed.ts === 'string'
      ? parsed.ts
      : typeof parsed.timestamp === 'string'
        ? parsed.timestamp
        : '';
  const level = typeof parsed.level === 'string' ? parsed.level.toUpperCase() : '';
  const component = typeof parsed.component === 'string'
    ? parsed.component
    : typeof parsed.name === 'string'
      ? parsed.name
      : '';
  const event = typeof parsed.event === 'string' ? parsed.event : '';
  const message = typeof parsed.msg === 'string'
    ? parsed.msg
    : typeof parsed.message === 'string'
      ? parsed.message
      : '';

  return [
    [ts ? `[${ts}]` : '', level ? `[${level}]` : '', component ? `[${component}]` : ''].filter(Boolean).join(' '),
    [event, message].filter(Boolean).join(' ').trim(),
    JSON.stringify(parsed),
  ].filter(Boolean).join(' ');
}

async function fetchJson(url: string, timeoutMs: number): Promise<{
  url: string;
  ok: boolean;
  status?: number;
  durationMs: number;
  data?: unknown;
  error?: string;
}> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return {
      url,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - started,
      data: text ? safeJsonParse(text) : null,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function selectAnalysisWindow(lines: string[], analysisLines: number): string[] {
  const windowSize = Math.max(1, Math.min(analysisLines, lines.length));
  return lines.slice(-windowSize);
}

function buildLogSummary(filePath: string, lines: string[], analysisLines: number) {
  const analysisWindow = selectAnalysisWindow(lines, analysisLines);
  const matches = analyzeLogLines(analysisWindow).filter((entry) => entry.count > 0);
  return {
    filePath,
    lineCount: lines.length,
    analysisWindowLines: analysisWindow.length,
    patternMatches: matches,
    recentTail: lines.slice(-25),
  };
}

async function collectToolingCandidates() {
  const checks = await Promise.all(
    TOOL_CANDIDATES.map(async (tool) => ({
      ...tool,
      installed: await commandExists(tool.command),
    }))
  );
  return checks;
}

interface EventJournalSummary {
  filePath: string;
  totalEvents: number;
  anomalies: Array<{
    ts: string;
    event: string;
    severity: string;
    component?: string;
    message?: string;
    streamingId?: string;
    conversationId?: string;
    fields?: Record<string, unknown>;
  }>;
  eventCounts: Record<string, number>;
  lastStartup: {
    ts: string;
    processRole?: string;
    nodeVersion?: string;
    pid?: number;
  } | null;
}

async function analyzeEventJournal(tailLines: number): Promise<EventJournalSummary> {
  const empty: EventJournalSummary = {
    filePath: EVENT_JOURNAL,
    totalEvents: 0,
    anomalies: [],
    eventCounts: {},
    lastStartup: null,
  };

  if (!fs.existsSync(EVENT_JOURNAL)) return empty;

  const recentLines = await tailRawFileLines(EVENT_JOURNAL, tailLines);
  const anomalies: EventJournalSummary['anomalies'] = [];
  const eventCounts: Record<string, number> = {};
  let lastStartup: EventJournalSummary['lastStartup'] = null;

  for (const line of recentLines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const event = String(record.event || '');
      eventCounts[event] = (eventCounts[event] || 0) + 1;

      if (event === 'system.startup') {
        const fields = record.fields as Record<string, unknown> | undefined;
        lastStartup = {
          ts: String(record.ts || ''),
          processRole: fields?.processRole as string | undefined,
          nodeVersion: fields?.nodeVersion as string | undefined,
          pid: fields?.pid as number | undefined,
        };
      }

      const severity = String(record.severity || 'info');
      if (severity === 'warn' || severity === 'error') {
        anomalies.push({
          ts: String(record.ts || ''),
          event,
          severity,
          component: record.component as string | undefined,
          message: record.message as string | undefined,
          streamingId: typeof record.streamingId === 'string' ? record.streamingId.slice(0, 8) : undefined,
          conversationId: record.conversationId as string | undefined,
          fields: record.fields as Record<string, unknown> | undefined,
        });
      }
    } catch {
      // Skip malformed lines.
    }
  }

  return {
    filePath: EVENT_JOURNAL,
    totalEvents: recentLines.length,
    anomalies: anomalies.slice(-50),
    eventCounts,
    lastStartup,
  };
}

async function runSnapshot(args: ParsedArgs) {
  const eventJournal = await analyzeEventJournal(args.tailLines);
  const [
    serverState,
    daemonState,
    tooling,
    serverLines,
    daemonLines,
    health,
    activeSessions,
    stateReconciliation,
    conversationIntegrity,
  ] = await Promise.all([
    getServiceState(`${SERVICE_PREFIX}-server`),
    getServiceState(`${SERVICE_PREFIX}-daemon`),
    collectToolingCandidates(),
    tailLogFile(SERVER_JSONL_LOG, args.tailLines),
    tailLogFile(DAEMON_JSONL_LOG, args.tailLines),
    fetchJson(`${args.baseUrl}/health`, args.timeoutMs),
    fetchJson(`${args.baseUrl}/api/debug/active-sessions`, args.timeoutMs),
    fetchJson(`${args.baseUrl}/api/debug/state-reconciliation`, args.timeoutMs),
    fetchJson(`${args.baseUrl}/api/debug/conversation-integrity?limit=50&offset=0`, args.timeoutMs),
  ]);

  const serverLogSummary = buildLogSummary(SERVER_JSONL_LOG, serverLines, args.analysisLines);
  const daemonLogSummary = buildLogSummary(DAEMON_JSONL_LOG, daemonLines, args.analysisLines);

  const divergenceCount = (() => {
    if (!stateReconciliation.ok) return null;
    if (!isRecord(stateReconciliation.data)) return null;
    const summary = stateReconciliation.data.summary;
    if (!isRecord(summary)) return null;
    return toNumber(summary.divergenceCount);
  })();

  const integritySummary = (() => {
    const empty = { canonicalEmptyButSegmentsHaveMessages: null, segmentsWrongConversationLink: null, segmentsMissingSessionInfo: null };
    if (!conversationIntegrity.ok) return empty;
    if (!isRecord(conversationIntegrity.data)) return empty;
    const summary = conversationIntegrity.data.summary;
    if (!isRecord(summary)) return empty;
    return {
      canonicalEmptyButSegmentsHaveMessages: toNumber(summary.canonicalEmptyButSegmentsHaveMessages),
      segmentsWrongConversationLink: toNumber(summary.segmentsWrongConversationLink),
      segmentsMissingSessionInfo: toNumber(summary.segmentsMissingSessionInfo),
    };
  })();

  const assessment = buildSnapshotAssessment({
    services: {
      latticeServerState: serverState.state,
      latticeDaemonState: daemonState.state,
    },
    api: {
      rootHealthOk: health.ok,
      activeSessionsOk: activeSessions.ok,
      stateReconciliationOk: stateReconciliation.ok,
      stateReconciliationDivergenceCount: divergenceCount,
      conversationIntegrityOk: conversationIntegrity.ok,
      conversationIntegritySummary: integritySummary,
    },
    serverPatternMatches: serverLogSummary.patternMatches,
  });

  return {
    mode: 'snapshot',
    generatedAt: new Date().toISOString(),
    host: os.hostname(),
    baseUrl: args.baseUrl,
    assessment,
    services: {
      latticeServer: serverState,
      latticeDaemon: daemonState,
    },
    api: {
      rootHealth: health,
      activeSessions,
      stateReconciliation,
      conversationIntegrity,
    },
    logs: {
      server: serverLogSummary,
      daemon: daemonLogSummary,
    },
    eventJournal,
    toolingCandidates: tooling,
  };
}

function extractTraceIdsFromDebugEvents(eventsResponse: unknown): string[] {
  if (!isRecord(eventsResponse)) return [];
  const summary = eventsResponse.summary;
  if (!isRecord(summary)) return [];
  const traceIds = summary.traceIds;
  if (!Array.isArray(traceIds)) return [];

  return normalizeTokenList(traceIds.filter((value): value is string => typeof value === 'string'));
}

function extractTraceIdsFromSwitchHistory(historyResponse: unknown): string[] {
  if (!isRecord(historyResponse)) return [];
  const traceIds = historyResponse.traceIds;
  if (!Array.isArray(traceIds)) return [];

  return normalizeTokenList(traceIds.filter((value): value is string => typeof value === 'string'));
}

async function runSession(args: ParsedArgs) {
  const snapshot = await runSnapshot(args);
  const requestedSessionId = args.sessionId as string;

  const diagnostic = await fetchJson(
    `${args.baseUrl}/api/debug/sessions/${encodeURIComponent(requestedSessionId)}/diagnostic`,
    args.timeoutMs
  );

  const resolvedSessionId = diagnostic.ok
    && isRecord(diagnostic.data)
    && typeof diagnostic.data.sessionId === 'string'
    ? diagnostic.data.sessionId
    : requestedSessionId;

  const [events, auditTrail, insightsDebug, insightsTimeline, switchHistory, messageLinkage] = await Promise.all([
    fetchJson(`${args.baseUrl}/api/debug/sessions/${encodeURIComponent(resolvedSessionId)}/events?limit=250`, args.timeoutMs),
    fetchJson(`${args.baseUrl}/api/debug/sessions/${encodeURIComponent(resolvedSessionId)}/audit-trail?limit=120`, args.timeoutMs),
    fetchJson(`${args.baseUrl}/api/conversations/debug/${encodeURIComponent(resolvedSessionId)}`, args.timeoutMs),
    fetchJson(`${args.baseUrl}/api/conversations/events?sessionId=${encodeURIComponent(resolvedSessionId)}&format=timeline&limit=120`, args.timeoutMs),
    fetchJson(`${args.baseUrl}/api/debug/conversations/${encodeURIComponent(resolvedSessionId)}/switch-history?eventsLimit=250&contextLimit=30`, args.timeoutMs),
    fetchJson(`${args.baseUrl}/api/debug/conversations/${encodeURIComponent(resolvedSessionId)}/message-linkage`, args.timeoutMs),
  ]);

  const conversationResolution = (() => {
    const fromMessageLinkage = messageLinkage.ok
      && isRecord(messageLinkage.data)
      && isRecord(messageLinkage.data.resolution)
      && typeof messageLinkage.data.resolution.conversationId === 'string'
      ? messageLinkage.data.resolution
      : null;

    const fromSwitchHistory = switchHistory.ok
      && isRecord(switchHistory.data)
      && isRecord(switchHistory.data.resolution)
      && typeof switchHistory.data.resolution.conversationId === 'string'
      ? switchHistory.data.resolution
      : null;

    return fromMessageLinkage || fromSwitchHistory;
  })();

  const conversationId = conversationResolution && typeof conversationResolution.conversationId === 'string'
    ? conversationResolution.conversationId
    : null;

  const stateReconciliationRelevant = (() => {
    const reconciliation = snapshot.api?.stateReconciliation;
    if (!reconciliation || !reconciliation.ok || !isRecord(reconciliation.data)) {
      return { divergenceCount: null, keys: [] as string[], divergences: null as unknown };
    }

    const divergenceObj = reconciliation.data.divergences;
    if (!isRecord(divergenceObj)) {
      return { divergenceCount: null, keys: [] as string[], divergences: null as unknown };
    }

    const fullStreamingIds = new Set<string>();
    const shortStreamingIds = new Set<string>();
    const sessionIds = new Set<string>([requestedSessionId, resolvedSessionId, ...(conversationId ? [conversationId] : [])]);
    const sessionIdPrefixes = new Set<string>(Array.from(sessionIds).map((id) => id.slice(0, 8)));

    const addStreamingId = (value: unknown) => {
      if (typeof value !== 'string' || value.length === 0) return;
      fullStreamingIds.add(value);
      shortStreamingIds.add(value.slice(0, 8));
    };

    // Extract candidate streaming IDs from the APIs we already fetched.
    if (isRecord(diagnostic.data) && isRecord(diagnostic.data.statusManager)) {
      addStreamingId(diagnostic.data.statusManager.streamingId);
    }
    if (isRecord(diagnostic.data) && isRecord(diagnostic.data.daemon)) {
      addStreamingId(diagnostic.data.daemon.streamingId);
    }
    if (isRecord(switchHistory.data) && isRecord(switchHistory.data.conversation) && Array.isArray(switchHistory.data.conversation.segments)) {
      for (const seg of switchHistory.data.conversation.segments) {
        if (!isRecord(seg)) continue;
        addStreamingId(seg.streamingId);
      }
    }
    if (isRecord(messageLinkage.data) && isRecord(messageLinkage.data.codexSessions)) {
      const codexSessions = messageLinkage.data.codexSessions;
      if (isRecord(codexSessions.running)) addStreamingId(codexSessions.running.streamingId);
      if (isRecord(codexSessions.latest)) addStreamingId(codexSessions.latest.streamingId);
    }

    const relevant: Record<string, unknown[]> = {};
    let count = 0;

    for (const [key, rawEntries] of Object.entries(divergenceObj)) {
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) continue;
      const filtered = rawEntries.filter((entry) => {
        if (!isRecord(entry)) return false;
        const streamingId = typeof entry.streamingId === 'string' ? entry.streamingId : null;
        const streamingIdShort = typeof entry.streamingIdShort === 'string' ? entry.streamingIdShort : null;
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : null;
        const sessionIdShort = typeof entry.sessionIdShort === 'string' ? entry.sessionIdShort : null;
        const resolvedSessionId = typeof entry.resolvedSessionId === 'string' ? entry.resolvedSessionId : null;
        const resolvedSessionIdShort = typeof entry.resolvedSessionIdShort === 'string' ? entry.resolvedSessionIdShort : null;
        const conversationId = typeof entry.conversationId === 'string' ? entry.conversationId : null;
        const conversationIdShort = typeof entry.conversationIdShort === 'string' ? entry.conversationIdShort : null;

        if (streamingId && fullStreamingIds.has(streamingId)) return true;
        if (streamingIdShort && shortStreamingIds.has(streamingIdShort)) return true;
        if (sessionId && sessionIds.has(sessionId)) return true;
        if (resolvedSessionId && sessionIds.has(resolvedSessionId)) return true;
        if (conversationId && sessionIds.has(conversationId)) return true;
        if (sessionIdShort && sessionIdPrefixes.has(sessionIdShort)) return true;
        if (resolvedSessionIdShort && sessionIdPrefixes.has(resolvedSessionIdShort)) return true;
        if (conversationIdShort && sessionIdPrefixes.has(conversationIdShort)) return true;

        return false;
      });

      if (filtered.length > 0) {
        relevant[key] = filtered;
        count += filtered.length;
      }
    }

    return {
      divergenceCount: count,
      keys: Object.keys(relevant),
      divergences: relevant,
    };
  })();

  const traceIds = normalizeTokenList([
    ...extractTraceIdsFromDebugEvents(events.data),
    ...extractTraceIdsFromSwitchHistory(switchHistory.data),
  ]);
  const [serverWindow, daemonWindow] = await Promise.all([
    tailLogFile(SERVER_JSONL_LOG, args.tailLines),
    tailLogFile(DAEMON_JSONL_LOG, args.tailLines),
  ]);
  const logLines = [...serverWindow, ...daemonWindow];
  const tokenHits = collectTokenHits(logLines, [
    requestedSessionId,
    requestedSessionId.slice(0, 8),
    resolvedSessionId,
    resolvedSessionId.slice(0, 8),
    ...(conversationId && conversationId !== resolvedSessionId
      ? [conversationId, conversationId.slice(0, 8)]
      : []),
    ...traceIds,
  ]);

  // Parse daemon process lifecycle events for this session
  const daemonProcessEvents = parseDaemonProcessEvents(daemonWindow, resolvedSessionId.slice(0, 8));

  const assessment = buildSessionAssessment({
    requestedSessionId,
    resolvedSessionId,
    diagnosticOk: diagnostic.ok,
    diagnosticData: diagnostic.data,
    eventsOk: events.ok,
    eventsData: events.data,
    stateReconciliationRelevantDivergenceCount: stateReconciliationRelevant.divergenceCount,
    stateReconciliationRelevantKeys: stateReconciliationRelevant.keys,
    switchHistoryOk: switchHistory.ok,
    switchHistoryData: switchHistory.data,
    messageLinkageOk: messageLinkage.ok,
    messageLinkageData: messageLinkage.data,
    traceIds,
    tokenHitCount: Object.keys(tokenHits).length,
    daemonProcessEvents,
  });

  return {
    mode: 'session',
    generatedAt: new Date().toISOString(),
    requestedSessionId,
    resolvedSessionId,
    conversationId,
    conversationIdShort: conversationId ? conversationId.slice(0, 8) : null,
    conversationResolvedFrom: conversationResolution
      ? (typeof conversationResolution.resolvedFrom === 'string' ? conversationResolution.resolvedFrom : null)
      : null,
    traceIds,
    assessment,
    snapshot,
    stateReconciliationRelevant,
    sessionApi: {
      diagnostic,
      events,
      auditTrail,
      insightsDebug,
      insightsTimeline,
      switchHistory,
      messageLinkage,
    },
    daemonProcessTimeline: daemonProcessEvents,
    logTokenHits: tokenHits,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = args.command === 'snapshot'
    ? await runSnapshot(args)
    : await runSession(args);
  console.log(JSON.stringify(payload, null, 2));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      mode: 'error',
      generatedAt: new Date().toISOString(),
      error: message,
    }, null, 2));
    process.exitCode = 1;
  });
}
