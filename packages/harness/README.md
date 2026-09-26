# @liggi/agent-ui-harness

Session lifecycle for Claude Code in the browser — spawn it, stream its output, and survive refreshes, reconnects, and server restarts.

## The problem

Take a Claude Code web UI past the demo stage and you meet the same failure modes everyone does: the spinner that keeps spinning for a process that already died. The refresh that loses a turn in progress. The stop button that doesn't stop. Duplicate messages after a shaky reconnect. They share one root cause — several systems independently tracking whether a session is alive (the process, a server cache, the frontend), and disagreeing. Every fix adds a reconciliation pass, and every reconciliation pass adds a new window in which to disagree again.

## The fix

One append-only event log per session, and status as a *derived* value: `deriveStatus(events)` is a pure function over the log. The client runs the same function over the same events the server does, so the two cannot disagree — there is nothing to reconcile and no registry to fall out of sync. A refresh, a reconnect, or a server restart just replays the log.

## Install

```sh
npm install @liggi/agent-ui-harness
```

`react` is an optional peer dependency (`^18 || ^19`). You only need it for the `useSession` hook; the `./protocol` and `./server` entry points are React-free.

Three subpath exports:

| Entry point | Contents |
| --- | --- |
| `@liggi/agent-ui-harness/protocol` | Event types and the `derive*` functions. Safe on both sides of the wire. |
| `@liggi/agent-ui-harness/server` | `SessionManager`, SSE handlers, the Claude adapters, cassette record/replay. |
| `@liggi/agent-ui-harness/client` | `SSEClient` and the `useSession` React hook. |

