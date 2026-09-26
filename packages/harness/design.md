# @liggi/agent-ui-harness — Design Document

> **Historical document.** This is the original April design document, kept
> for the rationale behind the architecture — why status is derived rather
> than stored, why there is no registry, what the event log is for. It is not
> maintained as API documentation and has drifted from the implementation: it
> describes 9 event types where the code now has 12, and several API shapes
> and signatures have changed since it was written. For anything you intend to
> call, the source and [README.md](README.md) are the authority.

## What is this?

A package that manages the lifecycle of an interactive CLI process connected to a browser. Spawn it, stream its output, send it input, stop it, survive disruptions. Used by Lattice and Analyst today — both implemented independently, both brittle for the same reasons.

## The problem harness solves

Every bug in Lattice's session management (14 documented regressions) traces to the same structural flaw: **multiple independent systems tracking whether a session is alive, failing to agree, and reconciliation logic that creates new disagreement surfaces.**

The registry says one thing, the daemon says another, the frontend cache says a third. Fixes add reconciliation passes. Reconciliation creates new race windows. New races create new bugs. The cycle continues.

Harness eliminates this by making the question "what state is this session in?" **impossible to answer wrong**.

---

## Core design principle

**One append-only event log per session. Status is derived, never tracked.**

There is no registry. No status field. No authoritative polling endpoint. No reconciliation. The event log is the single source of truth. Ask "what's the status?" and the answer is computed from the log — the same log, the same function, on both server and client.

If you have the events, you have the truth. If you don't have the events, you reconnect and replay them.

---

## The Protocol

### IDs

Two identifiers, total.

| ID | Scope | Meaning |
|----|-------|---------|
| **SessionId** | Logical conversation | Stable. Created by the app. Survives across runs. |
| **RunId** | One process invocation | Created by harness on spawn. New run = new RunId. |

No streaming IDs, segment IDs, synthetic IDs, provisional IDs, or recovered IDs. Two IDs.

### Events

Every event carries `(sessionId, runId, seq)` where `seq` is a monotonic integer assigned by the server on append. This is the **only** ordering mechanism.

```
┌─────────────────────────────────────────────────────┐
│ SessionEvent                                        │
├─────────────────────────────────────────────────────┤
│ sessionId: string                                   │
│ runId: string                                       │
│ seq: number          ← monotonic, server-assigned   │
│ timestamp: number    ← wall clock                   │
│ type: string         ← event type                   │
│ data: <per-type>     ← event payload                │
└─────────────────────────────────────────────────────┘
```

Every event can optionally carry `meta` for debugging — never part of the protocol contract, never affects state derivation:

```typescript
interface SessionEvent {
  sessionId: string
  runId: string
  seq: number
  timestamp: number
  type: string
  data: unknown
  meta?: {
    pid?: number         // which OS process produced this
    latency?: number     // ms since previous event
    rawType?: string     // original CLI event type before normalization
  }
}
```

Event vocabulary:

| Type | When | Payload |
|------|------|---------|
| `run:start` | Process spawned | `{ config }` |
| `run:ready` | Init event received from CLI | `{ resumeId, model, tools, cwd }` |
| `run:end` | Process exited | `{ code, reason, error? }` |
| `run:error` | Unrecoverable error | `{ message, code?, signal? }` |
| `stop:requested` | Stop was called | `{}` |
| `content` | Assistant output | `{ blocks: ContentBlock[] }` |
| `result` | Tool result from CLI | `{ blocks: ResultBlock[] }` |
| `turn:end` | Assistant turn complete | `{ usage, duration? }` |
| `input:sent` | User input delivered | `{ text }` |

`run:end` reason distinguishes how the run ended: `'completed'` (Claude finished normally), `'stopped'` (user clicked stop), `'crashed'` (non-zero exit), `'error'` (spawn failure or unrecoverable). The app needs this to show the right UI — "done" vs "stopped" vs "something went wrong."

9 event types. Both apps currently emit these same semantic events — just with different names, different shapes, and scattered across different code paths.

### Status derivation

Status is a **pure function** of the event log. Same function runs on server and client. No disagreement possible.

```typescript
type Status = 'idle' | 'starting' | 'streaming' | 'stopping'

function deriveStatus(events: SessionEvent[]): Status {
  for (let i = events.length - 1; i >= 0; i--) {
    switch (events[i].type) {
      case 'run:end':
      case 'run:error':
      case 'turn:end':     return 'idle'
      case 'stop:requested': return 'stopping'
      case 'content':
      case 'result':
      case 'input:sent':   return 'streaming'
      case 'run:ready':    return 'streaming'
      case 'run:start':    return 'starting'
    }
  }
  return 'idle'
}
```

Four states. No `ended` — a session is always alive. Runs end, sessions don't. You can always send another message.

### Activity derivation

"What is the process doing right now?" — also derived from events.

```typescript
type Activity =
  | { type: 'thinking' }
  | { type: 'tool'; name: string; input?: unknown }
  | null

function deriveActivity(events: SessionEvent[]): Activity {
  const status = deriveStatus(events)
  if (status !== 'streaming') return null

  // Walk backwards to find the latest content block
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'content') {
      const lastBlock = e.data.blocks[e.data.blocks.length - 1]
      if (lastBlock.type === 'thinking') return { type: 'thinking' }
      if (lastBlock.type === 'tool_use') return { type: 'tool', name: lastBlock.name, input: lastBlock.input }
    }
    if (e.type === 'result' || e.type === 'turn:end') return null
  }
  return null
}
```

---

## Server

Three components. That's it.

### EventLog

Per-session, append-only, in-memory. Assigns sequence numbers.

```typescript
class EventLog {
  private events: SessionEvent[] = []
  private seq = 0
  private listeners = new Set<(event: SessionEvent) => void>()

  append(type: string, data: unknown, runId: string, sessionId: string): SessionEvent {
    const event = { sessionId, runId, seq: ++this.seq, timestamp: Date.now(), type, data }
    this.events.push(event)
    for (const listener of this.listeners) listener(event)
    return event
  }

  since(afterSeq: number): SessionEvent[] {
    // Binary search or linear scan — log is ordered by seq
    return this.events.filter(e => e.seq > afterSeq)
  }

  latest(): SessionEvent | null {
    return this.events[this.events.length - 1] ?? null
  }

  subscribe(cb: (event: SessionEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // Optional: cap size for long-running sessions
  // Oldest events can be evicted since apps persist what they need via onEvent
}
```

