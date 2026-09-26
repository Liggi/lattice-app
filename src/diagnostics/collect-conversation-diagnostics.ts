/**
 * Collect a ConversationDiagnosticsReport (§1.3, §4).
 *
 * Read-only. Must not mutate registry, DB rows, event storage, process state,
 * or session state.
 */

import { randomUUID } from 'crypto';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { getEventStorage } from '@/harness/event-message-reader.js';
import { deriveSessionStatusFromEvents } from '@/harness/derive-session-status.js';
import type { ProcessManagerClient } from '@/process-daemon/process-manager-client.js';
import type {
  ActiveConversation,
  ActiveConversationRegistry,
} from '@/services/process/active-conversation-registry.js';
import type {
  Conversation,
  ConversationSegment,
  ConversationService,
} from '@/services/sessions/conversation-service.js';
import { evaluateInvariants } from './invariants.js';
import { summarizeEvent } from './event-summaries.js';
import { deriveRuntimeFactsFromHarnessEvents } from './runtime-facts.js';
import {
  DIAGNOSTICS_SCHEMA_VERSION,
  type ConversationDiagnosticsAccess,
  type ConversationDiagnosticsReport,
  type ConversationDiagnosticsSummary,
  type DiagnosticInvariantResult,
  type DiagnosticSeverity,
  type DiagnosticSourceSnapshot,
  type RuntimeFacts,
  type RuntimeFactSource,
  type RuntimePhase,
} from './types.js';

const DEFAULT_EVENT_LIMIT = 80;
const MAX_EVENT_LIMIT = 500;
const DAEMON_SOURCE_TIMEOUT_MS = 2_500;

interface HarnessSessionDiagnostics {
  status: 'idle' | 'starting' | 'streaming' | 'stopping';
  runId: string | null;
  resumeId: string | null;
  processAlive: boolean;
  pid?: number;
  eventCount: number;
  lastEventAt: number | null;
  lastEventType: string | null;
  scheduledWakeup: unknown | null;
}

interface HarnessSessionManagerDiagnostics {
  hasSession(sessionId: string): boolean;
  getSessionIds(): string[];
  inspect(sessionId: string): HarnessSessionDiagnostics | null;
}

export interface DiagnosticsRuntimeDeps {
  harnessSessionManager?: HarnessSessionManagerDiagnostics;
  processManagerClient?: ProcessManagerClient;
  activeConversationRegistry?: ActiveConversationRegistry;
  conversationService?: ConversationService;
}

export interface CollectOptions {
  conversationId: string;
  eventLimit?: number;
  includeRawEvents?: boolean;
  includeProcessDetails?: boolean;
  includeRawSources?: boolean;
  access: ConversationDiagnosticsAccess;
  requestId?: string;
  runtime?: DiagnosticsRuntimeDeps;
}

