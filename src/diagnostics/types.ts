/**
 * Runtime diagnostics shared types.
 *
 * Defined in `docs/runtime-diagnostics-and-authority-collapse.md` §1.3.
 *
 * The design doc anchors these in `agent-ui-harness/src/diagnostics/types.ts`
 * for eventual sharing with a client-side debug panel. They live here for now
 * because the only consumer is the Lattice server. Promote when a second
 * consumer needs them.
 */

export type RuntimeFactSource =
  | 'harness_events'
  | 'harness_manager'
  | 'daemon'
  | 'active_registry'
  | 'database'
  | 'public_status'
  | 'client_harness'
  | 'client_status_poll'
  | 'composer';

export type RuntimePhase =
  | 'absent'
  | 'starting'
  | 'working'
  | 'stopping'
  | 'idle_alive'
  | 'idle_dead'
  | 'error';

export interface RuntimeFactIds {
  conversationId: string;
  runId?: string | null;
  processId?: string | null;
  providerSessionId?: string | null;
  segmentId?: string | null;
}

export interface RuntimeFactSeq {
  firstSeq?: number | null;
  lastSeq?: number | null;
  eventCount?: number;
  lastEventType?: string | null;
  lastEventAtMs?: number | null;
}

export interface RuntimeFacts {
  source: RuntimeFactSource;
  observedAtMs: number;
  ids: RuntimeFactIds;
  seq?: RuntimeFactSeq;
  sessionKnown: boolean;
  hasEventHistory: boolean;
  phase: RuntimePhase;
  hasOpenRun: boolean | null;
  processAlive: boolean | null;
  turnActive: boolean | null;
  canSubmit: boolean | null;
  canStop: boolean | null;
  awaitingPermission: boolean | null;
  awaitingQuestion: boolean | null;
  hasRunningBackgroundTasks: boolean | null;
  scheduledWakeupPending: boolean | null;
  resumeReady: boolean | null;
  transportConnected?: boolean | null;
  hydrationPhase?: 'hydrating' | 'ready' | null;
}

export interface DiagnosticSourceSnapshot {
  source: RuntimeFactSource;
  available: boolean;
  ok: boolean;
  collectedAtMs: number;
  freshnessMs?: number | null;
  stale: boolean;
  facts?: RuntimeFacts;
  summary?: Record<string, unknown>;
  raw?: unknown;
  errors?: Array<{ code: string; message: string }>;
}

export type DiagnosticSeverity = 'pass' | 'info' | 'warn' | 'error' | 'skipped';

export type RuntimeInvariantId =
  | 'runtime_authority_consensus'
  | 'single_live_run'
  | 'daemon_manager_process_consistency'
  | 'seq_integrity'
  | 'resume_id_consistency'
  | 'event_recovery_visibility'
  | 'stop_semantics'
  | 'sse_reconnect_no_duplicates'
  | 'hydration_completion'
  | 'pending_message_injection'
  | 'permission_question_visibility'
  | 'background_task_consensus';

export interface DiagnosticDisagreement {
  field: string;
  source: RuntimeFactSource | 'event_store' | 'sse' | 'projection';
  value: unknown;
  expected: unknown;
  ageMs?: number;
  graceMs?: number;
}

export interface DiagnosticEvidence {
  source: RuntimeFactSource | 'event_store' | 'sse' | 'projection' | 'sqlite';
  label: string;
  value: unknown;
}

export interface DiagnosticInvariantResult {
  id: RuntimeInvariantId;
  severity: DiagnosticSeverity;
  ok: boolean;
  checkedAtMs: number;
  title: string;
  summary: string;
  anchorSource?: RuntimeFactSource;
  ageMs?: number;
  graceMs?: number;
  disagreements?: DiagnosticDisagreement[];
  evidence?: DiagnosticEvidence[];
  likelyBugClass?: string;
  remediation?: string;
  skippedReason?: string;
}

export interface DiagnosticEventSummary {
  seq: number;
  type: string;
  timestampMs?: number | null;
  inferred?: boolean;
  synthetic?: boolean;
  role?: 'user' | 'assistant' | 'system' | 'tool' | null;
  ids?: {
    runId?: string | null;
    processId?: string | null;
    providerSessionId?: string | null;
    toolUseId?: string | null;
  };
  lifecycle?: {
    reason?: string | null;
    exitCode?: number | null;
    signal?: string | null;
  };
  payloadBytes?: number;
  raw?: unknown;
}

export interface ConversationDiagnosticsRequestEcho {
  requestId: string;
  conversationId: string;
  eventLimit: number;
  includeRawEvents: boolean;
  includeProcessDetails: boolean;
  includeRawSources: boolean;
}

export interface ConversationDiagnosticsAccess {
  mode: 'development-loopback' | 'admin';
  redaction: 'redacted' | 'raw';
  rawAllowed: boolean;
}

export interface ConversationDiagnosticsIdentity {
  conversationId: string;
  segmentId?: string | null;
  runId?: string | null;
  processId?: string | null;
  providerSessionId?: string | null;
  cwd?: string | null;
  cwdHash?: string | null;
  provider: 'claude' | 'codex';
}

export interface ConversationDiagnosticsSummary {
  health: 'healthy' | 'degraded' | 'unhealthy';
  highestSeverity: DiagnosticSeverity;
  errorCount: number;
  warnCount: number;
  primaryPhase: RuntimePhase;
  canSubmit: boolean | null;
  processAlive: boolean | null;
  lastSeq?: number | null;
  lastEventType?: string | null;
  lastEventAtMs?: number | null;
}

export interface ConversationDiagnosticsReport {
  schemaVersion: 'lattice.runtime-diagnostics.v1';
  generatedAtMs: number;
  request: ConversationDiagnosticsRequestEcho;
  access: ConversationDiagnosticsAccess;
  identity: ConversationDiagnosticsIdentity;
  summary: ConversationDiagnosticsSummary;
  sources: Partial<Record<RuntimeFactSource, DiagnosticSourceSnapshot>>;
  invariants: DiagnosticInvariantResult[];
  events: {
    window: {
      limit: number;
      returned: number;
      firstSeq?: number | null;
      lastSeq?: number | null;
      hasMoreBefore: boolean;
    };
    items: DiagnosticEventSummary[];
  };
  sqlite?: {
    recentSlowOps: Array<{
      op: string;
      durationMs: number;
      rows?: number;
      occurredAtMs: number;
    }>;
  };
  recommendations: Array<{
    severity: 'info' | 'warn' | 'error';
    message: string;
    action?: string;
  }>;
}

export const DIAGNOSTICS_SCHEMA_VERSION = 'lattice.runtime-diagnostics.v1' as const;