Not a database. Not persistent. A runtime buffer. Apps persist what they need via the `onEvent` hook.

**Sliding window**: configurable max size (default 2000 events). When the log exceeds this, oldest events are evicted. If a client reconnects asking for events older than the window, the SSE handler sends a `reset` event and the client rehydrates from app persistence (via `onReset`). This bounds memory for long-running sessions while covering the 99% reconnect case (seconds, not hours).

### SessionManager

Owns the event log and the process handle. The single authority.

```typescript
class SessionManager {
  private sessions = new Map<string, Session>()

  constructor(private adapter: ProcessAdapter, options?: {
    logger?: Logger           // structured logging — app provides pino, console, whatever
    maxLogSize?: number       // sliding window size (default 2000)
    onEvent?: (event: SessionEvent) => void  // server-side event hook for persistence/side effects
  }) {}

  async start(sessionId: string, config: StartConfig): Promise<string> {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { log: new EventLog(), process: null, runId: null }
      this.sessions.set(sessionId, session)
    }

    if (session.process?.alive) {
      throw new Error('Session already has an active process')
    }

    const runId = crypto.randomUUID()
    session.runId = runId
    session.log.append('run:start', { config }, runId, sessionId)

    // Spawn via adapter
    const handle = await this.adapter.spawn(config)
    session.process = handle

    // Pipe process events into the log
    this.pipeEvents(session, handle, runId, sessionId)

    // Handle exit — process handle resolves immediately on death, no polling
    handle.exited.then(({ code, signal }) => {
      session.process = null
      const status = deriveStatus(session.log.events)
      const reason = status === 'stopping' ? 'stopped'
        : code === 0 ? 'completed'
        : 'crashed'
      session.log.append('run:end', { code, signal, reason }, runId, sessionId)
    })

    return runId
  }

  async send(sessionId: string, input: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown session')

    const status = deriveStatus(session.log.events)

    if (status === 'starting' || status === 'stopping') {
      throw new Error(`Cannot send while ${status}`)
    }

    if (status === 'idle' && !session.process?.alive) {
      // Process exited after last turn — spawn new run with input as prompt
      await this.start(sessionId, { ...lastConfig, prompt: input, resume: session.resumeId })
      return
    }

    // Process alive — write to stdin
    session.process.write(input + '\n')
    session.log.append('input:sent', { text: input }, session.runId, sessionId)
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.process?.alive) return  // nothing to stop

    const status = deriveStatus(session.log.events)
    if (status === 'stopping') return  // already stopping

    session.log.append('stop:requested', {}, session.runId, sessionId)

    // Escalating kill: SIGINT → SIGTERM → SIGKILL
    session.process.signal('SIGINT')

    setTimeout(() => {
      if (session.process?.alive) {
        session.process.signal('SIGTERM')
        setTimeout(() => {
          if (session.process?.alive) {
            session.process.signal('SIGKILL')
          }
        }, 2000)
      }
    }, 3000)
  }

  getStatus(sessionId: string): Status {
    const session = this.sessions.get(sessionId)
    if (!session) return 'idle'
    return deriveStatus(session.log.events)
  }

  getLog(sessionId: string): EventLog | null {
    return this.sessions.get(sessionId)?.log ?? null
  }
}
```

No registry. No reconciliation. No daemon polling. One map, one process handle, one event log.

**When the process exits, harness knows immediately** — via the `exited` promise on the handle. No polling needed. No stale entries possible.

### SSE Transport

Streams from the event log to the browser. Stateless from the server's perspective.

```typescript
function createSSEHandler(manager: SessionManager) {
  return (req: Request, res: Response) => {
    const { sessionId } = req.params
    const afterSeq = Number(req.query.after ?? 0)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'private, no-cache, no-store, no-transform, must-revalidate, max-age=0',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',  // disable nginx/reverse proxy buffering
    })

    const log = manager.getLog(sessionId)

    if (!log) {
      // No log = no session. Send reset.
      res.write(`event: reset\ndata: ${JSON.stringify({ reason: 'no_session' })}\n\n`)
      res.end()
      return
    }

    // Replay missed events
    for (const event of log.since(afterSeq)) {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }

    // Stream live events
    const unsub = log.subscribe((event) => {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    })

    // Heartbeat — SSE comment keeps proxies/load balancers from killing idle connections
    // (pattern from better-sse: empty comment every 10-15s is invisible to the client parser)
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`)
    }, 10_000)

    // Cleanup on disconnect
    req.on('close', () => {
      unsub()
      clearInterval(heartbeat)
    })
  }
}
```

Zombie SSE connections? They're just dead readers. When the socket closes, the `close` event fires and the listener is removed. No impact on session state because SSE connections don't affect session state. They're **read-only views** of the event log.

### ProcessAdapter

The only thing apps implement. Thin wrapper around their process spawning mechanism.

```typescript
interface ProcessAdapter {
  spawn(config: SpawnConfig): Promise<ProcessHandle>
}

interface SpawnConfig {
  prompt: string
  cwd?: string
  resume?: string        // CLI session ID for --resume
  env?: Record<string, string>
  args?: string[]        // additional CLI args
}