export async function collectConversationDiagnostics(
  opts: CollectOptions,
): Promise<ConversationDiagnosticsReport> {
  const generatedAtMs = Date.now();
  const requestId = opts.requestId ?? randomUUID();

  const eventLimit = clampEventLimit(opts.eventLimit);
  const includeRawEvents = Boolean(opts.includeRawEvents) && opts.access.rawAllowed;
  const includeRawSources = Boolean(opts.includeRawSources) && opts.access.rawAllowed;

  const storage = getEventStorage();
  const allEvents = storage.read(opts.conversationId);
  const provider = inferProvider(allEvents);
  const harnessFacts = deriveRuntimeFactsFromHarnessEvents(
    opts.conversationId,
    allEvents,
  );

  const sources: Partial<Record<RuntimeFactSource, DiagnosticSourceSnapshot>> = {};
  sources.harness_events = {
    source: 'harness_events',
    available: true,
    ok: true,
    collectedAtMs: generatedAtMs,
    freshnessMs: 0,
    stale: false,
    facts: harnessFacts,
  };
  sources.harness_manager = collectHarnessManagerSource({
    conversationId: opts.conversationId,
    deps: opts.runtime,
    collectedAtMs: generatedAtMs,
    includeRawSources,
  });
  sources.active_registry = collectActiveRegistrySource({
    conversationId: opts.conversationId,
    deps: opts.runtime,
    events: allEvents,
    collectedAtMs: generatedAtMs,
    includeRawSources,
  });
  sources.database = collectDatabaseSource({
    conversationId: opts.conversationId,
    deps: opts.runtime,
    events: allEvents,
    collectedAtMs: generatedAtMs,
    includeRawSources,
  });
  sources.public_status = collectPublicStatusSource({
    conversationId: opts.conversationId,
    deps: opts.runtime,
    events: allEvents,
    collectedAtMs: generatedAtMs,
    includeRawSources,
  });
  sources.daemon = await collectDaemonSource({
    conversationId: opts.conversationId,
    deps: opts.runtime,
    events: allEvents,
    collectedAtMs: generatedAtMs,
    includeRawSources,
  });

  const invariants = evaluateInvariants(sources, generatedAtMs);
  const summary = summarize(harnessFacts.phase, harnessFacts, invariants);

  const window = pickEventWindow(allEvents, eventLimit);
  const items = window.events.map((e) =>
    summarizeEvent(e, { includeRaw: includeRawEvents }),
  );

  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAtMs,
    request: {
      requestId,
      conversationId: opts.conversationId,
      eventLimit,
      includeRawEvents,
      includeProcessDetails: Boolean(opts.includeProcessDetails) && opts.access.rawAllowed,
      includeRawSources,
    },
    access: opts.access,
    identity: {
      conversationId: opts.conversationId,
      providerSessionId: harnessFacts.ids.providerSessionId ?? null,
      runId: harnessFacts.ids.runId ?? null,
      processId: harnessFacts.ids.processId ?? null,
      provider,
    },
    summary,
    sources,
    invariants,
    events: {
      window: {
        limit: eventLimit,
        returned: items.length,
        firstSeq: window.firstSeq,
        lastSeq: window.lastSeq,
        hasMoreBefore: window.hasMoreBefore,
      },
      items,
    },
    recommendations: [],
  };
}

function collectHarnessManagerSource(params: {
  conversationId: string;
  deps?: DiagnosticsRuntimeDeps;
  collectedAtMs: number;
  includeRawSources: boolean;
}): DiagnosticSourceSnapshot {
  const source: RuntimeFactSource = 'harness_manager';
  const manager = params.deps?.harnessSessionManager;
  if (!manager) {
    return unavailableSnapshot(source, params.collectedAtMs, 'DEPENDENCY_MISSING', 'Harness session manager was not provided.');
  }

  try {
    const diagnostics = manager.inspect(params.conversationId);
    if (!diagnostics) {
      return okSnapshot({
        source,
        collectedAtMs: params.collectedAtMs,
        facts: absentFacts(source, params.conversationId, params.collectedAtMs),
        raw: params.includeRawSources ? { trackedSessionIds: manager.getSessionIds() } : undefined,
      });
    }

    const phase = phaseFromHarnessStatus(diagnostics.status, diagnostics.processAlive);
    const facts: RuntimeFacts = {
      source,
      observedAtMs: params.collectedAtMs,
      ids: {
        conversationId: params.conversationId,
        runId: diagnostics.runId,
        processId: diagnostics.pid == null ? null : String(diagnostics.pid),
        providerSessionId: diagnostics.resumeId,
      },
      seq: {
        eventCount: diagnostics.eventCount,
        lastEventType: diagnostics.lastEventType,
        lastEventAtMs: diagnostics.lastEventAt,
      },
      sessionKnown: true,
      hasEventHistory: diagnostics.eventCount > 0,
      phase,
      hasOpenRun: phase !== 'absent' && phase !== 'idle_dead',
      processAlive: diagnostics.processAlive,
      turnActive: diagnostics.status === 'streaming',
      canSubmit: canSubmitInPhase(phase),
      canStop: canStopInPhase(phase),
      awaitingPermission: null,
      awaitingQuestion: null,
      hasRunningBackgroundTasks: null,
      scheduledWakeupPending: diagnostics.scheduledWakeup != null,
      resumeReady: isRealProviderSessionId(diagnostics.resumeId),
    };

    return okSnapshot({
      source,
      collectedAtMs: params.collectedAtMs,
      facts,
      raw: params.includeRawSources ? diagnostics : undefined,
    });
  } catch (err) {
    return errorSnapshot(source, params.collectedAtMs, 'HARNESS_MANAGER_READ_FAILED', err);
  }
}

