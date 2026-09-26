# Runtime Diagnostics and Authority Collapse Design

## Decision

Lattice’s runtime kernel is **`agent-ui-harness`**.

Specifically:

```txt
agent-ui-harness SessionManager + EventLog + protocol derivations
```

is the runtime authority.

Everything else is one of:

1. a command adapter into the harness,
2. a read projection from harness events,
3. an infrastructure liveness source,
4. a compatibility wrapper scheduled for deletion,
5. diagnostics.

We are **not** introducing a new `SessionRuntime` layer.

The architectural ratchet is mandatory:

> No new runtime abstraction may be introduced unless the same PR deletes or demotes an existing runtime authority.

Diagnostics are allowed because they are read-only and explicitly non-authoritative.

---

# 1. Diagnostics endpoint

## 1.1 Endpoint

Add:

```txt
GET /api/diagnostics/conversations/:conversationId
```

Query params:

```ts
interface ConversationDiagnosticsQuery {
  /**
   * Number of recent harness events to include as summaries.
   * Default: 80
   * Max: 500
   */
  eventLimit?: number;

  /**
   * Include raw event payloads.
   * Default: false
   * Requires raw diagnostics permission.
   */
  includeRawEvents?: boolean;

  /**
   * Include daemon stderr tail and argv.
   * Default: false
   * Requires raw diagnostics permission.
   */
  includeProcessDetails?: boolean;

  /**
   * Include legacy/source raw rows.
   * Default: false
   * Requires raw diagnostics permission.
   */
  includeRawSources?: boolean;
}
```

The endpoint is read-only. It must not mutate registry, DB rows, event storage, process state, or session state.

## 1.2 Access control

Diagnostics are sensitive because they can expose paths, process args, stderr, prompts, provider IDs, and message content.

Access rules:

```ts
function mayReadDiagnostics(req: Request): boolean {
  if (process.env.NODE_ENV === 'development' && isLoopback(req.ip)) {
    return true;
  }

  if (process.env.LATTICE_DIAGNOSTICS_ENABLED !== 'true') {
    return false;
  }

  return Boolean(req.user?.isAdmin);
}
```

Raw access is stricter:

```ts
function mayReadRawDiagnostics(req: Request): boolean {
  if (!mayReadDiagnostics(req)) return false;

  if (process.env.NODE_ENV === 'development' && isLoopback(req.ip)) {
    return true;
  }

  return (
    process.env.LATTICE_DIAGNOSTICS_RAW_ENABLED === 'true' &&
    Boolean(req.user?.isAdmin)
  );
}
```

Every successful request logs an audit event:

```ts
{
  event: 'diagnostics.conversation.read',
  conversationId,
  userId,
  rawIncluded: boolean,
  processDetailsIncluded: boolean,
  requestId
}
```

Default response redacts:

- message text,
- tool input payloads,
- stderr content,
- full cwd paths,
- full argv,
- environment variables,
- prompt text.

Default event summaries include event type, seq, timestamps, lifecycle reason, IDs, and payload size, but not content.

---

## 1.3 TypeScript interface

Create shared diagnostics types in:

```txt
agent-ui-harness/src/diagnostics/types.ts
```

Lattice-specific collectors live in:

```txt
src/diagnostics/
  conversation-diagnostics.routes.ts
  collect-conversation-diagnostics.ts
  runtime-facts-collectors.ts
  invariants/
```

### Source enum

```ts
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
```

### Runtime phase

```ts
export type RuntimePhase =
  | 'absent'
  | 'starting'
  | 'working'
  | 'stopping'
  | 'idle_alive'
  | 'idle_dead'
  | 'error';
```

Semantics:

| Phase | Meaning |
|---|---|
| `absent` | Source does not know this conversation/session. |
| `starting` | A process/run is being started, but the run is not ready/idle/working yet. |
| `working` | Agent is actively processing a turn. |
| `stopping` | Stop was requested and has not resolved. |
| `idle_alive` | No active turn; process/session is alive and can receive input. |
| `idle_dead` | No active process; conversation exists and can be resumed on next message. |
| `error` | Runtime is in an error state requiring recovery or user action. |

### RuntimeFacts

```ts
export interface RuntimeFacts {
  source: RuntimeFactSource;

  observedAtMs: number;

  ids: {
    conversationId: string;
    runId?: string | null;
    processId?: string | null;
    providerSessionId?: string | null;
    segmentId?: string | null;
  };

  seq?: {
    firstSeq?: number | null;
    lastSeq?: number | null;
    eventCount?: number;
    lastEventType?: string | null;
    lastEventAtMs?: number | null;
  };

  /**
   * This source knows the conversation/session exists.
   */
  sessionKnown: boolean;

  /**
   * This source has at least one stored/runtime event for the session.
   */
  hasEventHistory: boolean;

  phase: RuntimePhase;

  /**
   * There is a run:start not closed by run:end/run:error.
   * null means this source cannot know.
   */
  hasOpenRun: boolean | null;

  /**
   * OS/daemon/harness process is believed alive.
   * null means this source cannot know.
   */
  processAlive: boolean | null;

  /**
   * Agent is currently producing/processing a turn.
   */
  turnActive: boolean | null;

  /**
   * User can submit input now.
   *
   * In Lattice, mid-turn input is allowed and becomes pending input, so
   * `working` may still have canSubmit=true.
   */
  canSubmit: boolean | null;

  /**
   * Stop control should be available or is already in progress.
   */
  canStop: boolean | null;

  awaitingPermission: boolean | null;
  awaitingQuestion: boolean | null;
  hasRunningBackgroundTasks: boolean | null;
  scheduledWakeupPending: boolean | null;

  /**
   * Latest real provider resume/session ID is known and is not a pending-* placeholder.
   */
  resumeReady: boolean | null;

  /**
   * Transport-only facts. These are never runtime authority.
   */
  transportConnected?: boolean | null;
  hydrationPhase?: 'hydrating' | 'ready' | null;
}
```

### Source snapshot

```ts
export interface DiagnosticSourceSnapshot {
  source: RuntimeFactSource;

  available: boolean;

  /**
   * Source was sampled successfully.
   */
  ok: boolean;

  collectedAtMs: number;

  /**
   * Age of the source’s underlying data, not age of the diagnostics request.
   */
  freshnessMs?: number | null;

  stale: boolean;

  facts?: RuntimeFacts;

  /**
   * Redacted summary of the raw source.
   */
  summary?: Record<string, unknown>;

  /**
   * Raw source data. Only included with raw diagnostics permission.
   */
  raw?: unknown;

  errors?: Array<{
    code: string;
    message: string;
  }>;
}
```

### Invariant result

```ts
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
```

### Event summaries

```ts
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

  /**
   * Only included when includeRawEvents=true and raw access is allowed.
   */
  raw?: unknown;
}
```

### Full response

```ts
export interface ConversationDiagnosticsReport {
  schemaVersion: 'lattice.runtime-diagnostics.v1';

  generatedAtMs: number;

  request: {
    requestId: string;
    conversationId: string;
    eventLimit: number;
    includeRawEvents: boolean;
    includeProcessDetails: boolean;
    includeRawSources: boolean;
  };

  access: {
    mode: 'development-loopback' | 'admin';
    redaction: 'redacted' | 'raw';
    rawAllowed: boolean;
  };

  identity: {
    conversationId: string;

    segmentId?: string | null;
    runId?: string | null;
    processId?: string | null;
    providerSessionId?: string | null;

    cwd?: string | null;
    cwdHash?: string | null;

    provider: 'claude';
  };

  summary: {
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
  };

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
```

---

## 1.4 Source collectors

Diagnostics collects facts from these sources.

### `harness_events`

Authoritative anchor when event history exists.

Uses:

- persisted harness events,
- in-memory event log where available,
- `deriveStatus`,
- `deriveProcessAlive`,
- background task derivation,
- pending permission/question derivation.