interface ProcessHandle {
  stdout: AsyncIterable<string>   // raw lines from process
  write(input: string): void      // write to stdin
  signal(sig: NodeJS.Signals): void
  exited: Promise<{ code: number }>
  alive: boolean
}
```

Lattice implements this wrapping its daemon. Analyst implements this wrapping node-pty directly. Harness doesn't care.

### Event Normalization

Harness includes a normalizer for Claude CLI's `stream-json` format, since that's the primary (only) consumer right now.

```typescript
function normalizeClaude(raw: unknown): { type: string; data: unknown } | null {
  const msg = raw as Record<string, unknown>

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        return { type: 'run:ready', data: {
          resumeId: msg.session_id,
          model: msg.model,
          tools: msg.tools,
          cwd: msg.cwd,
        }}
      }
      return null  // ignore other system events

    case 'assistant':
      return { type: 'content', data: { blocks: normalizeBlocks(msg.message.content) } }

    case 'user':
      return { type: 'result', data: { blocks: normalizeBlocks(msg.message.content) } }

    case 'result':
      return { type: 'turn:end', data: { usage: msg.usage, duration: msg.duration_ms } }

    default:
      return null
  }
}
```

One switch statement. Both apps currently have this same logic spread across 500+ lines each because it's interleaved with persistence, UI updates, and status tracking that harness separates out.

**Validation**: the normalizer rejects structurally invalid CLI output (missing required fields, unknown content block types) by returning `null`. These are logged at `warn` level with the raw event attached for debugging. Invalid events never enter the log — they can't corrupt state.

### Resume ID Flow

When Claude CLI initializes, it sends a `session_id` in the init event. This ID is needed to resume the conversation in a future run (via `--resume`). Harness stores it automatically:

1. `run:ready` event arrives with `resumeId`
2. SessionManager stores it on the session object: `session.resumeId = data.resumeId`
3. When `send()` needs to spawn a new run (process exited after last turn), it passes `resume: session.resumeId` in the spawn config
4. The adapter uses this to add `--resume <id>` to the CLI args

The app never needs to thread this through manually.

### Session Cleanup

Sessions are removed from the SessionManager's map via `destroy(sessionId)`:

```typescript
destroy(sessionId: string): void {
  const session = this.sessions.get(sessionId)
  if (!session) return
  if (session.process?.alive) {
    session.process.signal('SIGKILL')  // force-kill if still running
  }
  this.sessions.delete(sessionId)
  // Any SSE clients subscribed to this log will get disconnected
  // on their next read attempt (log no longer exists)
}
```

Apps call this when a session is no longer needed (conversation closed, user disconnected). Harness doesn't impose idle timeouts — the app knows better when a session is truly done.

### Diagnostics

SessionManager exposes a single inspection point for debugging:

```typescript
inspect(sessionId: string): SessionDiagnostics | null {
  const session = this.sessions.get(sessionId)
  if (!session) return null
  return {
    status: deriveStatus(session.log.events),
    activity: deriveActivity(session.log.events),
    runId: session.runId,
    resumeId: session.resumeId,
    processAlive: session.process?.alive ?? false,
    pid: session.process?.pid,
    eventCount: session.log.length,
    lastEventAt: session.log.latest()?.timestamp,
    lastEventType: session.log.latest()?.type,
    subscriberCount: session.log.subscriberCount,
    uptimeMs: session.runStartedAt ? Date.now() - session.runStartedAt : null,
  }
}
```

One place to look, one source of truth. Replaces Lattice's scattered diagnostic endpoints.

---

## Client

### useSession hook

One hook. Manages SSE connection, accumulates events, derives state.

```typescript
function useSession(sessionId: string | null, options: SessionOptions): SessionHandle

interface SessionOptions {
  baseUrl: string                                      // e.g. '/api/harness'
  onEvent?: (event: SessionEvent) => void              // for persistence
  onStatusChange?: (from: Status, to: Status) => void  // for analytics/logging
  onReset?: () => SessionEvent[] | Promise<SessionEvent[]>  // rehydrate after server restart
}

interface SessionHandle {
  // Derived from events
  status: Status                   // 'idle' | 'starting' | 'streaming' | 'stopping'
  activity: Activity | null        // { type: 'thinking' } | { type: 'tool', name, input }
  error: string | null

  // Raw events (app transforms these into its own message format)
  events: SessionEvent[]

  // Connection health (transport concern, not session state)
  connected: boolean

  // Actions
  send: (input: string) => Promise<void>
  stop: () => Promise<void>
}
```

### Internal reducer

Five actions. Compare to Lattice's 20+.

```typescript
type Action =
  | { type: 'EVENT'; event: SessionEvent }
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'ERROR'; message: string }
  | { type: 'RESET'; events: SessionEvent[] }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'EVENT':
      return { ...state, events: [...state.events, action.event], lastSeq: action.event.seq }
    case 'CONNECTED':
      return { ...state, connected: true, error: null }
    case 'DISCONNECTED':
      return { ...state, connected: false }
    case 'ERROR':
      return { ...state, error: action.message }
    case 'RESET':
      return { ...state, events: action.events, lastSeq: action.events.at(-1)?.seq ?? 0 }
  }
}
```

`status` and `activity` are derived via `useMemo` over `state.events`. They are never stored, never set, never stale.

### SSE client

Uses `fetch` + `ReadableStream` (not `EventSource`) for control over headers, reconnection, and lifecycle. The SSE frame parser is vendored from `@microsoft/fetch-event-source` — ~160 lines of zero-copy, WHATWG-compliant parsing that handles incomplete frames across chunks, multi-line data fields, and comments (heartbeats).

**Three-layer parsing pipeline** (from fetch-event-source):
- `getBytes(stream)` — reads chunks from response body
- `getLines(onLine)` — buffers and splits into lines, handles CR/LF, tracks field positions
- `getMessages(onId, onRetry, onMessage)` — assembles lines into SSE events

```typescript
async function connectSSE(url: string, options: {
  afterSeq: number
  onEvent: (event: SessionEvent) => void
  onConnected: () => void
  onDisconnected: () => void
  onReset: () => void
  signal: AbortSignal
}) {
  const response = await fetch(`${url}?after=${options.afterSeq}`, {
    headers: { 'Accept': 'text/event-stream' },
    signal: options.signal,
  })

  if (!response.ok) throw new Error(`SSE connect failed: ${response.status}`)
  options.onConnected()

  // Pipe response through the three-layer parser
  await getBytes(response.body!, getLines(getMessages(
    (id) => { /* track last event ID for reconnect */ },
    (retry) => { /* update retry interval if server requests */ },
    (msg) => {
      if (msg.event === 'reset') {
        options.onReset()
        return
      }
      const event = JSON.parse(msg.data) as SessionEvent
      options.onEvent(event)
    }
  )))

  options.onDisconnected()
}
```

**Reconnection with exponential backoff:**

```typescript
const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30_000
const MAX_RETRIES = 10