function collectActiveRegistrySource(params: {
  conversationId: string;
  deps?: DiagnosticsRuntimeDeps;
  events: readonly SessionEvent[];
  collectedAtMs: number;
  includeRawSources: boolean;
}): DiagnosticSourceSnapshot {
  const source: RuntimeFactSource = 'active_registry';
  const registry = params.deps?.activeConversationRegistry;
  if (!registry) {
    return unavailableSnapshot(source, params.collectedAtMs, 'DEPENDENCY_MISSING', 'ActiveConversationRegistry was not provided.');
  }

  try {
    const active = registry.get(params.conversationId);
    if (!active) {
      return okSnapshot({
        source,
        collectedAtMs: params.collectedAtMs,
        facts: absentFacts(source, params.conversationId, params.collectedAtMs),
        raw: params.includeRawSources ? { activeCount: registry.size } : undefined,
      });
    }

    const phase = phaseFromRegistryRun(active);
    const facts: RuntimeFacts = {
      source,
      observedAtMs: params.collectedAtMs,
      ids: {
        conversationId: active.conversationId,
        segmentId: active.segment.segmentId,
        providerSessionId: active.segment.providerSessionId,
        processId: active.run?.streamingId ?? null,
      },
      seq: seqFromEvents(params.events),
      sessionKnown: true,
      hasEventHistory: params.events.length > 0,
      phase,
      hasOpenRun: active.run != null,
      processAlive: active.run != null,
      // The registry holds process metadata only — it has no opinion on
      // whether a turn is active (status is event-log derived elsewhere).
      turnActive: null,
      canSubmit: canSubmitInPhase(phase),
      canStop: active.run != null,
      awaitingPermission: null,
      awaitingQuestion: null,
      hasRunningBackgroundTasks: null,
      scheduledWakeupPending: null,
      resumeReady: isRealProviderSessionId(active.segment.providerSessionId),
    };

    return okSnapshot({
      source,
      collectedAtMs: params.collectedAtMs,
      facts,
      raw: params.includeRawSources ? active : undefined,
    });
  } catch (err) {
    return errorSnapshot(source, params.collectedAtMs, 'ACTIVE_REGISTRY_READ_FAILED', err);
  }
}

function collectDatabaseSource(params: {
  conversationId: string;
  deps?: DiagnosticsRuntimeDeps;
  events: readonly SessionEvent[];
  collectedAtMs: number;
  includeRawSources: boolean;
}): DiagnosticSourceSnapshot {
  const source: RuntimeFactSource = 'database';
  const conversationService = params.deps?.conversationService;
  if (!conversationService) {
    return unavailableSnapshot(source, params.collectedAtMs, 'DEPENDENCY_MISSING', 'ConversationService was not provided.');
  }

  try {
    const conversation = conversationService.getConversation(params.conversationId);
    if (!conversation) {
      return okSnapshot({
        source,
        collectedAtMs: params.collectedAtMs,
        facts: absentFacts(source, params.conversationId, params.collectedAtMs),
      });
    }

    const latest = conversation.segments[conversation.segments.length - 1] ?? null;
    const phase = phaseFromDatabaseSegment(latest);
    const facts: RuntimeFacts = {
      source,
      observedAtMs: params.collectedAtMs,
      ids: {
        conversationId: conversation.conversationId,
        segmentId: latest?.segmentId ?? null,
        providerSessionId: latest?.providerSessionId ?? null,
        processId: latest?.streamingId ?? null,
      },
      seq: seqFromEvents(params.events),
      sessionKnown: true,
      hasEventHistory: params.events.length > 0,
      phase,
      hasOpenRun: latest?.status === 'active' ? null : false,
      processAlive: latest?.status === 'active' ? null : false,
      turnActive: null,
      canSubmit: canSubmitInPhase(phase),
      canStop: null,
      awaitingPermission: null,
      awaitingQuestion: null,
      hasRunningBackgroundTasks: null,
      scheduledWakeupPending: null,
      resumeReady: isRealProviderSessionId(latest?.providerSessionId ?? null),
    };

    return okSnapshot({
      source,
      collectedAtMs: params.collectedAtMs,
      facts,
      raw: params.includeRawSources ? summarizeDatabaseRaw(conversation) : undefined,
    });
  } catch (err) {
    return errorSnapshot(source, params.collectedAtMs, 'DATABASE_READ_FAILED', err);
  }
}