Derivation:

```ts
function deriveRuntimeFactsFromHarnessEvents(
  conversationId: string,
  events: SessionEvent[],
): RuntimeFacts {
  const status = deriveStatus(events);
  const processAlive = deriveProcessAlive(events);

  const phase: RuntimePhase =
    events.length === 0
      ? 'absent'
      : status === 'starting'
        ? 'starting'
        : status === 'streaming'
          ? 'working'
          : status === 'stopping'
            ? 'stopping'
            : status === 'error'
              ? 'error'
              : processAlive
                ? 'idle_alive'
                : 'idle_dead';

  return {
    source: 'harness_events',
    observedAtMs: Date.now(),
    ids: { conversationId, providerSessionId: latestRunReadyResumeId(events) },
    seq: summarizeSeq(events),
    sessionKnown: events.length > 0,
    hasEventHistory: events.length > 0,
    phase,
    hasOpenRun: hasOpenRun(events),
    processAlive,
    turnActive: status === 'streaming',
    canSubmit: phase !== 'absent' && phase !== 'starting' && phase !== 'stopping' && phase !== 'error',
    canStop: phase === 'starting' || phase === 'working' || phase === 'stopping',
    awaitingPermission: deriveAwaitingPermission(events),
    awaitingQuestion: deriveAwaitingQuestion(events),
    hasRunningBackgroundTasks: deriveBackgroundTasks(events).some(t => t.status === 'running'),
    scheduledWakeupPending: deriveScheduledWakeup(events) != null,
    resumeReady: hasRealLatestResumeId(events),
  };
}
```

### `harness_manager`

Uses `SessionManager.inspect()`.

It may know process handle, subscribers, in-memory status, resume ID, hydration/replay metadata.

It is not the anchor over persisted events. It is checked against the event-derived view.

### `daemon`

Uses daemon process table.

It may know:

- process ID,
- OS PID,
- alive/dead,
- cwd,
- startedAt,
- stderr tail,
- argv.

It generally cannot know `turnActive`, `awaitingPermission`, transcript status, or `canSubmit`.

### `active_registry`

Kept only while the registry exists. It is treated as a legacy source.

It must never be used by diagnostics as the anchor.

### `database`

Reads:

- conversation row,
- segment row,
- provider session ID,
- archived/deleted metadata,
- DB segment status while it still exists.

DB segment runtime status is legacy data. Diagnostics compares it to harness facts.

### `public_status`

Calls the same code path used by:

```txt
api.getSessionsStatus()
```

This is important. Diagnostics must catch when the user-facing status endpoint disagrees with the harness.

### Client facts

The server endpoint does not require client facts.

The browser debug panel may enrich the report locally with:

- `client_harness`,
- `client_status_poll`,
- `composer`.

Add a small client helper:

```ts
window.__latticeDebug.getConversationRuntimeFacts(conversationId): RuntimeFacts[]
```

The browser diagnostics panel fetches:

```txt
GET /api/diagnostics/conversations/:conversationId
```

then evaluates client-only invariants in the browser using the same invariant functions.

Client facts are not posted to the server by default. This avoids turning diagnostics into another telemetry pipeline.

---

# 2. Invariants

## 2.1 Invariant: `runtime_authority_consensus`

### Purpose

Detect user-visible runtime disagreement.

This is the primary invariant.

It compares normalized `RuntimeFacts`, not raw status strings.

### Anchor

Use this order:

1. `harness_events`, if available and non-empty.
2. `harness_manager`, if no persisted event history exists yet.
3. `database`, only for an unstarted newly-created conversation.

### Compared sources

- `harness_events`
- `harness_manager`
- `daemon`
- `public_status`
- `database`
- `active_registry`
- optional client facts

### Fields compared

- `sessionKnown`
- `phase`
- `hasOpenRun`
- `processAlive`
- `turnActive`
- `canSubmit`
- `canStop`
- `awaitingPermission`
- `awaitingQuestion`
- `hasRunningBackgroundTasks`
- `resumeReady`

### Grace windows

| Field | Grace |
|---|---:|
| Server/public phase after `run:start` | 1s |
| Server/public phase after `content`, `result`, `input:sent` | 1s |
| Server/public phase after `turn:end` | 1s |
| Client harness phase | 750ms |
| Client status poll phase | 6s |
| `processAlive` after `run:end` / `run:error` | 1s |
| `stop:requested` visibility | 500ms |
| Permission active visibility, server | 0ms |
| Permission active visibility, client | 3s |
| Permission idle polling visibility, client | 11s |
| Background task active/clear | 1s |
| Provider resume ID after `run:ready` | warn after 2s, error after 10s |

### Failure example

```json
{
  "id": "runtime_authority_consensus",
  "severity": "error",
  "ok": false,
  "title": "Runtime authorities disagree",
  "summary": "Harness events show an idle live process, but public status and database show a dead/completed session.",
  "anchorSource": "harness_events",
  "disagreements": [
    {
      "field": "phase",
      "source": "public_status",
      "value": "idle_dead",
      "expected": "idle_alive",
      "ageMs": 4300,
      "graceMs": 1000
    },
    {
      "field": "processAlive",
      "source": "public_status",
      "value": false,
      "expected": true,
      "ageMs": 4300,
      "graceMs": 1000
    }
  ],
  "likelyBugClass": "stale public runtime projection",
  "remediation": "Make public status derive from harness events and process liveness."
}
```

---

## 2.2 Invariant: `single_live_run`

### Rule

For one conversation, there must be at most one live run/process.

Checks:

- event log has at most one open `run:start` not closed by `run:end` / `run:error`;
- `SessionManager.inspect()` has at most one active process;
- daemon process table has at most one process for the conversation;
- registry, if present, has at most one active entry.

### Grace

- warn after 500ms,
- error after 2s.

### Severity

`error`.

---

## 2.3 Invariant: `daemon_manager_process_consistency`

### Rule

If harness manager says process is alive, daemon must know that process.

If daemon has a live process for the conversation, harness manager must know it or explain handoff/recovery.

### Grace

1s.

### Severity

`warn` after 1s, `error` after 5s.

---

## 2.4 Invariant: `seq_integrity`

### Rule

For a single conversation/session event stream:

- no duplicate seq numbers,
- no gaps,
- monotonic seq ordering,
- if a storage reset/window exists, it must be explicitly marked.

### Grace

0ms.

### Severity

`error`.

This invariant must be noiseless. Any failure is a real protocol/storage bug.

---

## 2.5 Invariant: `resume_id_consistency`

### Rule

After a real `run:ready` with a provider resume ID:

- latest `run:ready.resumeId`,
- DB `provider_session_id`,
- `SessionManager` resume ID,
- next spawn resume ID,

must agree.

No `pending-*` value is allowed after `run:ready`.

### Grace

- warn after 2s,
- error after 10s.

### Severity

`error`.

---

## 2.6 Invariant: `event_recovery_visibility`

### Rule

After server restart/recovery:

- stored renderable events must remain visible through `since(0)` / initial replay;
- inferred recovery lifecycle events must not hide prior stored content;
- if an inferred `run:end` is appended during recovery, it must have seq greater than prior events.

### Grace

0ms for ordering and visibility.

### Severity

`error`.

---

## 2.7 Invariant: `stop_semantics`

### Rule

After `stop:requested`:

1. status should become `stopping` within 500ms;
2. if `turn:end` arrives, status should become idle/ready;
3. a later force-kill must not happen unless a new escalation event exists;
4. partial assistant output remains visible.

### Grace

| Condition | Grace |
|---|---:|
| stop visible as `stopping` | 500ms |
| stuck stopping warning | 6s |
| stuck stopping error | 10s |
| force-kill after clean `turn:end` | 0ms |

### Severity

`warn` or `error`.

---

## 2.8 Invariant: `sse_reconnect_no_duplicates`