async function connectWithRetry(url, state, dispatch, signal) {
  let attempt = 0

  while (!signal.aborted) {
    try {
      await connectSSE(url, { afterSeq: state.lastSeq, ... })
      attempt = 0  // reset on clean disconnect (server closed normally)
    } catch (err) {
      if (signal.aborted) return
      attempt++
      if (attempt >= MAX_RETRIES) {
        dispatch({ type: 'ERROR', message: `Connection failed after ${MAX_RETRIES} retries` })
        return
      }
      const delay = Math.min(INITIAL_RETRY_MS * 2 ** attempt, MAX_RETRY_MS)
      await sleep(delay)
    }
  }
}
```

**Tab visibility handling** (from fetch-event-source pattern):

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Browser may throttle background tabs — proactively disconnect
    abortController.abort()
  } else {
    // Tab visible again — reconnect immediately with last known sequence
    abortController = new AbortController()
    connectWithRetry(url, state, dispatch, abortController.signal)
  }
})
```

No deduplication needed. Sequence numbers are monotonic. Client requests `after=lastSeq`, server replays from there. Gaps are impossible if the server has the events; if it doesn't (sliding window eviction or server restart), client gets a `reset` event.

### Session switching

When `sessionId` changes:

1. Abort old SSE connection (via AbortController)
2. Dispatch `RESET` with empty events
3. Connect to new session's SSE with `afterSeq=0`
4. Events flow in, status is derived

No cleanup of old session state. No cross-session interference. Each session is an independent event stream.

### Page refresh

On mount with an existing sessionId:

1. Connect to SSE with `afterSeq=0`
2. Server replays all events from its in-memory log
3. Client derives status from replayed events
4. If session was streaming, events continue to flow live

If server restarted (log is empty):

1. SSE returns `reset` event
2. Client calls `onReset?.()` — app provides historical events from its persistence layer
3. Client rehydrates from those events
4. Status is derived correctly

---

## How this prevents the real bugs

| # | Bug | Root cause | How harness prevents it |
|---|-----|-----------|------------------------|
| 1 | Orphaned process on resume | Registry tracked old run, daemon served it back | SessionManager owns the process handle directly. `start()` checks `process?.alive` and throws if one exists. Old process must be explicitly stopped first. |
| 2 | Synthetic segment IDs break stop | Two ID systems (registry IDs vs DB IDs) desynced | Two IDs total (SessionId, RunId). `stop()` uses the process handle, not an ID lookup chain. |
| 3 | SSE zombie connection leak | Dead SSE connections affected session state | SSE connections are stateless readers. Dead connections have zero impact on session state. Cleanup is just removing a listener. |
| 4 | RESET race condition | Optimistic status raced with authoritative status | Status is never set, only derived. No race possible — derivation is deterministic. |
| 5 | Optimistic message wiped by hydration | Hydration effect cleared optimistic state | Harness doesn't manage messages. Events are append-only. Apps handle optimistic display in their own layer without interfering with session status. |
| 6 | Stop + inject race / escalation swallowed | Graceful stop failure silently swallowed | `stop()` has guaranteed escalation (SIGINT → SIGTERM → SIGKILL). Process exit triggers `run:end` event via `exited` promise. No silent failure path. |
| 7 | Stale status across navigation | 30-second cache staleTime | No cache. Status derived from events on every render. Switch sessions = new event stream = fresh derivation. |
| 8 | Provider-specific status bugs | Codex-specific code path missing error handling | One code path through ProcessAdapter interface. Provider differences are isolated in the adapter, not spread across session management. |
| 9 | Keep-alive status desync after inject | Registry not updated after stdin write | `send()` appends `input:sent` event. `deriveStatus` sees it and returns `streaming`. No manual update needed. |
| 10 | Queue dispatch under wrong conversation ID | Wrong ID passed during resume registration | No registration step. `send()` takes a sessionId. The session already exists in the map. |
| 11 | Connection pool exhaustion from polling | Permission polling stacked requests | Harness uses a single SSE connection per session. No polling. Heartbeats are server-push. |
| 12 | Registry wipe on deploy / synthetic recovery IDs | In-memory registry cleared, recovered with wrong IDs | Event log is also in-memory, but on loss the client gets `reset` and rehydrates from app persistence. No synthetic recovery. Clean restart. |
| 13 | Optimistic inject without stream connection | Frontend didn't know which streamingId to connect to | One SSE endpoint per session (`/session/:sessionId/events`). No streamingId to resolve. |
| 14 | Missing idle status in direct mode | `turn-idle` event only wired for daemon mode | One code path. `pipeEvents` processes all CLI events regardless of spawn mode. `turn:end` → status derives to `idle`. |

14 for 14.

---

## API surface

### Server endpoints

```
POST   /session/:sessionId/start    → { runId }
POST   /session/:sessionId/send     → { ok }
POST   /session/:sessionId/stop     → { ok }
GET    /session/:sessionId/status   → { status, activity, runId }
GET    /session/:sessionId/events   → SSE stream
```

Five endpoints. Apps mount these under whatever prefix they want and add their own auth/middleware.

### Package exports

```
@liggi/agent-ui-harness/server
  - SessionManager
  - createSSEHandler
  - ProcessAdapter (type)
  - ProcessHandle (type)
  - normalizeClaude

@liggi/agent-ui-harness/client
  - useSession

@liggi/agent-ui-harness/protocol
  - SessionEvent (type)
  - Status (type)
  - Activity (type)
  - deriveStatus
  - deriveActivity
```

---

## Error Handling

### Taxonomy

Three categories of error with different handling:

**Spawn failures** — the process never starts. Bad CLI path, missing permissions, resource limits. The adapter's `spawn()` rejects.

→ SessionManager appends `run:start` (records the attempt), then `run:error` with details, then throws. The event log records what happened. Status derives: `starting` → `idle`. Client sees the error event and can display it.