function collectPublicStatusSource(params: {
  conversationId: string;
  deps?: DiagnosticsRuntimeDeps;
  events: readonly SessionEvent[];
  collectedAtMs: number;
  includeRawSources: boolean;
}): DiagnosticSourceSnapshot {
  const source: RuntimeFactSource = 'public_status';

  try {
    const registryAnswer = params.deps?.activeConversationRegistry?.get(params.conversationId);
    const derived = deriveSessionStatusFromEvents(params.events);
    const hasEvents = params.events.length > 0;
    const status = hasEvents
      ? derived.status
      : registryAnswer
        ? endpointStatusFromRegistry(registryAnswer)
        : 'completed';
    const phase = phaseFromEndpointStatus(status, hasEvents ? derived.harnessStatus : undefined);
    const facts: RuntimeFacts = {
      source,
      observedAtMs: params.collectedAtMs,
      ids: {
        conversationId: params.conversationId,
        segmentId: registryAnswer?.segment.segmentId ?? null,
        providerSessionId: registryAnswer?.segment.providerSessionId ?? null,
        processId: registryAnswer?.run?.streamingId ?? null,
      },
      seq: seqFromEvents(params.events),
      sessionKnown: hasEvents || registryAnswer != null,
      hasEventHistory: hasEvents,
      phase,
      hasOpenRun: status === 'ongoing' || status === 'idle',
      processAlive: hasEvents ? derived.processAlive : registryAnswer?.run != null,
      turnActive: status === 'ongoing',
      canSubmit: status === 'idle' || status === 'completed',
      canStop: status === 'ongoing' || status === 'stopping',
      awaitingPermission: null,
      awaitingQuestion: null,
      hasRunningBackgroundTasks: null,
      scheduledWakeupPending: null,
      resumeReady: isRealProviderSessionId(registryAnswer?.segment.providerSessionId ?? null),
    };

    return okSnapshot({
      source,
      collectedAtMs: params.collectedAtMs,
      facts,
      raw: params.includeRawSources
        ? {
            status,
            provider: registryAnswer?.segment.provider ?? inferProvider(params.events),
            streamingId: registryAnswer?.run?.streamingId ?? null,
            runVersion: registryAnswer?.run?.runVersion ?? null,
          }
        : undefined,
    });
  } catch (err) {
    return errorSnapshot(source, params.collectedAtMs, 'PUBLIC_STATUS_DERIVE_FAILED', err);
  }
}