### Rule

Client event delivery must be seq-idempotent.

Checks when client facts are present:

- client last seq is monotonic;
- no duplicate delivered seqs after reconnect;
- only one active SSE loop per session/browser consumer.

Server-side diagnostics can check subscriber counts. Client-side diagnostics checks delivered seq history.

### Grace

0ms for duplicate seq delivery.

### Severity

`error`.

---

## 2.9 Invariant: `hydration_completion`

### Rule

A client should not stay hydrating indefinitely.

If replay is scoped, proactive history fetch must begin.

Historical events must not be animated as live.

### Grace

| Condition | Grace |
|---|---:|
| hydration warning | 15s |
| hydration error | 30s |
| scoped replay backfill start | 1s |

### Severity

`warn` / `error`.

Skipped when client facts are absent.

---

## 2.10 Invariant: `pending_message_injection`

### Rule

If `input:sent` occurs during an active assistant turn:

- it is either pending,
- or it has been consumed into render order before the consuming event.

At `turn:end`, no pending input from that turn may remain unresolved.

### Grace

0ms after `turn:end`.

### Severity

`error`.

---

## 2.11 Invariant: `permission_question_visibility`

### Rule

Pending permission/question state derived from harness events must match server trackers and client-visible UI.

### Grace

| Source | Grace |
|---|---:|
| server pending tracker | 0ms |
| active client | 3s |
| idle/polling client | 11s |

### Severity

`warn` / `error`.

---

## 2.12 Invariant: `background_task_consensus`

### Rule

Background task state derived from harness events must match client/public projections.

On `run:end`, background tasks must clear unless explicitly detached.

### Grace

1s.

### Severity

`warn`.

---

# 3. Grace-window policy

Use these global freshness rules:

| Source | Stale after |
|---|---:|
| server diagnostics sample | never stale inside request |
| harness event storage | never stale if read succeeded |
| daemon process table | 1s |
| public status sampled during diagnostics | 1s |
| client harness snapshot | 2s |
| client status poll snapshot | 7s |
| composer snapshot | 2s |

If a source is stale, diagnostics reports it but does not fail consensus against it.

Client disagreements from hidden/background tabs are downgraded to `info` or `warn`.

---

# 4. Example responses

## 4.1 Healthy

```json
{
  "schemaVersion": "lattice.runtime-diagnostics.v1",
  "generatedAtMs": 1730000000000,
  "request": {
    "requestId": "req_123",
    "conversationId": "conv_abc",
    "eventLimit": 80,
    "includeRawEvents": false,
    "includeProcessDetails": false,
    "includeRawSources": false
  },
  "access": {
    "mode": "admin",
    "redaction": "redacted",
    "rawAllowed": false
  },
  "identity": {
    "conversationId": "conv_abc",
    "segmentId": "seg_1",
    "runId": null,
    "processId": "proc_789",
    "providerSessionId": "claude-session-uuid",
    "cwdHash": "cwd_41e2",
    "provider": "claude"
  },
  "summary": {
    "health": "healthy",
    "highestSeverity": "pass",
    "errorCount": 0,
    "warnCount": 0,
    "primaryPhase": "idle_alive",
    "canSubmit": true,
    "processAlive": true,
    "lastSeq": 184,
    "lastEventType": "turn:end",
    "lastEventAtMs": 1729999999000
  },
  "sources": {
    "harness_events": {
      "source": "harness_events",
      "available": true,
      "ok": true,
      "collectedAtMs": 1730000000000,
      "freshnessMs": 1000,
      "stale": false,
      "facts": {
        "source": "harness_events",
        "observedAtMs": 1730000000000,
        "ids": {
          "conversationId": "conv_abc",
          "processId": "proc_789",
          "providerSessionId": "claude-session-uuid",
          "segmentId": "seg_1"
        },
        "seq": {
          "firstSeq": 1,
          "lastSeq": 184,
          "eventCount": 184,
          "lastEventType": "turn:end",
          "lastEventAtMs": 1729999999000
        },
        "sessionKnown": true,
        "hasEventHistory": true,
        "phase": "idle_alive",
        "hasOpenRun": true,
        "processAlive": true,
        "turnActive": false,
        "canSubmit": true,
        "canStop": false,
        "awaitingPermission": false,
        "awaitingQuestion": false,
        "hasRunningBackgroundTasks": false,
        "scheduledWakeupPending": false,
        "resumeReady": true
      }
    },
    "public_status": {
      "source": "public_status",
      "available": true,
      "ok": true,
      "collectedAtMs": 1730000000000,
      "freshnessMs": 0,
      "stale": false,
      "facts": {
        "source": "public_status",
        "observedAtMs": 1730000000000,
        "ids": {
          "conversationId": "conv_abc",
          "providerSessionId": "claude-session-uuid"
        },
        "sessionKnown": true,
        "hasEventHistory": true,
        "phase": "idle_alive",
        "hasOpenRun": true,
        "processAlive": true,
        "turnActive": false,
        "canSubmit": true,
        "canStop": false,
        "awaitingPermission": false,
        "awaitingQuestion": false,
        "hasRunningBackgroundTasks": false,
        "scheduledWakeupPending": false,
        "resumeReady": true
      }
    }
  },
  "invariants": [
    {
      "id": "runtime_authority_consensus",
      "severity": "pass",
      "ok": true,
      "checkedAtMs": 1730000000000,
      "title": "Runtime authorities agree",
      "summary": "Harness, public status, daemon, database, and registry agree on runtime facts.",
      "anchorSource": "harness_events"
    },
    {
      "id": "resume_id_consistency",
      "severity": "pass",
      "ok": true,
      "checkedAtMs": 1730000000000,
      "title": "Resume ID is consistent",
      "summary": "Latest run:ready resume ID matches database and manager state."
    }
  ],
  "events": {
    "window": {
      "limit": 80,
      "returned": 80,
      "firstSeq": 105,
      "lastSeq": 184,
      "hasMoreBefore": true
    },
    "items": [
      {
        "seq": 183,
        "type": "result",
        "timestampMs": 1729999998500,
        "role": "assistant",
        "payloadBytes": 812
      },
      {
        "seq": 184,
        "type": "turn:end",
        "timestampMs": 1729999999000,
        "payloadBytes": 52
      }
    ]
  },
  "recommendations": []
}
```

## 4.2 Unhealthy

