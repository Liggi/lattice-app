# Behavioral Tests

Playwright-based behavioral contract tests. Assert on rendered UI, not implementation details.

## Running

```bash
pnpm test                # all behavioral tests
pnpm test:behavioral     # same
npx playwright test --config test/behavioral/playwright.config.ts contracts/31-compact-history-replay.spec.ts  # single file
```

Server auto-starts on port 4200 (or reuses existing). Must `pnpm build` first — tests serve from `dist/web`.

## Architecture

```
server.ts          → boots LatticeServer; pins ScenarioProcessAdapter as session manager adapter
                     ProcessDaemon starts in-process on ephemeral socket (harness client init only;
                     poisoned executable path so any spawn bypass fails loudly, not silently)
scenarios/         → JSON files defining stub behavior (event sequences + stdin responses)
cassettes/         → real CLI recordings (JSONL), replayed via CassetteAdapter
contracts/         → Playwright spec files (numbered 25+)
scenario-process-adapter.ts → in-process ProcessAdapter; replays scenario JSON; no real CLI
```

## Scenarios (JSON)

Scenarios define what the agent stub emits. Used for timing-sensitive and deterministic tests.

```json
{
  "name": "my-scenario",
  "events": [                           // response to initial prompt
    { "type": "system_init" },          // → system/init (run:ready)
    { "type": "assistant", "content": [ // → assistant message (content)
      { "type": "text", "text": "Hello" }
    ]},
    { "type": "result", "duration_ms": 100 },  // → result (turn:end)
    { "type": "raw", "event": { ... } }         // → pass-through (any event shape)
  ],
  "on_stdin": {
    "responses": [                      // indexed: first follow-up, second, etc.
      [ ...events... ],
      [ ...events... ]
    ]
  },
  "resume_events": [ ... ],            // played instead of events when --resume is passed
  "exit_after_main": true,             // exit immediately after main sequence
  "startup_delay": 500                 // ms delay before first output
}
```

Event types: `system_init`, `assistant`, `result`, `raw`. Content blocks: `text`, `thinking`, `tool_use`. Use `raw` for edge-case events like `compact_boundary`.

## Cassettes (JSONL)

Real CLI session recordings. Never hand-craft. Record via `/record-cassette` skill.

```jsonl
{"type":"meta","ts":0,"format":1}
{"type":"stdout","ts":4340,"data":"{\"type\":\"system\",\"subtype\":\"init\",...}"}
{"type":"stdin","ts":5000,"data":"{\"type\":\"user\",...}"}
{"type":"exit","ts":7439,"code":0}
```

- `ts` = milliseconds since recording start
- `data` = double-encoded JSON (stringified CLI event)
- `timescale` parameter controls replay speed (0.05 = 50x faster)

## Test Control Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/test/reset` | Clear all state between tests |
| `POST /api/test/set-scenario` | Set scenario for next spawn (`{scenario: "name"}`) |
| `POST /api/test/set-cassette` | Replace adapter with CassetteAdapter (`{cassette: "name", timescale?: 0.05}`) |
| `POST /api/test/seed-conversation` | Create conversation record (`{provider: "claude"}`) → returns `{conversationId}` |
| `POST /api/test/inject-message` | Insert event into storage (`{sessionId, role, content}`) |
| `POST /api/test/inject-events/:id` | Bulk-inject padding events (`{count: N}`) |
| `POST /api/test/destroy-session/:id` | Remove session from memory (simulates restart) |
| `POST /api/test/kill-session/:id` | SIGKILL the session process |

## Common Test Patterns

```typescript
// Setup
test.beforeEach(async () => { await resetServer(); });

// Start session
await setScenario('my-scenario');
const convId = await startSessionInBrowser(page, 'Hello');

// Assert messages
await expect(page.getByTestId('assistant-message').filter({ hasText: 'Hello' })).toBeVisible({ timeout: 15000 });
await expect(page.getByTestId('user-message')).toHaveCount(1);

// Send follow-up
await sendMessage(page, 'Next message');

// Check composer state
await expect(page.getByTestId('composer-input')).toBeEditable({ timeout: 5000 });
```

## Test IDs

`user-message`, `assistant-message`, `thinking-block`, `composer-input`, `send-button`, `tool-<ToolName>`, `pending-message`.