```
[seq=1] run:start  { config: {...} }
[seq=2] run:error  { message: "spawn ENOENT: claude", code: "SPAWN_FAILED" }
```

**Runtime failures** — the process was running and died unexpectedly. Crash, OOM kill, segfault.

→ The `exited` promise resolves with non-zero code. SessionManager appends `run:end` with `reason: 'crashed'`, exit code, and signal. Status derives to `idle`. Normal exit path, just with error context.

```
[seq=7] run:end  { code: 137, signal: "SIGKILL", reason: "crashed" }
```

**Transport failures** — SSE connection breaks. Network blip, tab hidden, Tailscale IP change.

→ NOT a session error. The process is fine, the client just can't see it. Client reconnects with `after=lastSeq`, replays missed events. If reconnection fails permanently (max retries), the hook surfaces `connected: false` and `error`. But the session is unaffected — a page refresh gets a fresh connection.

### Rule

**Errors that affect the session go in the event log. Errors that don't, get thrown or surfaced separately.**

| Error | Event log? | Exception? | Client sees |
|-------|-----------|-----------|-------------|
| Spawn fails | `run:error` | Yes (from `start()`) | `starting` → `idle` + error event |
| Process crashes | `run:end` with crash reason | No | `streaming` → `idle` + end event |
| Process hangs (no output) | Nothing (process is alive) | No | `streaming` with stale activity |
| Stop ignored (SIGINT) | Already has `stop:requested` | No | `stopping` until kill escalation |
| SSE disconnects | Nothing (server-side) | No | `connected: false`, auto-reconnect |
| SSE fails permanently | Nothing | No | `connected: false` + error string |
| Server restarts | Log lost | No | `reset` event → `onReset()` rehydrate |
| `send()` while starting | Nothing (rejected) | Yes | App catches and shows "please wait" |
| `send()` while stopping | Nothing (rejected) | Yes | App catches and shows "please wait" |
| Normalizer gets garbage | Skipped (null return) | No | Invisible (logged at warn level) |

The event log doubles as the **error log** for the session. You can always look at the events and see what went wrong and when.

### Structured Logging

SessionManager accepts a logger interface:

```typescript
interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}
```

Key log points:
- `start()` called — sessionId, config
- Process spawned — sessionId, runId, pid
- Event appended — sessionId, seq, type (debug level — high volume)
- `send()` called — sessionId, input length
- `stop()` called — sessionId, current status
- Signal sent — sessionId, signal type, escalation step
- Process exited — sessionId, exit code, signal
- Normalizer skipped event — raw event data (warn level)
- SSE client connected/disconnected — sessionId, subscriber count

Apps provide their own logger (pino, console, custom). Harness doesn't import a logging library.

---

## Testing Strategy

### The testing backbone: FakeProcess

A programmable process handle that lets tests control exactly what happens and when:

```typescript
const fake = createFakeProcess()

fake.emitLine('{"type":"system","subtype":"init","session_id":"abc",...}')
fake.emitLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}')
expect(fake.stdinWrites).toEqual(['user message\n'])
expect(fake.signals).toEqual(['SIGINT'])
fake.exit(0)
expect(fake.alive).toBe(false)
```

Wrapped in a `FakeAdapter`:

```typescript
const { adapter, processes } = createFakeAdapter()
const manager = new SessionManager(adapter)

await manager.start('s1', config)
const fake = processes.get('s1')
// Full control over the process
```

Deterministic. Synchronous control. No real processes, no timing dependencies, no flakiness.

### Three test layers

**Layer 1: Pure logic.** `deriveStatus`, `deriveActivity`, event normalization, JSON lines parsing. Pure functions — input in, output out. This is where correctness lives and where tests are cheapest.

Includes **property-based tests** for the state machine:

```typescript
// Status is always one of four values for any event sequence
fc.assert(fc.property(fc.array(arbitraryEvent()), (events) => {
  expect(['idle', 'starting', 'streaming', 'stopping']).toContain(deriveStatus(events))
}))

// stop:requested always produces 'stopping'
fc.assert(fc.property(fc.array(arbitraryEvent()), (before) => {
  expect(deriveStatus([...before, stopRequestedEvent])).toBe('stopping')
}))

// run:end always produces 'idle'
fc.assert(fc.property(fc.array(arbitraryEvent()), (before) => {
  expect(deriveStatus([...before, runEndEvent])).toBe('idle')
}))
```

**Layer 2: Integration with FakeAdapter.** SessionManager + EventLog + FakeProcess. Tests lifecycle logic — start, send, stop, escalation, process exit, multi-run sequences. Uses fake timers for kill escalation. No network.

```typescript
test('stop escalates SIGINT → SIGTERM → SIGKILL', async () => {
  const manager = createTestManager()
  await manager.start('s1', config)
  const fake = processes.get('s1')
  fake.emitLine(initJson)
  fake.emitLine(contentJson)

  await manager.stop('s1')
  expect(fake.signals).toEqual(['SIGINT'])

  await clock.tick(3000)
  expect(fake.signals).toEqual(['SIGINT', 'SIGTERM'])

  await clock.tick(2000)
  expect(fake.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL'])

  fake.exit(137)
  expect(manager.getStatus('s1')).toBe('idle')
})
```

**Layer 3: Transport + client.** SSE handler with an in-process HTTP server (supertest-style). React hook with React Testing Library against that server. Tests event flow end-to-end: process → event log → SSE → hook → derived state.

```typescript
test('client reconnects and replays missed events', async () => {
  // Set up session with events
  await manager.start('s1', config)
  fake.emitLine(initJson)   // seq 1-2
  fake.emitLine(contentJson) // seq 3

  // Client connects
  const { result } = renderHook(() => useSession('s1', { baseUrl: testUrl }))
  await waitFor(() => expect(result.current.events).toHaveLength(3))

  // Disconnect, events arrive while disconnected
  server.disconnectAll()
  fake.emitLine(turnEndJson)  // seq 4

  // Reconnects, replays from seq 3
  await waitFor(() => expect(result.current.events).toHaveLength(4))
  expect(result.current.status).toBe('idle')
})
```

### Regression suite