```json
{
  "schemaVersion": "lattice.runtime-diagnostics.v1",
  "generatedAtMs": 1730000100000,
  "request": {
    "requestId": "req_456",
    "conversationId": "conv_bad",
    "eventLimit": 80,
    "includeRawEvents": false,
    "includeProcessDetails": false,
    "includeRawSources": false
  },
  "access": {
    "mode": "admin",
    "redaction": "redacted",
    "rawAllowed": false
  },
  "identity": {
    "conversationId": "conv_bad",
    "segmentId": "seg_9",
    "runId": null,
    "processId": "proc_live",
    "providerSessionId": "pending-conv_bad",
    "cwdHash": "cwd_902a",
    "provider": "claude"
  },
  "summary": {
    "health": "unhealthy",
    "highestSeverity": "error",
    "errorCount": 2,
    "warnCount": 1,
    "primaryPhase": "working",
    "canSubmit": true,
    "processAlive": true,
    "lastSeq": 73,
    "lastEventType": "content",
    "lastEventAtMs": 1730000096200
  },
  "sources": {
    "harness_events": {
      "source": "harness_events",
      "available": true,
      "ok": true,
      "collectedAtMs": 1730000100000,
      "freshnessMs": 3800,
      "stale": false,
      "facts": {
        "source": "harness_events",
        "observedAtMs": 1730000100000,
        "ids": {
          "conversationId": "conv_bad",
          "processId": "proc_live",
          "providerSessionId": "claude-real-resume-id",
          "segmentId": "seg_9"
        },
        "seq": {
          "firstSeq": 1,
          "lastSeq": 73,
          "eventCount": 73,
          "lastEventType": "content",
          "lastEventAtMs": 1730000096200
        },
        "sessionKnown": true,
        "hasEventHistory": true,
        "phase": "working",
        "hasOpenRun": true,
        "processAlive": true,
        "turnActive": true,
        "canSubmit": true,
        "canStop": true,
        "awaitingPermission": false,
        "awaitingQuestion": false,
        "hasRunningBackgroundTasks": false,
        "scheduledWakeupPending": false,
        "resumeReady": true
      }
    },
    "public_status": {
      "source": "public_status",
      "available": true,
      "ok": true,
      "collectedAtMs": 1730000100000,
      "freshnessMs": 0,
      "stale": false,
      "facts": {
        "source": "public_status",
        "observedAtMs": 1730000100000,
        "ids": {
          "conversationId": "conv_bad",
          "providerSessionId": "pending-conv_bad"
        },
        "sessionKnown": true,
        "hasEventHistory": true,
        "phase": "idle_dead",
        "hasOpenRun": false,
        "processAlive": false,
        "turnActive": false,
        "canSubmit": true,
        "canStop": false,
        "awaitingPermission": false,
        "awaitingQuestion": false,
        "hasRunningBackgroundTasks": false,
        "scheduledWakeupPending": false,
        "resumeReady": false
      }
    }
  },
  "invariants": [
    {
      "id": "runtime_authority_consensus",
      "severity": "error",
      "ok": false,
      "checkedAtMs": 1730000100000,
      "title": "Runtime authorities disagree",
      "summary": "Harness events show a working live process, but public status reports idle/dead.",
      "anchorSource": "harness_events",
      "disagreements": [
        {
          "field": "phase",
          "source": "public_status",
          "value": "idle_dead",
          "expected": "working",
          "ageMs": 3800,
          "graceMs": 1000
        },
        {
          "field": "processAlive",
          "source": "public_status",
          "value": false,
          "expected": true,
          "ageMs": 3800,
          "graceMs": 1000
        }
      ],
      "likelyBugClass": "public status is still reading legacy registry/database state",
      "remediation": "Route public status through harness-derived RuntimeFacts."
    },
    {
      "id": "resume_id_consistency",
      "severity": "error",
      "ok": false,
      "checkedAtMs": 1730000100000,
      "title": "Resume ID is inconsistent",
      "summary": "Latest run:ready has a real provider resume ID, but database still has a pending-* placeholder.",
      "disagreements": [
        {
          "field": "providerSessionId",
          "source": "database",
          "value": "pending-conv_bad",
          "expected": "claude-real-resume-id",
          "ageMs": 14000,
          "graceMs": 10000
        }
      ],
      "likelyBugClass": "run:ready side effect did not propagate to conversation segment",
      "remediation": "Update provider_session_id only from latest run:ready; remove pending-* placeholders."
    }
  ],
  "events": {
    "window": {
      "limit": 80,
      "returned": 73,
      "firstSeq": 1,
      "lastSeq": 73,
      "hasMoreBefore": false
    },
    "items": [
      {
        "seq": 71,
        "type": "run:ready",
        "timestampMs": 1730000085000,
        "ids": {
          "providerSessionId": "claude-real-resume-id",
          "processId": "proc_live"
        },
        "payloadBytes": 98
      },
      {
        "seq": 72,
        "type": "input:sent",
        "timestampMs": 1730000090000,
        "role": "user",
        "payloadBytes": 121
      },
      {
        "seq": 73,
        "type": "content",
        "timestampMs": 1730000096200,
        "role": "assistant",
        "payloadBytes": 508
      }
    ]
  },
  "recommendations": [
    {
      "severity": "error",
      "message": "Public status is not harness-derived for this conversation.",
      "action": "Ship authority-collapse move 4."
    }
  ]
}
```

---

# 5. Authority-collapse sequence

The end state:

```txt
Runtime authority:
  agent-ui-harness SessionManager + EventLog + protocol derivations

Lattice server:
  product commands and DB metadata
  no independent runtime state machine

Daemon:
  process owner only

Database:
  durable metadata and historical event storage
  not live runtime authority

Frontend:
  renders harness-derived facts
  status polling is sidebar transport only, not detail-view authority
```

## Move 1 — Make harness recovery trustworthy

### Changes

Fix two protocol/storage correctness issues before using harness facts as the anchor everywhere.

1. Replace tail-window resume recovery with an indexed latest-`run:ready` query.
2. Fix `RunEndData.reason` protocol drift by adding `server_restart` to the protocol.

### Deletes/demotes

- Delete the “read last N events and hope `run:ready` is present” resume path.
- Delete any `as any` / `unknown` append for recovery `run:end`.

### Invariants guarding the move

- `resume_id_consistency`
- `event_recovery_visibility`
- `seq_integrity`

### Rollback

Revert the PR. The change is local to harness recovery and protocol typing.

No runtime dual path is kept.

---

## Move 2 — Delete half-supported Codex

### Changes

Remove Codex as a supported runtime path.

### Deletes/demotes

Delete:

- Codex config fields,
- Codex executable discovery,
- Codex spawn args,
- Codex stdout/stdin parsing,
- Codex thread ID logic,
- `defaultProvider: 'codex'`,
- `crossSessionInvestigationProvider: 'codex'`,
- dead provider branching that can never complete in `/api/conv`.

Keep the public API strict:

```ts
if (body.provider && body.provider !== 'claude') {
  return res.status(400).json({
    error: 'unsupported_provider',
    supportedProviders: ['claude'],
  });
}
```

### Invariants guarding the move

- `runtime_authority_consensus`
- `single_live_run`

### Rollback

Revert the PR if there is real Codex usage.

Before shipping, run a migration preflight:

```sql
SELECT provider, COUNT(*)
FROM conversation_segments
GROUP BY provider;
```

If non-Claude rows exist, archive/report them before merge.

### Rationale

The codebase evidence says Codex is not product-supported:

- config advertises it,
- daemon partially implements it,
- conversation service says only Claude,
- routes only handle Claude.

That is worse than no Codex.

Formalizing ProviderDriver now would be speculative architecture. Delete Codex. Reintroduce it later only with a full product requirement and behavioral tests.

---

## Move 3 — Consolidate diagnostics, retire old debug surfaces, add SQLite instrumentation

### Decision

This move is not “add one more diagnostics endpoint.”

It is:

> Replace the current debug-surface sprawl with one diagnostics system and one invariant engine.

Canonical diagnostics namespace:

```txt
GET /api/diagnostics/conversations/:conversationId
GET /api/diagnostics/runtime-reconciliation
```

The first is per-conversation.  
The second is the aggregate replacement for current state reconciliation / active-session debug views.

Old debug route paths may remain temporarily as thin compatibility wrappers, but their collectors must be deleted or delegated. No old endpoint may continue to compute its own separate version of runtime truth.

### Aggregate reconciliation endpoint

Add:

```txt
GET /api/diagnostics/runtime-reconciliation
```

Query params:

```ts
interface RuntimeReconciliationQuery {
  activeOnly?: boolean;       // default true
  recentMinutes?: number;     // default 60
  limit?: number;             // default 100, max 500
  includeRawSources?: boolean;
}
```

Response shape:

```ts
interface RuntimeReconciliationReport {
  schemaVersion: 'lattice.runtime-reconciliation.v1';
  generatedAtMs: number;

  scope: {
    activeOnly: boolean;
    recentMinutes: number;
    limit: number;
  };

  summary: {
    health: 'healthy' | 'degraded' | 'unhealthy';
    conversationCount: number;
    unhealthyCount: number;
    degradedCount: number;
    highestSeverity: DiagnosticSeverity;
  };

  conversations: Array<{
    conversationId: string;
    health: 'healthy' | 'degraded' | 'unhealthy';
    primaryPhase: RuntimePhase;
    highestSeverity: DiagnosticSeverity;
    errorCount: number;
    warnCount: number;
    lastSeq?: number | null;
    lastEventType?: string | null;
    invariants: DiagnosticInvariantResult[];
    links: {
      diagnostics: string;
    };
  }>;

  sourceCounts: Partial<Record<RuntimeFactSource, {
    available: number;
    unavailable: number;
    errored: number;
  }>>;
}
```