async function collectDaemonSource(params: {
  conversationId: string;
  deps?: DiagnosticsRuntimeDeps;
  events: readonly SessionEvent[];
  collectedAtMs: number;
  includeRawSources: boolean;
}): Promise<DiagnosticSourceSnapshot> {
  const source: RuntimeFactSource = 'daemon';
  const client = params.deps?.processManagerClient;
  if (!client) {
    return unavailableSnapshot(source, params.collectedAtMs, 'DEPENDENCY_MISSING', 'ProcessManagerClient was not provided.');
  }

  try {
    const activeSessions = await withTimeout(
      client.getActiveSessions(),
      DAEMON_SOURCE_TIMEOUT_MS,
      'daemon list timed out',
    );
    const registryAnswer = params.deps?.activeConversationRegistry?.get(params.conversationId);
    const latestSegment = params.deps?.conversationService?.getLatestSegment(params.conversationId) ?? null;
    const expectedStreamingIds = new Set(
      [
        registryAnswer?.run?.streamingId,
        latestSegment?.streamingId,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    const expectedProviderIds = new Set(
      [
        registryAnswer?.segment.providerSessionId,
        latestSegment?.providerSessionId,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0),
    );

    const match = activeSessions.find((session) =>
      expectedStreamingIds.has(session.streamingId)
      || expectedProviderIds.has(session.sessionId)
      || session.sessionId === params.conversationId,
    );
    const sessionKnown =
      match != null
      || expectedStreamingIds.size > 0
      || expectedProviderIds.size > 0
      || params.events.length > 0;
    const phase: RuntimePhase = match
      ? match.isIdle === false
        ? 'working'
        : 'idle_alive'
      : sessionKnown
        ? 'idle_dead'
        : 'absent';
    const providerSessionId =
      registryAnswer?.segment.providerSessionId
      ?? latestSegment?.providerSessionId
      ?? match?.sessionId
      ?? null;

    const facts: RuntimeFacts = {
      source,
      observedAtMs: params.collectedAtMs,
      ids: {
        conversationId: params.conversationId,
        segmentId: registryAnswer?.segment.segmentId ?? latestSegment?.segmentId ?? null,
        providerSessionId,
        processId: match?.streamingId ?? registryAnswer?.run?.streamingId ?? latestSegment?.streamingId ?? null,
      },
      seq: seqFromEvents(params.events),
      sessionKnown,
      hasEventHistory: params.events.length > 0,
      phase,
      hasOpenRun: match != null,
      processAlive: match != null,
      turnActive: match?.isIdle === false,
      canSubmit: canSubmitInPhase(phase),
      canStop: match != null,
      awaitingPermission: null,
      awaitingQuestion: null,
      hasRunningBackgroundTasks: null,
      scheduledWakeupPending: null,
      resumeReady: isRealProviderSessionId(providerSessionId),
    };

    return okSnapshot({
      source,
      collectedAtMs: params.collectedAtMs,
      facts,
      raw: params.includeRawSources
        ? {
            activeCount: activeSessions.length,
            matched: match ?? null,
          }
        : undefined,
    });
  } catch (err) {
    return errorSnapshot(source, params.collectedAtMs, 'DAEMON_READ_FAILED', err);
  }
}

function okSnapshot(params: {
  source: RuntimeFactSource;
  collectedAtMs: number;
  facts: RuntimeFacts;
  raw?: unknown;
}): DiagnosticSourceSnapshot {
  return {
    source: params.source,
    available: true,
    ok: true,
    collectedAtMs: params.collectedAtMs,
    freshnessMs: freshnessFromFacts(params.facts, params.collectedAtMs),
    stale: false,
    facts: params.facts,
    raw: params.raw,
  };
}

function unavailableSnapshot(
  source: RuntimeFactSource,
  collectedAtMs: number,
  code: string,
  message: string,
): DiagnosticSourceSnapshot {
  return {
    source,
    available: false,
    ok: false,
    collectedAtMs,
    freshnessMs: null,
    stale: false,
    errors: [{ code, message }],
  };
}

function errorSnapshot(
  source: RuntimeFactSource,
  collectedAtMs: number,
  code: string,
  error: unknown,
): DiagnosticSourceSnapshot {
  return {
    source,
    available: true,
    ok: false,
    collectedAtMs,
    freshnessMs: null,
    stale: false,
    errors: [{
      code,
      message: error instanceof Error ? error.message : String(error),
    }],
  };
}

function absentFacts(
  source: RuntimeFactSource,
  conversationId: string,
  observedAtMs: number,
): RuntimeFacts {
  return {
    source,
    observedAtMs,
    ids: { conversationId, providerSessionId: null },
    sessionKnown: false,
    hasEventHistory: false,
    phase: 'absent',
    hasOpenRun: false,
    processAlive: false,
    turnActive: false,
    canSubmit: false,
    canStop: false,
    awaitingPermission: false,
    awaitingQuestion: false,
    hasRunningBackgroundTasks: false,
    scheduledWakeupPending: false,
    resumeReady: false,
  };
}

function seqFromEvents(events: readonly SessionEvent[]) {
  if (events.length === 0) {
    return {
      firstSeq: null,
      lastSeq: null,
      eventCount: 0,
      lastEventType: null,
      lastEventAtMs: null,
    };
  }
  const last = events[events.length - 1];
  return {
    firstSeq: events[0].seq,
    lastSeq: last.seq,
    eventCount: events.length,
    lastEventType: last.type,
    lastEventAtMs: last.timestamp,
  };
}

function phaseFromHarnessStatus(
  status: HarnessSessionDiagnostics['status'],
  processAlive: boolean,
): RuntimePhase {
  switch (status) {
    case 'starting':
      return 'starting';
    case 'streaming':
      return 'working';
    case 'stopping':
      return 'stopping';
    case 'idle':
      return processAlive ? 'idle_alive' : 'idle_dead';
  }
}

// The registry knows process presence, not turn state (status is event-log
// derived): a live run reads as idle_alive, no run as idle_dead.
function phaseFromRegistryRun(active: ActiveConversation): RuntimePhase {
  return active.run ? 'idle_alive' : 'idle_dead';
}

function phaseFromDatabaseSegment(segment: ConversationSegment | null): RuntimePhase {
  if (!segment) return 'absent';
  switch (segment.status) {
    case 'failed':
      return 'error';
    case 'completed':
      return 'idle_dead';
    case 'active':
      return 'idle_alive';
  }
}

// Registered with a run but no events yet = spawn in flight; the public
// status endpoint answers 'pending' in that state, mirror it here.
function endpointStatusFromRegistry(active: ActiveConversation): 'pending' | 'completed' {
  return active.run ? 'pending' : 'completed';
}

function phaseFromEndpointStatus(
  status: 'ongoing' | 'idle' | 'stopping' | 'completed' | 'pending',
  harnessStatus?: 'idle' | 'starting' | 'streaming' | 'stopping',
): RuntimePhase {
  switch (status) {
    case 'ongoing':
      return harnessStatus === 'starting' ? 'starting' : 'working';
    case 'idle':
      return 'idle_alive';
    case 'stopping':
      return 'stopping';
    case 'completed':
      return 'idle_dead';
    case 'pending':
      return 'starting';
  }
}

function canSubmitInPhase(phase: RuntimePhase): boolean {
  return phase === 'idle_alive' || phase === 'idle_dead' || phase === 'working';
}

function canStopInPhase(phase: RuntimePhase): boolean {
  return phase === 'starting' || phase === 'working' || phase === 'stopping';
}

function isRealProviderSessionId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('pending-');
}

function freshnessFromFacts(facts: RuntimeFacts, collectedAtMs: number): number | null {
  const lastEventAtMs = facts.seq?.lastEventAtMs;
  if (typeof lastEventAtMs !== 'number') return null;
  return Math.max(0, collectedAtMs - lastEventAtMs);
}

function summarizeDatabaseRaw(conversation: Conversation): Record<string, unknown> {
  return {
    conversationId: conversation.conversationId,
    latestProvider: conversation.latestProvider,
    latestSegmentId: conversation.latestSegmentId,
    segmentCount: conversation.segments.length,
    latestSegment: conversation.segments[conversation.segments.length - 1] ?? null,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function inferProvider(events: readonly SessionEvent[]): 'claude' | 'codex' {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'run:start') continue;
    const data = events[i].data as { config?: { extra?: { provider?: unknown } } };
    if (data.config?.extra?.provider === 'codex') return 'codex';
    return 'claude';
  }
  return 'claude';
}

function clampEventLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_EVENT_LIMIT;
  }
  return Math.min(Math.floor(value), MAX_EVENT_LIMIT);
}