One test per known Lattice/Analyst bug, testing that harness's design structurally prevents the failure mode. These tests use FakeAdapter and exercise the exact scenario that caused each regression.

### Testing approach (from better-sse patterns)

- Real HTTP servers for transport tests (not mocked fetch)
- Fake timers (`vi.useFakeTimers()`) for intervals and escalation timeouts
- Helper utilities: `createTestManager()`, `waitForStatus()`, `createFakeAdapter()`
- Tests run in milliseconds — no real processes, no network latency

---

## Settled Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Event log size | Sliding window (default 2000) | Bounds memory. Reconnects are usually seconds. Rare long-gap reconnects fall through to app rehydration. |
| Concurrent runs | Sequential only | `start()` throws if process alive. App must stop first. Eliminates overlap bugs (#1, #2). |
| Permission events | Pass-through as content | App-specific UX concern. Harness sees `streaming`. App derives its own `waiting_for_permission` if needed. |
| SSE server library | None — ~50 lines inline | No existing library handles our replay buffer. The handler is trivial. |
| SSE client parser | Vendored from fetch-event-source | ~160 lines, zero-copy, WHATWG-compliant. Library hasn't been updated since 2023; vendoring avoids dependency risk. |
| SSE client library | None — fetch + ReadableStream | EventSource doesn't support custom headers or controlled reconnection. fetch gives us AbortController, auth headers, and sequence-based replay. |
| State machine library | None — pure function | A switch statement is simpler and more debuggable than XState/Robot3. |
| Message persistence | Not in scope | Apps have different storage needs. `onEvent` callback lets them persist what they want. |
| Tab visibility | First-class concern | Browser throttles background tabs. Proactive disconnect on hide, immediate reconnect on show. |

---

## What's NOT in scope

- **Message persistence** — apps store events however they want via `onEvent`
- **Message display format** — apps transform events into their own message types
- **Authentication** — apps add their own middleware
- **Multiple providers** — handled by apps swapping ProcessAdapter implementations
- **Conversation lists** — app concern
- **Permissions / interactive requests** — app-specific events that flow through as `content` blocks; apps interpret them
- **UI components** — harness is headless

---

## Integration sketch

### Lattice

```typescript
import { SessionManager, createSSEHandler, normalizeClaude } from '@liggi/agent-ui-harness/server'

// Lattice provides its daemon-backed adapter
const adapter: ProcessAdapter = {
  async spawn(config) {
    const daemonHandle = await daemon.startConversation(config)
    return wrapDaemonHandle(daemonHandle)
  }
}

const sessions = new SessionManager(adapter)
const sseHandler = createSSEHandler(sessions)

// Mount alongside existing Lattice routes
router.post('/api/session/:sessionId/start', authMiddleware, (req, res) => { ... })
router.get('/api/session/:sessionId/events', authMiddleware, sseHandler)

// Lattice-specific routes (provider switching, permissions) stay in Lattice
```

### Analyst

```typescript
import { SessionManager, createSSEHandler, normalizeClaude } from '@liggi/agent-ui-harness/server'

// Analyst provides its direct PTY adapter
const adapter: ProcessAdapter = {
  async spawn(config) {
    const pty = spawn('claude', buildArgs(config), { ... })
    return wrapPtyHandle(pty)
  }
}

const sessions = new SessionManager(adapter)
const sseHandler = createSSEHandler(sessions)

// Replace existing /api/start, /api/stop, /api/stdin, /api/stream with harness endpoints
```

### Both frontends

```typescript
import { useSession } from '@liggi/agent-ui-harness/client'

function SessionView({ sessionId }) {
  const { status, activity, events, connected, send, stop } = useSession(sessionId, {
    baseUrl: '/api/session',
    onEvent: (event) => persistToMyStore(event),
  })

  // Transform events to app-specific message format
  const messages = useMemo(() => myEventsToMessages(events), [events])

  return (
    <>
      <StatusIndicator status={status} activity={activity} />
      <MessageList messages={messages} />
      <Input onSend={send} disabled={status === 'starting' || status === 'stopping'} />
      {status === 'streaming' && <StopButton onClick={stop} />}
    </>
  )
}
```

---

## Build Order

Tests are written before or alongside each layer. No layer ships without its test suite.

1. **`protocol/`** — Event types, status types, `deriveStatus`, `deriveActivity`, content block types. Full test suite including property-based tests. Zero dependencies.

2. **`server/event-log.ts`** — Append, query, subscribe, sliding window eviction. Tests for sequence monotonicity, `since()` correctness, subscriber notifications, eviction behavior.

3. **`server/json-lines-parser.ts`** — Buffers partial lines, emits complete JSON. Tests for split chunks, malformed input, ANSI stripping.

4. **`server/normalize-claude.ts`** — Claude CLI events → harness events. Tests for every CLI event type, validation of required fields, null return on garbage.

5. **`test/fake-process.ts`** — FakeProcess and FakeAdapter. Build the test infrastructure before the thing it tests.

6. **`server/session-manager.ts`** — The core. Start, send, stop, kill escalation, process exit, resume ID flow, multi-run lifecycle. Tested entirely via FakeAdapter. Regression suite for all 14 known bugs.

7. **`server/sse-handler.ts`** — SSE transport. Replay, heartbeat, reset on missing sequence, cleanup on disconnect. Tested with real HTTP server + fake timers.

8. **`client/sse-client.ts`** — Vendored parser + reconnection logic + tab visibility. Tested against the SSE handler from step 7.

9. **`client/use-session.ts`** — React hook. Reducer, derived status/activity, send/stop actions. Tested with React Testing Library against the full server stack.

Each layer depends only on the layers above it. No circular dependencies.

---

## Implementation Plan

### Principles

- **Incremental build with verification.** Each phase produces working, tested code. No "WIP" commits, no broken intermediate states. Every commit compiles and all tests pass.
- **Tests first or alongside.** If you're about to implement `stop()`, the test for kill escalation exists before or at the same time as the implementation.
- **Small commits with clear history.** Each commit is one logical unit. The git history should read like a tutorial of how the package was built.
- **Files stay small and focused.** If a file grows past ~200 lines, it's probably doing too much.
- **Types are self-documenting.** Someone reading `events.ts` should understand the protocol without reading prose.
- **Test descriptions explain scenarios**, not assertions. `'stop escalates from SIGINT to SIGKILL when process ignores signals'` not `'stop works'`.

### Project scaffold

Repo lives at `~/src/agent-ui-harness`. TypeScript, vitest, package.json with three subpath exports (`/protocol`, `/server`, `/client`).

```
agent-ui-harness/
├── src/
│   ├── protocol/
│   │   ├── events.ts          ← SessionEvent, ContentBlock, ResultBlock types
│   │   ├── derive.ts          ← deriveStatus, deriveActivity (pure functions)
│   │   └── index.ts           ← re-exports
│   ├── server/
│   │   ├── event-log.ts       ← EventLog class
│   │   ├── session-manager.ts ← SessionManager class
│   │   ├── sse-handler.ts     ← createSSEHandler
│   │   ├── json-lines-parser.ts
│   │   ├── normalize-claude.ts
│   │   └── index.ts
│   └── client/
│       ├── use-session.ts     ← React hook
│       ├── sse-client.ts      ← fetch-based SSE with reconnection
│       ├── sse-parser.ts      ← vendored from fetch-event-source
│       └── index.ts
├── test/
│   ├── helpers/
│   │   ├── fake-process.ts    ← FakeProcess, FakeAdapter
│   │   ├── fixtures.ts        ← real Claude CLI JSON output samples
│   │   └── test-server.ts     ← in-process HTTP server for SSE tests
│   ├── protocol/
│   │   ├── derive.test.ts
│   │   └── derive.property.test.ts  ← property-based tests
│   ├── server/
│   │   ├── event-log.test.ts
│   │   ├── json-lines-parser.test.ts
│   │   ├── normalize-claude.test.ts
│   │   ├── session-manager.test.ts
│   │   ├── session-manager.regression.test.ts  ← 14 known bugs
│   │   └── sse-handler.test.ts
│   └── client/
│       ├── sse-client.test.ts
│       └── use-session.test.ts
├── design.md                  ← this document
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Phase 0: Scaffold
Set up the repo. TypeScript config, vitest config, package.json with subpath exports. Copy in this design doc. `npm test` passes with zero tests.

**Commit**: `[scaffold] project setup with TypeScript, vitest, subpath exports`

### Phase 1: Protocol
Event types (`SessionEvent`, `ContentBlock`, `ResultBlock`), status types, `deriveStatus()`, `deriveActivity()`. Zero dependencies.

Full test suite: exhaustive cases for every event type and every transition. Property-based tests (using fast-check) for invariants — status always valid, `stop:requested` always produces `stopping`, `run:end` always produces `idle`, status never goes backwards within a run without a new `run:start`.

**Verify**: `npm test` — all pass. Read through `events.ts` — could someone understand the protocol without this doc?

**Commit**: `[protocol] event types and status/activity derivation`

### Phase 2: EventLog
`EventLog` class: append, `since(afterSeq)`, `latest()`, subscribe/unsubscribe, sliding window eviction, `length` and `subscriberCount` getters.

Tests: sequence monotonicity, `since()` with various boundaries (before all events, between events, after all events, exactly at an event), subscriber notification ordering, eviction (events below threshold removed, events above preserved, `since()` with evicted sequence triggers appropriate behavior), edge cases (empty log, single event).

**Verify**: `npm test` — all pass.

**Commit**: `[server] EventLog with sliding window and subscriptions`

### Phase 3: Parser + Normalizer
JSON lines parser: buffer partial lines, emit complete JSON objects, handle ANSI escape sequences in output.

Claude CLI normalizer: system/init → `run:ready`, assistant → `content`, user → `result`, result → `turn:end`. Validation: missing required fields returns null, unknown event types return null, logged at warn level.

Tests — Parser: complete line, split across chunks, malformed JSON (skip and continue), ANSI sequences stripped. Normalizer: real Claude CLI fixtures for every event type (capture samples from both repos), validation rejection of bad input, null return on unknown types.

**Verify**: `npm test` — all pass. Spot-check normalizer against actual CLI output.

**Commit**: `[server] JSON lines parser and Claude CLI normalizer`

### Phase 4: Test infrastructure
`FakeProcess`: implements `ProcessHandle`. Controllable stdout (emitLine), stdin capture (stdinWrites array), signal capture (signals array), programmable exit (exit method resolves the exited promise), `alive` flag.

`FakeAdapter`: implements `ProcessAdapter`. Wraps `FakeProcess`. Maps session IDs to fakes via a `processes` Map.

Tests for the test infra itself — verify FakeProcess behaves like a real ProcessHandle.

**Verify**: `npm test` — all pass. Simulate a simple scenario (emit init, emit content, exit) through FakeProcess and verify the interface works.

**Commit**: `[test] FakeProcess and FakeAdapter test infrastructure`

### Phase 5a: SessionManager — start and stop
`start()`: spawn via adapter, pipe stdout through JSON lines parser → normalizer → event log. Store process handle. Handle exit via `exited` promise.

`stop()`: kill escalation SIGINT (0s) → SIGTERM (3s) → SIGKILL (5s). Append `stop:requested` on call. Append `run:end` on exit.

`getStatus()`, `getLog()`.

Tests with FakeAdapter: start session and verify events in log, stop and verify full escalation sequence (with fake timers), stop when process responds to SIGINT (verify no SIGTERM/SIGKILL), stop when not streaming (no-op), stop when already stopping (no-op).

**Verify**: `npm test` — all pass.

**Commit**: `[server] SessionManager — start and stop lifecycle`

### Phase 5b: SessionManager — send, resume, multi-run
`send()`: write to stdin when streaming/idle with live process. Spawn new run when process dead (with `--resume`). Reject when starting/stopping.

Resume ID flow: extract from `run:ready` event data, store on session, pass to spawn config.

Tests: send while streaming (stdin write + input:sent event), send while idle with live process (stdin write), send while idle with dead process (new run spawned with resume), send while starting (throws), send while stopping (throws), multi-run on same session (first run ends, second run starts, events accumulate correctly).

**Verify**: `npm test` — all pass.

**Commit**: `[server] SessionManager — send, resume, multi-run`

### Phase 5c: SessionManager — errors, diagnostics, cleanup
Error paths: spawn failure (run:start → run:error → throw), process crash (run:end with reason:'crashed').

Logger integration: structured logging at all key points.

`inspect()`: diagnostic snapshot. `destroy()`: force-kill + remove from map.

Server-side `onEvent` callback: fires on every event append.

Tests: spawn failure (adapter rejects), process crash (non-zero exit), inspect output matches expected shape, destroy while streaming (process killed, session removed), onEvent callback fires correctly.

**Verify**: `npm test` — all pass.

**Commit**: `[server] SessionManager — error handling, diagnostics, cleanup`

### Phase 5d: Regression suite
One test per known Lattice/Analyst bug. All 14. Each test uses FakeAdapter and reproduces the exact scenario that caused the regression, verifying harness's design prevents it.

These are the highest-value tests in the entire package. They document exactly what went wrong before and prove it can't happen here.

**Verify**: `npm test` — all pass. Read through the test file — does each test clearly explain the original bug and how harness prevents it?

**Commit**: `[test] regression suite — 14 known failure modes`

### Phase 6: SSE transport
`createSSEHandler(manager)`: Express/Node HTTP handler. Set headers (content-type, cache-control, X-Accel-Buffering). Replay from `log.since(afterSeq)`. Subscribe for live events. Heartbeat every 10s (SSE comment). Send `reset` event when requested sequence is unavailable. Cleanup on disconnect (unsubscribe, clear heartbeat).

Tests with real in-process HTTP server: connect and receive replayed events, connect with `after=N` and receive only events after N, heartbeat arrives within interval, disconnect triggers cleanup (subscriber removed), request events older than sliding window → reset event, multiple clients on same session (both receive events).

**Verify**: `npm test` — all pass.

**Commit**: `[server] SSE transport handler`

### Phase 7: SSE client
Vendor `getBytes`, `getLines`, `getMessages` from fetch-event-source (~160 lines). Add our own reconnection logic with exponential backoff. Tab visibility handling.

`connectSSE()`: fetch + three-layer parser. `connectWithRetry()`: exponential backoff, max retries, reset handling.

Tests against the real SSE handler from phase 6: connect and receive events, simulate disconnect (server closes), verify reconnect with correct `after` parameter, simulate server restart (reset event), verify backoff timing (with fake timers), tab visibility (simulate hide/show, verify disconnect/reconnect).

**Verify**: `npm test` — all pass. Full round-trip: FakeProcess → SessionManager → EventLog → SSE handler → SSE client.

**Commit**: `[client] SSE client with reconnection and tab visibility`

### Phase 8: React hook
`useSession(sessionId, options)`: manages SSE client lifecycle, accumulates events via reducer (5 actions), derives status/activity via useMemo, exposes send/stop actions that call server API.

Tests with React Testing Library against the full server stack: mount with sessionId → verify initial connection and event replay. Events arrive → verify status transitions. Switch sessionId → verify old connection torn down, new one established. Disconnect → verify `connected` goes false then true. Call `send()` → verify API call. Call `stop()` → verify API call. Null sessionId → verify no connection attempted.

**Verify**: `npm test` — all pass.

**Commit**: `[client] useSession hook`

### Phase 9: Integration smoke test
A test script that mimics Claude CLI's `stream-json` output (emit init, content with thinking, content with tool_use, user with tool_result, result — all as JSON lines). A real ProcessAdapter that spawns this script.

End-to-end test: spawn → SSE → React hook. Verify the full chain: status transitions (starting → streaming → idle), activity derivation (thinking → tool → null), event accumulation, stop works, send works.

This is the confidence check that all layers compose correctly with no mocking.

**Verify**: `npm test` — all pass including integration.

**Commit**: `[test] end-to-end integration smoke test`

---

## App-Specific Concerns (Not Harness's Problem)

These features exist in Lattice and/or Analyst and are **explicitly outside harness**. Apps build them on top of harness's raw events and actions.

### Permission hooks (Lattice)
Permissions flow through a separate HTTP channel (CLI → hook URL → Lattice server → CLI). Completely independent of the event stream. Lattice keeps its hook middleware as-is and uses harness only for session lifecycle.

### Plan mode (Lattice)
Shows up as regular content blocks in the event stream. The app inspects content and recognizes plan mode signals. The app renders a plan-specific UI. User input goes through `send()` as normal stdin injection.

### MCP tools (both apps)
Tool use/result blocks pass through as `content` and `result` events. The app recognizes tool names (e.g., `mcp__slack__send_message`) and renders tool-specific UI components. Harness delivers the blocks opaquely.

### Analyst UI blocks (Analyst)
Custom renderers for charts, tables, analysis summaries. These are tool result content blocks that the app knows how to render. Harness delivers raw blocks; Analyst's `eventsToMessages()` maps them to rich UI components.

### Status layering
During app-specific pauses (permission wait, plan review), harness reports `streaming` (process is alive). Apps derive richer status by combining harness status with their own state:

```typescript
const { status, events } = useSession(sessionId, options)

const appStatus = useMemo(() => {
  if (status === 'streaming' && permissionPending) return 'waiting_for_permission'
  if (status === 'streaming' && planModeActive) return 'reviewing_plan'
  return status
}, [status, permissionPending, planModeActive])
```

---

## Prior Art & Influences

- **Vercel AI SDK** (UIMessageStream + useChat) — closest existing architecture. Same SSE-with-typed-events pattern, same 4-state status machine. Key gap: no reconnection replay (disconnect = lose state). Harness solves this with sequence-numbered events.
- **@microsoft/fetch-event-source** — production-grade SSE parser (~160 lines, zero-copy). Vendored for the client. Tab visibility pattern adopted from here.
- **better-sse** — testing patterns (real HTTP servers + fake timers). SSE comment heartbeats. Not used as dependency (no replay support).
- **Event sourcing** — the core principle (append-only log, derived state) comes from event sourcing. But harness is a runtime buffer, not a database. Apps persist events if they want durability.