This endpoint uses the same collectors and invariant engine as the per-conversation report.

### Existing debug surface disposition

| Existing surface | Disposition |
|---|---|
| `/api/debug/sessions/:id/diagnostic` | Subsumed by `GET /api/diagnostics/conversations/:conversationId`. Temporary wrapper resolves session/conversation ID, calls the new collector, and returns either the new shape or a compatibility projection. Delete old collector. |
| `/api/debug/state-reconciliation` | Subsumed by `GET /api/diagnostics/runtime-reconciliation`. Temporary wrapper only. Delete old reconciliation logic. |
| `/api/debug/active-sessions` | Subsumed by aggregate diagnostics summary. Temporary wrapper only. |
| `/api/debug/sessions/:id/harness-snapshot` | Subsumed by `sources.harness_events` and `events` in the conversation diagnostics report. Temporary wrapper only. |
| `/api/timeline/:conversationId` | Timeline survives as a projection, not as a separate authority. Expose it as a `timeline` section inside conversation diagnostics. If product/dev UI still calls `/api/timeline`, keep the route as a delegating wrapper to the same projection. |
| `/api/debug/conversations/:id/switch-history` | Subsumed as optional `switchHistory` diagnostic section. Keep behind diagnostics access control. Temporary wrapper only if still used. |
| `/api/debug/conversations/:id/message-linkage` | Subsumed as optional `messageLinkage` diagnostic section. Temporary wrapper only if still used. |

Temporary wrappers must include deprecation metadata:

```txt
Deprecation: true
X-Lattice-Diagnostics-Canonical: /api/diagnostics/...
```

### CLI disposition

Update:

```txt
pnpm -s diag:agent
pnpm -s diag:agent:session
```

to consume the new diagnostics namespace.

Mapping:

| CLI | New backing endpoint |
|---|---|
| `diag:agent` | `/api/diagnostics/runtime-reconciliation` |
| `diag:agent:session` | `/api/diagnostics/conversations/:conversationId` |

The CLI may preserve its human-readable output, but the JSON source of truth is the new diagnostics report.

### Implementation constraint

Do not keep duplicate collectors.

Allowed:

```txt
old route -> id normalization -> new diagnostics collector -> compatibility projection
```

Not allowed:

```txt
old route -> old collector
new route -> new collector
```

### SQLite instrumentation

Keep the named SQLite instrumentation from the prior design unchanged.

This move still adds slow-op visibility for:

```txt
harness_events.write
harness_events.read_window
harness_events.find_latest_run_ready
conversation.status.bulk
diagnostics.collect_sources
```

### Deletes/demotes

- Delete old state-reconciliation collector logic.
- Delete old session diagnostic collector logic.
- Delete standalone harness-snapshot collector logic.
- Keep `SessionTimeline` only as a projection feeding diagnostics or a delegating route.

### Rollback

Diagnostics can be disabled with:

```txt
LATTICE_DIAGNOSTICS_ENABLED=false
```

But old debug collectors should not be resurrected unless the whole move is reverted.

---

## Move 4 — Make public status harness-derived and update project doctrine

### Decision

This move intentionally overturns the existing documented invariant:

> “Session status comes from polling.”

That doctrine was useful when the main risk was local frontend heuristics. It is now too imprecise and reinforces the wrong authority boundary.

New doctrine:

> Runtime status comes from harness-derived `RuntimeFacts`. Polling is only a transport/cache mechanism for those facts.

### Documentation requirement

The same PR must update `CLAUDE.md`.

Replace the current invariant with:

```md
#### Session status is harness-derived; polling is transport

- Runtime facts come from `agent-ui-harness` events and protocol derivations.
- `GET /api/sessions/status` is a polling transport/cache for those facts.
- `useSessionStatus` may be used by sidebar/list surfaces, but it is not an independent runtime authority.
- Detail views that already have `useHarnessSession` should use harness-derived facts directly.
- Do not derive public runtime status from component-local heuristics, `ActiveConversationRegistry`, DB segment status, daemon maps alone, or JSONL activity.
```

### Route disposition

`GET /api/sessions/status` survives.

It is not replaced by a new bulk endpoint. Its implementation changes.

All public status surfaces should use the same internal function:

```ts
getRuntimeFactsForConversation(conversationId): RuntimeFacts
getRuntimeFactsForConversations(conversationIds): Map<ConversationId, RuntimeFacts>
```

Affected public routes:

```txt
GET /api/sessions/status
GET /api/conv/:conversationId/status
any bulk status endpoint currently used by ConversationsContext/useSessionStatus
```

They preserve compatibility response shapes where necessary, but the source is harness-derived facts.

### Mapping rule

`idle_dead` must not mean “completed/unusable.”

Compatibility mapping:

```ts
function publicStatusFromRuntimeFacts(facts: RuntimeFacts): PublicSessionStatus {
  switch (facts.phase) {
    case 'starting':
    case 'working':
    case 'stopping':
      return {
        status: 'ongoing',
        phase: facts.phase,
        canSubmit: facts.canSubmit,
        canStop: facts.canStop,
        processAlive: facts.processAlive,
      };

    case 'idle_alive':
    case 'idle_dead':
      return {
        status: 'idle',
        phase: facts.phase,
        canSubmit: true,
        canStop: false,
        processAlive: facts.processAlive,
      };

    case 'error':
      return {
        status: 'completed',
        phase: 'error',
        canSubmit: false,
        canStop: false,
        processAlive: facts.processAlive,
      };

    case 'absent':
      return {
        status: 'pending',
        phase: 'absent',
        canSubmit: false,
        canStop: false,
        processAlive: false,
      };
  }
}
```

### Deletes/demotes

- Stop using `findRuntimeActiveSegment()` as public runtime status authority.
- Stop using `ActiveConversationRegistry` as public runtime status authority.
- Stop using DB segment status as public runtime status authority.
- Keep polling for sidebar/list transport only.

### Invariants guarding the move

- `runtime_authority_consensus`
- `daemon_manager_process_consistency`
- `resume_id_consistency`

### Rollback

Revert the PR.

Do not add a long-lived feature flag that lets old and new public status authorities coexist.

---

## Move 5 — Rework `POST /resume` into the single existing-conversation input command

### Decision

Do **not** add:

```txt
POST /api/conv/:conversationId/messages
```

in this migration.

The canonical existing-conversation input route remains:

```txt
POST /api/conv/:conversationId/resume
```

But its semantics are reworked.

It becomes:

> “Submit user input to an existing conversation, starting/resuming a run if necessary, independent of SSE connection state.”

The internal implementation may be named `submitConversationInput`, `continueConversationWithInput`, or similar. But the public route stays `/resume`.

### Route semantics

`POST /api/conv/:conversationId/resume` must be:

1. **Transport-independent**  
   It never depends on whether the browser has an active SSE connection.

2. **Idempotent for first-party clients**  
   The first-party client should send:

   ```ts
   clientMessageId: string
   ```

   or:

   ```ts
   idempotencyKey: string
   ```

   Existing clients without this field may be accepted temporarily, but new Composer code should always send one.