Running either Claude adapter requires the `claude` CLI installed and logged in on the server — one interactive login, then every spawned process inherits it. No `ANTHROPIC_API_KEY` is needed. Details in [Running it on a server](#running-it-on-a-server).

## Quickstart — server

```js
import { createServer } from 'node:http'
import {
  SessionManager,
  ClaudeInteractiveAdapter,
  createSSEHandler,
} from '@liggi/agent-ui-harness/server'

const manager = new SessionManager(new ClaudeInteractiveAdapter())
const sse = createSSEHandler(manager)

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}))
  })

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const [root, sessionId, action] = url.pathname.split('/').filter(Boolean)
  if (root !== 'session' || !sessionId) return json(res, { error: 'not found' }, 404)

  // SSE stream. The handler reads the `after` query param itself — it is the
  // last seq the client already has, and 0 means a cold load.
  if (req.method === 'GET' && action === 'events') {
    return sse(req, res, sessionId)
  }

  // History paging. The client calls `/history?before=<seq>&limit=<n>` and
  // expects `{ events, hasMore }`, oldest-first, all with seq < before.
  if (req.method === 'GET' && action === 'history') {
    const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER)
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const log = manager.getLog(sessionId)
    const older = (log ? [...log.all()] : []).filter((e) => e.seq < before)
    const events = older.slice(Math.max(0, older.length - limit))
    return json(res, { events, hasMore: older.length > events.length })
  }

  if (req.method === 'POST') {
    const body = await readBody(req)
    try {
      if (action === 'start') {
        // body is a StartConfig: { prompt, cwd?, resume?, env?, args? }
        return json(res, await manager.start(sessionId, body))
      }
      if (action === 'send') {
        const { input, ...extra } = body
        await manager.send(sessionId, input, Object.keys(extra).length ? extra : undefined)
        return json(res, { ok: true })
      }
      if (action === 'stop') {
        await manager.stop(sessionId)
        return json(res, { ok: true })
      }
    } catch (err) {
      return json(res, { error: err.message }, 400)
    }
  }

  return json(res, { error: 'not found' }, 404)
}).listen(8787)
```

`manager.start()` resolves to `{ runId, processId? }`. `manager.send()` writes to the live process's stdin when it is still alive, and otherwise spawns a fresh run with the input as its prompt (resuming the CLI session if a resume id is known) — callers do not have to know which case they are in.

If you pass an `EventStorageAdapter` (see [Persistence](#persistence-and-recovery)), page history from `manager.readFromStorage(sessionId, { beforeSeq, limit })` instead of `log.all()`; it returns the newest `limit` events below `beforeSeq`, oldest-first.

For Web-standard `Request`/`Response` runtimes (Next.js route handlers, Hono, Workers), use `createWebSSEHandler` instead of `createSSEHandler`.

## Quickstart — client

```tsx
import { useSession } from '@liggi/agent-ui-harness/client'

export function Session({ sessionId }: { sessionId: string }) {
  const { status, events, send, stop, hydrationPhase, fetchHistory } = useSession(
    sessionId,
    { baseUrl: 'http://localhost:8787/session' },
  )

  return (
    <div>
      <button onClick={() => fetchHistory({ limit: 50 })}>Load older</button>
      <div>{status}</div>
      {events.map((e) => (
        <pre key={e.seq}>{e.type}</pre>
      ))}
      <button onClick={() => send('what changed in the last commit?')}>Send</button>
      <button onClick={stop} disabled={status !== 'streaming'}>Stop</button>
    </div>
  )
}
```

`baseUrl` is the prefix the hook appends session paths to: it fetches `${baseUrl}/${sessionId}/events`, `/history`, `/send` and `/stop`. The hook owns the SSE connection, reconnection with backoff, replay-cursor tracking and event dedup.

Beyond `status`, `events`, `send` and `stop`, the handle exposes `activity`, `connected`, `processAlive`, `usage`, `error`, `reconnect()`, `injectEvent()` and:

- **`hydrationPhase`** — `'hydrating'` until the initial SSE replay and any follow-up history backfill have both settled, then `'ready'`, once, permanently. Use it to suppress entry animations and scroll-up pagination while the client is still catching up, so replayed history does not look like live output.
- **`fetchHistory({ limit })`** — prepends the next older page from the server's history endpoint and returns `{ hasMore }`. Concurrent calls are coalesced, so firing it from an `IntersectionObserver` is safe.

## Concepts

### SessionId, RunId, seq

- **`sessionId`** is yours — one conversation, one event log. It outlives processes, server restarts, and browser refreshes.
- **`runId`** is one process lifetime inside that session. Each spawn gets a fresh `runId`, and every event records the run it was produced under. A session that continues after the CLI exits keeps its `sessionId` and log but starts a new run. (Distinct again from `resumeId`, the CLI's own session id reported in `run:ready` and passed back as `--resume`.)
- **`seq`** is a per-session counter assigned on append. It is the only cursor in the system: the SSE `id:` field, the `after` param on reconnect, the `before` param when paging history, and the client's dedup key.

### Event vocabulary

Twelve event types, exported as `EVENT_TYPES` from `/protocol`. Some are normalized from the CLI's `stream-json` output; the rest are recorded by the harness itself around the process lifecycle.

| Type | Meaning |
| --- | --- |
| `run:start` | A spawn was requested. Carries the `StartConfig` it was spawned with. |
| `run:ready` | The CLI booted and announced itself: `resumeId`, model, tools, cwd, MCP servers, permission mode. |
| `run:end` | The process is gone. `reason` is one of `completed`, `stopped`, `interrupted`, `error`, `process_exit`, `idle_timeout`, `server_restart`. |
| `run:error` | The run failed — spawn failure or a stream-level error. Carries a message. |
| `stop:requested` | A stop was asked for. `SIGINT` has been sent; escalation to `SIGTERM`/`SIGKILL` follows only if the CLI does not respond. |
| `content` | An assistant message: `text`, `thinking` and `tool_use` blocks, plus per-API-call token usage and the model that actually served it. |
| `result` | Tool results coming back — `tool_result` blocks, with `is_error` where the tool failed. |
| `turn:end` | The CLI finished a turn. Carries usage totals, duration, cost, and a `compact` flag on compaction boundaries. |
| `input:sent` | Text was delivered to the process — the initial prompt, a user message, or a scheduled wakeup (`source`). |
| `task:started` | A background task began: a backgrounded Bash command (`local_bash`) or a subagent (`local_agent`). |
| `task:updated` | A background task changed status. |
| `task:notification` | The CLI signalled that a background task finished. |

### Derived state

Everything the UI shows about session state is a pure function of the log, exported from `/protocol`:

- **`deriveStatus(events)`** → `'idle' | 'starting' | 'streaming' | 'stopping'` — the one both sides run.
- **`deriveProcessAlive(events)`** → whether the CLI process still exists. A keep-alive session between turns is *idle but alive*, which status alone cannot express.
- **`deriveUsage(events)`** → token totals, cost, and real context-window size for the latest turn.
- **`deriveBackgroundTasks(events)`** → backgrounded Bash tasks and their current status.
- Also: `deriveActivity`, `hasRunningBackgroundTasks`, `deriveScheduledWakeup`, `derivePlanOutcomes`, and the `classify/` helpers for rendering (`classifyTool`, `groupEvents`, `extractSubagentChildren`, `detectPendingMessages`).

## Adapters

The harness never spawns anything itself. It talks to one interface:

```ts
interface ProcessAdapter {
  spawn(config: SpawnConfig): Promise<ProcessHandle>
}

interface ProcessHandle {
  stdout: AsyncIterable<string>              // one JSON line per CLI event
  write(input: string, extra?: Record<string, unknown>): void
  signal(sig: NodeJS.Signals): void
  exited: Promise<{ code: number; signal?: string }>
  alive: boolean
  pid?: number
  processId?: string                          // adapter-specific id, if any
}
```

Two adapters ship in the box, both spawning the `claude` CLI and both reading its `stream-json` output. They differ in one thing: whether the process survives the end of a turn.

| | `ClaudeCliAdapter` | `ClaudeInteractiveAdapter` |
| --- | --- | --- |
| Flags | `--print --output-format stream-json --verbose` | `--output-format stream-json --input-format stream-json --verbose` |
| Process lifetime | One turn, then exit | Stays alive between turns |
| Follow-up | Respawns with `--resume` and the message as the new prompt | Written to the live process's stdin |
| Interrupting a turn | Kills the process; the next message starts a new one | `SIGINT` cancels the turn, the session survives |
| Prompt delivery | Final argv element | A `stream-json` user message on stdin |
| Images / documents | Not supported | `extra.contentBlocks` |
| Use it for | Scripts, one-shot jobs, cassette recording | Chat UIs |

**`ClaudeCliAdapter`** is the simple one, and the one the cassette recorder uses. Each turn is a fresh process, so a follow-up costs a respawn and a `--resume` handshake, and there is no way to stop mid-turn and keep going.

**`ClaudeInteractiveAdapter`** adds `--input-format stream-json`, which leaves the CLI sitting on stdin reading JSON user messages instead of exiting after one turn. That single flag is what buys the rest: follow-ups become a stdin write, conversation state never has to be rebuilt, and `SessionManager.stop()` can interrupt. Its escalation sends `SIGINT` first — "cancel this turn" — and if the CLI answers with a `turn:end`, escalation stops and the process stays up for the next message. `SIGTERM`/`SIGKILL` are only reached when the CLI does not answer, and go to the whole process group so the CLI's own children go with it.

```ts
import { SessionManager, ClaudeInteractiveAdapter } from '@liggi/agent-ui-harness/server'

const manager = new SessionManager(
  new ClaudeInteractiveAdapter({
    // claudeBin      — path to the binary. Defaults to CLAUDE_BIN, then the
    //                  usual install locations, then a PATH scan (findClaudeBin).
    // extraArgs      — extra CLI flags, e.g. ['--model', 'sonnet'].
    // env            — env vars for the child. SpawnConfig.env wins over these.
    // stripEnvKeys   — replaces the default strip list (see below).
    // skipPermissions — see the warning below. Off by default.
  }),
)
```

**`skipPermissions` adds `--dangerously-skip-permissions`.** It is off by default so that turning it on is a decision rather than an accident — not because leaving it off is the norm. In practice most real deployments run with it on: a headless session has nobody at a prompt to approve tool calls, and a fully-capable agent is usually the point of self-hosting one. The safety lives in reachability and blast radius, not in the flag — a dedicated Unix user, a machine you control, a private network. Keep it off and configure an allowlist in `~/.claude/settings.json` instead when the server is shared or the account has access you care about.

Two other things the adapter does that are easy to miss:

- **Structured content.** Pass `extra.contentBlocks` — an array of Anthropic content blocks — on `start()` or `send()` to attach images and documents. The blocks go first in the message content, then the text: `manager.send(id, 'what is in this?', { contentBlocks: [imageBlock] })`.
- **Env cleaning.** `NODE_OPTIONS`, `VSCODE_INSPECTOR_OPTIONS`, `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` are stripped from the child — otherwise a debugger on the host attaches to the CLI, and a host running inside Claude Code makes the child think it is a nested session. Override with `stripEnvKeys`.

### Writing your own adapter

The harness is already keep-alive-aware — `send()` writes to stdin when the process is alive, and `deriveProcessAlive` distinguishes idle-alive from dead — so a custom adapter (a daemon bridge, a sandbox runtime, a different agent CLI) is the only piece you need to write. One thing you don't need is a PTY: `stream-json` is newline-delimited JSON on a pipe, and a terminal actively works against it — ANSI escapes, terminal write buffering, and line wrapping at the terminal width can each corrupt a JSON line.

## Why not just `claude -p`?

`claude -p` gives you one shot. There is no way to interrupt it mid-turn, nothing keeps the process alive between turns, a dropped connection loses the output, and nothing is persisted for the next page load. This package is the lifecycle layer around it: stop and escalation, keep-alive and resume, SSE streaming with reconnect and replay, and a durable event log.

## Running it on a server

The quickstart runs anywhere Node and the `claude` CLI are installed. Moving it to a real server adds three concerns: auth, permissions, and exposure.

**Auth — one login, once.** The spawned CLI inherits the credentials of the Unix user it runs as. SSH in as the user your server will run under, run `claude`, and complete the login — on a headless box the CLI gives you an OAuth URL to open in a local browser and a code to paste back. Credentials persist in that user's home directory; every process the harness spawns from then on is authenticated. You are on your normal Claude Code login, not API billing. Two corollaries: everyone who can reach your UI acts as that one account, and if an `ANTHROPIC_API_KEY` *is* present in the service environment, the child process inherits it and the CLI switches to API billing.

**Permissions — decide up front.** Headless mode has no terminal to show an approval prompt on, so any tool call that would normally ask is denied. Either pre-approve what the agent may do — a permission mode or allowlist in that user's `~/.claude/settings.json` — or run the whole thing in a disposable sandbox with `skipPermissions: true` (see the [warning above](#adapters)). If your first deployment fails with every Bash call denied, this is why.

**Exposure — never raw.** The quickstart endpoints have no authentication of their own, and anyone who can reach them can run commands on your server as that Unix user. Bind to localhost or a private network, never a public interface. For personal use, a tailnet (Tailscale or similar) is the sweet spot: the server is reachable from all your devices and nothing else. For anything multi-user, put an authenticating reverse proxy in front — and treat per-user isolation as a design question, not a config option.

Run it under a process supervisor (systemd, launchd) as that same logged-in user, and the whole setup is: install the CLI, log in once, start the server, join the tailnet.

## Persistence and recovery

Pass an `EventStorageAdapter` and every appended event is written through to it:

```ts
const manager = new SessionManager(adapter, { storage: myStorage })
```

The interface is synchronous (`EventLog.append()` cannot defer), so async backends should buffer and flush outside the call path. `test/helpers/memory-storage.ts` in this repo is a complete reference implementation.

With storage configured:

- **In-memory eviction stops mattering.** The log keeps a bounded window (2000 events by default); reads past it fall through to storage.
- **Server restarts recover honestly.** `recoverFromStorage(sessionId)` rebuilds the log and the resume identity. If the session was mid-stream when the server died, it appends a synthetic `run:end` with `reason: 'server_restart'` (marked `inferred`, `source: 'recovery'`), so the session derives as idle instead of showing a streaming spinner attached to a process that no longer exists.
- **Incoherent reconnect cursors are reset, not patched.** If a client reconnects with an `after` seq past the stored tail, or with a gap too large to replay contiguously, the server replays the tail window and sets `reset: true` on the replay metadata — telling the client to rebuild rather than silently accumulate a gapped list.

## Cassettes

Record a real CLI session once, replay it deterministically forever — in your own tests, or to develop your UI without spawning the CLI or spending tokens. `CassetteRecorder` wraps any `ProcessAdapter` and tees stdout, stdin and exit — with timing — to a JSONL file while passing everything through untouched:

```ts
const recorder = new CassetteRecorder(new ClaudeCliAdapter())
const handle = await recorder.spawn({ prompt: 'read package.json and name the package' })
for await (const line of handle.stdout) { /* ... */ }
await handle.exited
writeFileSync('fixture.jsonl', serializeCassette(recorder.getRecording()))
```

`CassetteAdapter` replays that recording as a `ProcessAdapter`, preserving inter-event timing (`timescale: 0.01` for fast tests) and pausing at stdin markers until `write()` is called, so mid-turn injection is reproducible:

```ts
const replay = CassetteAdapter.fromString(readFileSync('fixture.jsonl', 'utf8'), { timescale: 0.01 })
const manager = new SessionManager(replay)
```

This is how the repository's own regression suite stays faithful to real CLI output: the fixtures in `test/cassettes/` are recordings of actual Claude CLI sessions, not hand-written JSON.

## Development

```sh
npm install
npm run typecheck
npm test        # 563 tests, vitest — hermetic, no CLI required
npm run build

# Opt-in: drives the real claude binary and spends real tokens.
RUN_CLI_TESTS=1 npx vitest run test/integration/claude-interactive-cli.smoke.test.ts
```

The default suite spawns real child processes but never the real CLI. The one test that does is skipped unless `RUN_CLI_TESTS=1`; it checks that `ClaudeInteractiveAdapter`'s flags and stdin framing still match the installed CLI, and that a follow-up is served by the same pid rather than a respawn.

## Status

0.x. The API may move between minor versions. MIT licensed.