function pickEventWindow(
  events: SessionEvent[],
  limit: number,
): {
  events: SessionEvent[];
  firstSeq: number | null;
  lastSeq: number | null;
  hasMoreBefore: boolean;
} {
  if (events.length === 0) {
    return { events: [], firstSeq: null, lastSeq: null, hasMoreBefore: false };
  }
  const start = Math.max(0, events.length - limit);
  const sliced = events.slice(start);
  return {
    events: sliced,
    firstSeq: sliced[0].seq,
    lastSeq: sliced[sliced.length - 1].seq,
    hasMoreBefore: start > 0,
  };
}

function summarize(
  primaryPhase: RuntimePhase,
  facts: ReturnType<typeof deriveRuntimeFactsFromHarnessEvents>,
  invariants: DiagnosticInvariantResult[],
): ConversationDiagnosticsSummary {
  let errorCount = 0;
  let warnCount = 0;
  let highest: DiagnosticSeverity = 'pass';
  for (const inv of invariants) {
    if (inv.severity === 'error') {
      errorCount += 1;
      highest = 'error';
    } else if (inv.severity === 'warn') {
      warnCount += 1;
      if (highest !== 'error') highest = 'warn';
    } else if (inv.severity === 'info' && highest === 'pass') {
      highest = 'info';
    }
  }
  const health: 'healthy' | 'degraded' | 'unhealthy' =
    errorCount > 0 ? 'unhealthy' : warnCount > 0 ? 'degraded' : 'healthy';
  return {
    health,
    highestSeverity: highest,
    errorCount,
    warnCount,
    primaryPhase,
    canSubmit: facts.canSubmit,
    processAlive: facts.processAlive,
    lastSeq: facts.seq?.lastSeq ?? null,
    lastEventType: facts.seq?.lastEventType ?? null,
    lastEventAtMs: facts.seq?.lastEventAtMs ?? null,
  };
}