3. **Phase-aware**

   Behavior by `RuntimeFacts.phase`:

   | Phase | Behavior |
   |---|---|
   | `idle_alive` | Send input to existing live process. |
   | `idle_dead` | Start/resume a process using latest real `run:ready.resumeId`, then deliver input. |
   | `working` | Accept as mid-turn/pending input through the harness path. |
   | `starting` | Queue/hold for delivery after ready, using the same harness command path. |
   | `stopping` | Reject with `409 stopping`. |
   | `error` | Reject with recoverable error unless explicit recovery semantics exist. |
   | `absent` | `404 conversation_not_found`. |

4. **Harness-mediated**  
   It must call harness/session-manager command APIs. It must not independently write runtime state to registry or DB segment status.

### Input route disposition

| Route | Disposition |
|---|---|
| `POST /api/conv/create` | Remains the only new-conversation creation route. |
| `POST /api/conv/:conversationId/resume` | Becomes the single product route for existing-conversation user input. |
| `POST /api/conv/:conversationId/inject` | Must not remain an independent product input path. If it represents user mid-turn input, make it a temporary wrapper around the same `/resume` command and then delete it after callers migrate. If it represents debug/provider-stdin injection, move it under `/api/debug/...`, guard it as diagnostics/debug-only, and keep it out of product Composer flows. |
| `POST /api/conv/:conversationId/queue` | May remain only for explicit queue management. It must not be a third way for Composer to submit immediate user input, and it must not own runtime authority. |

### Frontend changes

Composer should always submit existing-conversation input to:

```txt
POST /api/conv/:conversationId/resume
```

Delete branches of this shape:

```ts
if (harnessConnected) {
  await send(...);
} else {
  await startOrResume(...);
}
```

SSE connection state is transport health only. It does not decide whether a session exists.

Delete derived facts like:

```ts
isSessionConnected = processAlive || sessionStatus.isIdle;
```

The Composer should use:

```txt
harness RuntimeFacts -> deriveComposerRuntimeView()
```

for display and enablement.

### `/inject` migration rule

During migration, `/inject` may exist only as:

```txt
/inject -> normalize request -> submitConversationInput(..., { placement: 'mid_turn_compat' })
```

It must not:

- append separate runtime events,
- mutate registry state,
- mutate DB segment runtime status,
- bypass harness event derivation,
- be called by first-party Composer after migration.

Add deprecation logging for any remaining `/inject` product caller.

### Deletes/demotes

- Delete frontend `harnessConnected`-as-session-existence branching.
- Delete independent `/inject` product semantics.
- Delete route-local start/send branching based on transport state.
- Do not add `/messages` while `/resume` and `/inject` exist.

### Invariants guarding the move

- `pending_message_injection`
- `resume_id_consistency`
- `runtime_authority_consensus`
- `stop_semantics`

### Rollback

Rollback restores old `/resume` behavior.

Do not introduce a parallel `/messages` implementation as rollback insurance.

---

## Move 6 — Delete `ActivityStreamContext` with explicit consumer dispositions

### Decision

Delete `ActivityStreamContext`, but only after replacing all consumers.

The context is inert, so removing it is not a runtime behavior regression. However, the consumers are semantically important and must be migrated deliberately.

### Consumer disposition table

| Consumer family | Current dependency | Disposition |
|---|---|---|
| `TeamColorContext` | Subscribes to `{ type: 'activity' }` | Remove subscription. Team color assignment should be deterministic or based on team/member query state. If it also shows presence/activity, use `useTeamStatus` polling after that hook is made polling-only. |
| `ConversationsContext` | Main activity subscription | Remove subscription. Continue using React Query and bulk status polling via `GET /api/sessions/status`, which becomes harness-derived in Move 4. Mutations should invalidate relevant conversation/status queries directly. |
| `useSessionStatus` | Subscribes to activity for invalidation | Remove subscription. Make it a pure React Query polling hook with visibility/focus refetch. It remains acceptable for sidebar/list surfaces, but `ConversationView` should stop depending on it later. |
| `useTeamStatus` | Subscribes to activity | Remove subscription. Make it polling/query-driven. API health should move to a separate `useApiHealth` polling hook if needed. |
| `InsightsPanel` | Handles turn captured, current work, current work clear, API health | Split by semantic: turn-captured invalidation comes from harness events or a harness-derived insights projection; current work/current work clear comes from a query/projection whose absence clears state; API health moves to `useApiHealth` polling. Do not preserve these as ActivityStream events. |
| `CrossSessionAnalysisPage` | Subscribes to activity/global events | Replace with analysis/job-status polling while analysis is pending/running. Mutations should invalidate/refetch their own job/query keys. No ActivityStream dependency. |

### InsightsPanel detailed disposition

The four handlers move as follows:

| Handler | Replacement |
|---|---|
| `turn captured` | For current conversation, listen to harness events/projections and invalidate the insights query on `turn:end` / captured-turn projection update. For cross-conversation panels, poll the relevant insights summary endpoint while visible. |
| `current work` | Read from a harness-derived current-work projection/query. Refetch while panel is visible and conversation is active. |
| `current work clear` | Do not model as an event. Clear when the current-work projection returns empty or when harness facts show terminal/idle state as appropriate. |
| `API health` | Move to `useApiHealth` polling. It is not conversation activity. |

If the required projection endpoint does not exist, add the smallest query endpoint needed for the panel. Do not recreate a generic frontend event bus.

### Deletion sequence

1. Replace each consumer with its new query/projection path.
2. Add tests or type checks proving no imports remain.
3. Delete:

   ```txt
   ActivityStreamProvider
   ActivityStreamContext
   useActivityStreamSubscription
   ```

4. Remove app-level provider wiring.

### Future realtime sidebar rule

If realtime sidebar/list updates are later needed, implement them as a harness-derived projection or SSE stream under the diagnostics/runtime projection model.

Do not resurrect `ActivityStreamContext`.

### Invariants guarding the move

- `runtime_authority_consensus`
- `sse_reconnect_no_duplicates`

### Rollback

Revert the consumer migration PR.

Do not keep the inert context as a compatibility shell after consumers are migrated.

---

## Move 7 — Demote `ActiveConversationRegistry`

### Changes

Make `ActiveConversationRegistry` a cache/projection only.

It may answer:

- “which conversations had recent activity?”
- “which process IDs are currently known from harness manager?”

It may not answer:

- public runtime status,
- composer status,
- can submit,
- can stop,
- provider session ID,
- resume identity.

### Deletes/demotes

Delete registry EventEmitter transitions as runtime truth:

```txt
session-started
session-idle
session-ended
```

or mark them internal diagnostics-only until all listeners are gone.

Remove route code that manually registers lifecycle transitions after create/resume if the harness event stream already has `run:start`, `run:ready`, `turn:end`, `run:end`.

### Invariants guarding the move

- `runtime_authority_consensus`
- `single_live_run`
- `daemon_manager_process_consistency`

### Rollback

Revert the PR.

Do not add a replacement runtime registry.

---

## Move 8 — Demote DB segment runtime status

### Changes

DB conversation/segment rows remain metadata.

They are not live runtime authority.

Make provider session ID nullable until known:

```sql
provider_session_id TEXT NULL
```

Migration:

```sql
UPDATE conversation_segments
SET provider_session_id = NULL
WHERE provider_session_id LIKE 'pending-%';
```

Stop writing `pending-*`.

Only update `provider_session_id` from a real latest `run:ready.resumeId`.

If `conversation_segments.status` must remain for compatibility, redefine it as archival/display metadata, not live process state.

### Deletes/demotes

- Delete `pending-*` provider session ID generation.
- Delete route code that treats segment status as live runtime status.
- Delete side effects that mark segment completed/active as the source of UI truth.

### Invariants guarding the move

- `resume_id_consistency`
- `runtime_authority_consensus`

### Rollback

Revert code.

Do not restore `pending-*`. If rollback is necessary, nullable provider IDs remain valid.

---

## Move 9 — Collapse detail-view runtime state onto harness facts

### Changes

`ConversationView` and `Composer` use one derived view model.

Add:

