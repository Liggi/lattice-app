# Harness Test Suite

Vitest-based unit and integration tests for `@liggi/agent-ui-harness`.

## Running

```bash
npx vitest run                              # all tests
npx vitest run test/server/sse-handler.test.ts  # single file
npx vitest --watch                          # watch mode
```

## Directory Structure

```
test/
├── server/          # Server-side: SSE handler, session manager, event log, normalize, cassette replay
├── client/          # Client-side: useSession hook (requires jsdom/happy-dom)
├── protocol/        # Protocol: derive status/activity from events, event grouping
├── integration/     # Cross-cutting: full pipeline from CLI output to derived state
├── helpers/         # Test utilities
│   ├── fixtures.ts      # Real CLI event shapes (INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS, COMPACT_BOUNDARY, etc.)
│   ├── fake-process.ts  # FakeAdapter + FakeProcess — programmable process for testing SessionManager
│   └── test-server.ts   # In-process HTTP server mounting SSE + history + start/send/stop endpoints
└── cassettes/       # Real CLI session recordings (JSONL) for cassette replay tests
```

## Key Test Patterns

### SSE handler tests (`test/server/sse-handler.test.ts`)

Test the Node.js SSE handler via HTTP against an in-process server.

```typescript
let adapter: FakeAdapter
let manager: SessionManager
let baseUrl: string
let close: () => Promise<void>

beforeEach(async () => {
  adapter = new FakeAdapter()
  manager = new SessionManager(adapter)
  const server = await createTestServer(manager)
  baseUrl = server.baseUrl
  close = server.close
})

afterEach(async () => { await close() })
```

**FakeProcess** gives synchronous control over a simulated CLI:
- `fake.emitLine(JSON.stringify(INIT_EVENT))` — emit a CLI stdout line
- `fake.exit(0)` — simulate process exit
- `fake.stdinWrites` — captured stdin writes for assertions
- `fake.signals` — captured signals for assertions

**collectEvents** reads SSE stream until count reached or timeout:
```typescript
const { events, comments } = await collectEvents(`${baseUrl}/session/s1/events?after=0`, 10, 1000)
```

### Session manager tests

Use FakeAdapter + FakeProcess to test start/send/stop/signal without real processes.

### Cassette replay tests

Load real JSONL recordings via CassetteAdapter and verify event normalization, timing, stdin gating.

## Fixtures (`test/helpers/fixtures.ts`)

Pre-built Claude CLI stream-json events:
- `INIT_EVENT` — `system/init` (produces `run:ready`)
- `TEXT_ASSISTANT` — assistant message with text block (produces `content`)
- `THINKING_ASSISTANT` — assistant with thinking + text blocks
- `TOOL_USE_ASSISTANT` — assistant with tool_use block
- `TOOL_RESULT_USER` — user message with tool_result
- `RESULT_SUCCESS` — result event (produces `turn:end`)
- `COMPACT_BOUNDARY` — compact boundary (produces `turn:end` with `compact: true`)
- `TASK_STARTED`, `TASK_UPDATED`, `TASK_NOTIFICATION` — background task events

## Test Server (`test/helpers/test-server.ts`)

In-process HTTP server for SSE testing. Mounts:
- `GET /session/:id/events` — SSE handler (with 500ms heartbeat)
- `GET /session/:id/history` — history endpoint (serves from EventLog.all())
- `POST /session/:id/start` — start session
- `POST /session/:id/send` — send message
- `POST /session/:id/stop` — stop session

Listens on a random port. Returns `{ baseUrl, close }`.