```ts
export interface ComposerRuntimeView {
  display:
    | 'starting'
    | 'stopping'
    | 'working'
    | 'ready'
    | 'off'
    | 'error';

  canSubmit: boolean;
  canStop: boolean;
  showBackgroundTaskNotice: boolean;
  awaitingPermission: boolean;
  awaitingQuestion: boolean;
}

export function deriveComposerRuntimeView(facts: RuntimeFacts): ComposerRuntimeView {
  switch (facts.phase) {
    case 'starting':
      return {
        display: 'starting',
        canSubmit: false,
        canStop: true,
        showBackgroundTaskNotice: false,
        awaitingPermission: false,
        awaitingQuestion: false,
      };

    case 'stopping':
      return {
        display: 'stopping',
        canSubmit: false,
        canStop: true,
        showBackgroundTaskNotice: false,
        awaitingPermission: false,
        awaitingQuestion: false,
      };

    case 'working':
      return {
        display: 'working',
        canSubmit: facts.canSubmit === true,
        canStop: true,
        showBackgroundTaskNotice: facts.hasRunningBackgroundTasks === true,
        awaitingPermission: facts.awaitingPermission === true,
        awaitingQuestion: facts.awaitingQuestion === true,
      };

    case 'idle_alive':
    case 'idle_dead':
      return {
        display: 'ready',
        canSubmit: true,
        canStop: false,
        showBackgroundTaskNotice: facts.hasRunningBackgroundTasks === true,
        awaitingPermission: facts.awaitingPermission === true,
        awaitingQuestion: facts.awaitingQuestion === true,
      };

    case 'error':
      return {
        display: 'error',
        canSubmit: false,
        canStop: false,
        showBackgroundTaskNotice: false,
        awaitingPermission: false,
        awaitingQuestion: false,
      };

    case 'absent':
      return {
        display: 'off',
        canSubmit: false,
        canStop: false,
        showBackgroundTaskNotice: false,
        awaitingPermission: false,
        awaitingQuestion: false,
      };
  }
}
```

### Deletes/demotes

- Remove `useSessionStatus` from `ConversationView`.
- Remove composer boolean soup.
- Remove “illegal status transition” logging once invalid combinations are unrepresentable.
- Keep sidebar polling, but do not feed it into detail composer state.

### Invariants guarding the move

- `runtime_authority_consensus`
- `hydration_completion`
- `pending_message_injection`
- `background_task_consensus`

### Rollback

Revert the PR.

Because public status is already harness-derived by this point, rollback should not reintroduce a conflicting runtime source.

---

## Move 10 — Remove JSONL from live runtime paths

### Changes

JSONL remains only for historical import/backfill.

Live UI/runtime state comes from harness events.

### Deletes/demotes

- Remove `SessionActivityWatcher` from core UI state.
- Remove JSONL-derived live activity seeding.
- Keep `history-backfill` only as a migration/repair path.

### Invariants guarding the move

- `event_recovery_visibility`
- `seq_integrity`
- `runtime_authority_consensus`

### Rollback

Revert the PR.

If old sessions require JSONL import, run backfill explicitly rather than reading JSONL in live UI paths.

---

# 6. Tactical bug fixes

## 6.1 Fix `recoverFromStorage()` resume identity risk

### Current bug

Recovery reads a tail window, e.g. last 50 events, to find resume identity.

Long histories can push `run:ready` out of the window. Then resume may use stale/null/pending identity.

### Required fix

Add storage API:

```ts
export interface EventStorageAdapter {
  read(sessionId: string, opts: ReadEventsOptions): Promise<SessionEvent[]>;

  findLatestRunReady(sessionId: string): Promise<RunReadyEvent | null>;
}
```

SQLite implementation:

```sql
CREATE INDEX IF NOT EXISTS idx_harness_events_session_type_seq
ON harness_events(session_id, type, seq DESC);
```

Query:

```ts
const row = db
  .prepare(`
    SELECT event_json
    FROM harness_events
    WHERE session_id = ? AND type = 'run:ready'
    ORDER BY seq DESC
    LIMIT 1
  `)
  .get(sessionId);
```

Use it in recovery:

```ts
const latestReady = await storage.findLatestRunReady(sessionId);

if (latestReady?.data?.resumeId && !latestReady.data.resumeId.startsWith('pending-')) {
  recovered.resumeId = latestReady.data.resumeId;
} else {
  recovered.resumeId = null;
}
```

Do not fall back to `pending-*`.

### Test

Add/keep behavioral test:

```txt
long history with run:ready outside tail window still resumes with latest real provider ID
```

### Diagnostic guard

`resume_id_consistency`.

---

## 6.2 Fix `RunEndData.reason` protocol drift

### Decision

Widen the protocol.

Add `server_restart` as a valid `run:end` reason.

```ts
export type RunEndReason =
  | 'completed'
  | 'stopped'
  | 'interrupted'
  | 'error'
  | 'process_exit'
  | 'idle_timeout'
  | 'server_restart';

export interface RunEndData {
  reason: RunEndReason;
  code?: number | null;
  signal?: string | null;
}
```

Add event metadata:

```ts
export interface SessionEventMeta {
  inferred?: boolean;
  source?: 'provider' | 'daemon' | 'harness' | 'recovery' | 'test';
}
```

Recovery append:

```ts
eventLog.append({
  type: 'run:end',
  sessionId,
  data: {
    reason: 'server_restart',
    code: null,
    signal: null,
  },
  meta: {
    inferred: true,
    source: 'recovery',
  },
});
```

### Justification

This is a real lifecycle fact: after restart, if the harness/daemon cannot reattach to the previous process, the previous run is ended.

Do not hide this in UI-only synthetic markers. Reducers need a typed lifecycle event so `deriveProcessAlive()` does not resurrect dead processes after reload.

The important constraint is:

> inferred recovery events must not hide stored real events.

That is handled by `event_recovery_visibility`.

---

## 6.3 Eliminate `harnessConnected` as session existence

Frontend Composer always sends existing-conversation input to:

```txt
POST /api/conv/:conversationId/resume
```

Transport connection state is not used to choose between start, send, resume, or inject.

Server-side `/resume` ensures the correct phase-dependent behavior:

- live idle: send,
- dead idle: resume/start then send,
- working: accept pending/mid-turn input,
- starting: hold until ready,
- stopping: reject with `409`.

`/inject` is compatibility-only or debug-only, never a separate product input authority.

---

## 6.4 Delete `ActivityStreamContext`

### Decision

Delete it.

Do not implement it.

### Required changes

Remove:

```txt
ActivityStreamProvider
ActivityStreamContext
useActivityStreamSubscription
```

Remove imports and wrappers.

Sidebar uses existing bulk status polling, now harness-derived.

If no-op subscribers currently hide bugs, deletion makes them compile-time visible.

---

# 7. Instrumentation

## 7.1 Named SQLite slow-query wrapping

Add helper:

```ts
export interface SqliteOpMeta {
  conversationId?: string;
  sessionId?: string;
  rows?: number;
  limit?: number;
  source?: string;
}

export function runSqliteOp<T>(
  op: string,
  meta: SqliteOpMeta,
  fn: () => T,
): T {
  const started = performance.now();

  try {
    const result = fn();
    const durationMs = performance.now() - started;

    recordSqliteMetric(op, durationMs, meta);

    if (shouldLogSlowSqliteOp(op, durationMs)) {
      logger.warn({
        event: 'sqlite.slow_op',
        op,
        durationMs,
        ...meta,
      });
    }

    return result;
  } catch (error) {
    const durationMs = performance.now() - started;

    logger.error({
      event: 'sqlite.op_failed',
      op,
      durationMs,
      ...meta,
      error,
    });

    throw error;
  }
}
```

Thresholds:

| Operation class | Warn | Error |
|---|---:|---:|
| harness event write | 25ms | 100ms |
| harness event read | 50ms | 250ms |
| conversation list/status query | 100ms | 500ms |
| transaction | 250ms | 1000ms |

Operation names must be stable:

```txt
harness_events.write
harness_events.read_window
harness_events.find_latest_run_ready
conversation.status.bulk
conversation.detail.metadata
session_info.get
session_info.get_or_create
diagnostics.collect_sources
```

Do not log full SQL by default. If needed, log a statement hash.

Diagnostics includes recent slow ops from an in-memory ring buffer.

---

## 7.2 Runtime invariant logging

Invariant engine runs in three places:

1. on diagnostics endpoint,
2. in tests,
3. sampled/background checks for recently active conversations.

Background checks:

- on lifecycle events: schedule check after the relevant grace window;
- on public status response: sample 5%;
- on stop request: schedule checks at 500ms, 6s, 10s;
- on `run:ready`: schedule resume consistency checks at 2s and 10s.

Logging shape:

```ts
{
  event: 'runtime.invariant_failed',
  invariantId: 'resume_id_consistency',
  severity: 'error',
  conversationId,
  fingerprint,
  ageMs,
  graceMs,
  summary,
  disagreements,
  likelyBugClass,
  requestId
}
```

Rate limiting:

- fingerprint = `conversationId + invariantId + likelyBugClass + source fields`.
- log first failure immediately.
- log severity escalation immediately.
- log recovery once.
- suppress repeats for 5 minutes.

Alerts:

| Condition | Alert |
|---|---|
| any `seq_integrity` error | immediate high-priority alert |
| any `single_live_run` error lasting > 10s | high-priority alert |
| `resume_id_consistency` error count > 3 in 10m | medium-priority alert |
| `runtime_authority_consensus` errors on >1% sampled active conversations in 10m | medium-priority alert |
| SQLite `harness_events.write` p99 > 100ms for 15m | medium-priority alert |
| hydration errors >0.5% of cold loads for 30m | low/medium alert |

---

## 7.3 Tests use diagnostics

The behavioral tests should call diagnostics after important actions.

Example:

```ts
await expectDiagnosticsHealthy(conversationId, {
  allowWarnings: ['background_task_consensus'],
});
```

For known transitional PRs, tests may assert a specific invariant fails before the move and passes after the move.

Promote these test-derived invariants:

| Test area | Runtime invariant |
|---|---|
| resume after restart | `resume_id_consistency` |
| event visibility after restart | `event_recovery_visibility` |
| stop/interrupt | `stop_semantics` |
| SSE no duplicates | `sse_reconnect_no_duplicates` |
| cold load/hydration | `hydration_completion` |
| pending message injection | `pending_message_injection` |
| persistence across reload | `seq_integrity`, `event_recovery_visibility` |

---

# 8. What we are explicitly not doing

## 8.1 No new `SessionRuntime`

`agent-ui-harness` is already the runtime kernel.

A separate Lattice `SessionRuntime` would become authority #8 unless it deleted existing authorities immediately. We are not doing that.

Allowed instead:

```txt
thin command adapters
pure projections
diagnostics collectors
```

## 8.2 No event-native transcript API replacement

The main detail view already uses harness events as the transcript source.

Do not redesign transcript APIs unless diagnostics shows transcript regressions that cannot be fixed in the harness projection.

## 8.3 No hydration protocol replacement

The harness already has:

- hydration phase,
- replay metadata,
- scoped replay handling,
- proactive history fetch.

We only add diagnostics.

Revisit only if:

```txt
hydration_completion error rate > 0.5% of cold loads for 30 minutes
```

or duplicate delivery remains after authority collapse.

## 8.4 No async SQLite rewrite yet

Add named instrumentation first.

Move SQLite event storage to a worker only if production metrics show:

```txt
harness_events.write p95 > 10ms
or
harness_events.write p99 > 50ms
or
event-loop delay p99 > 100ms correlated with harness_events writes
```

for three consecutive active usage windows.

## 8.5 No `agent_runs` table yet

Do not add an `agent_runs` table as a speculative cleanup.

Revisit only if, after moves 1–8:

```txt
resume_id_consistency errors continue
or
single_live_run cannot be expressed cleanly from events + process liveness
or
multiple concurrent runs per conversation become a product requirement
```

## 8.6 No ProviderDriver abstraction yet

Codex is deleted.

Reintroduce provider abstraction only when there is a committed second provider with acceptance tests for:

- create,
- resume,
- send,
- stop,
- interrupt,
- permission request,
- hydration,
- persistence across restart.

## 8.7 No route-thinning project

Routes get thinner only as part of deleting an authority or fixing a bug.

No cleanup-only route rewrite.

## 8.8 No full daemon rewrite

The daemon remains process infrastructure.

We remove Codex and obvious duplicated product-policy leakage, but we do not split the daemon into five modules until diagnostics shows daemon/process inconsistency is a top source of runtime failures.

---

# 9. Success criteria

The architecture has meaningfully changed when these are true.

## 9.1 Diagnostics

For recently active conversations:

```txt
runtime_authority_consensus errors: 0 persistent errors over grace windows
resume_id_consistency errors: 0
seq_integrity errors: 0
single_live_run errors: 0
```

Target:

```txt
>= 99% of diagnostics reports for active conversations are healthy
>= 99.9% have no error-severity invariant
```

Warnings are acceptable during transitional client polling windows.

## 9.2 Public status

Diagnostics shows:

```txt
public_status.phase === harness_events.phase
```

within grace for active conversations.

No product endpoint derives live status from:

- `ActiveConversationRegistry`,
- DB segment status,
- daemon maps alone.

## 9.3 Resume identity

No stored active/recent segment has:

```txt
provider_session_id LIKE 'pending-%'
```

after migration.

After `run:ready`, DB provider ID matches latest harness resume ID within 10s.

## 9.4 Frontend detail runtime

`ConversationView` no longer imports or calls `useSessionStatus`.

Composer state comes from:

```txt
harness RuntimeFacts -> deriveComposerRuntimeView()
```

No frontend branch uses SSE connection to decide whether a session exists.

## 9.5 Commands

All existing-conversation user input from first-party UI goes through:

```txt
POST /api/conv/:conversationId/resume
```

The route handles:

- `idle_alive`,
- `idle_dead`,
- `working` / pending input,
- `starting` / queued-after-ready input,
- `stopping` rejection.

No first-party Composer path uses:

- SSE connection state to choose start vs send,
- `/inject` as a product input route,
- `/queue` for immediate user submission,
- a new parallel `/messages` endpoint.

## 9.6 Deleted dead surfaces

These are gone:

- half-supported Codex runtime code,
- inert `ActivityStreamContext`,
- tail-window resume recovery,
- out-of-schema `run:end` recovery events,
- registry-derived public status,
- `pending-*` provider IDs.

## 9.7 SQLite visibility

Slow SQLite logs are named and actionable.

Example:

```txt
sqlite.slow_op op=harness_events.find_latest_run_ready durationMs=87 conversationId=conv_abc
```

There are no generic “event loop blocked” reports without a corresponding named candidate operation.

## 9.8 Tests

The 10 behavioral tests still pass.

Additionally, tests assert diagnostics health after critical flows:

- resume after restart,
- stop/interrupt,
- hydration cold load,
- persistence across reload,
- SSE reconnect,
- pending message injection.

---

# Final implementation stance

Ship this as a ratchet:

1. make harness recovery trustworthy,
2. delete unsupported Codex,
3. add diagnostics/instrumentation,
4. make public status harness-derived,
5. replace start/send branching with one message command,
6. delete inert activity context,
7. demote registry,
8. demote DB runtime fields,
9. collapse detail composer state to harness facts,
10. remove JSONL from live runtime paths.

Do not build a new runtime kernel.

The harness already is the runtime kernel. The work is to stop the rest of Lattice from pretending to be one.
