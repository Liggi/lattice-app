# Claude Code Integration Map

Reference doc for Lattice's CLI integration surface with Claude Code. Based on source analysis of CC's SDK protocol, control schemas, and Lattice's current harness pipeline.

## Architecture

The CC Agent SDK (`@anthropic-ai/claude-code`) is a convenience wrapper — it spawns the CLI as a subprocess with `--input-format=stream-json --output-format=stream-json` and manages bidirectional NDJSON over stdin/stdout. **The SDK adds no capabilities the CLI doesn't expose.** Everything — multi-turn, permissions, interrupts, MCP, hooks — uses the same NDJSON control protocol.

Lattice integrates via CLI directly: `SessionManager → DaemonProcessAdapter → ProcessDaemon → spawn('claude', [...])`.

## Current State

### What works today

| Direction | What | Where in Lattice |
|---|---|---|
| **stdout → Lattice** | `system/init`, `assistant`, `user` (tool_result), `result`, `compact_boundary` | `normalizeClaude()` → harness EventLog → SSE |
| **Lattice → stdin** | User messages (`{ type: 'user', message: {...} }`) | `DaemonProcessAdapter.write()` → daemon `handleWrite()` |
| **Lattice → signal** | SIGINT for interrupt | `SessionManager.stop()` → `ProcessHandle.signal('SIGINT')` |

Spawn uses `--input-format stream-json --output-format stream-json`. Stdin stays open after first turn. Multi-turn works — `SessionManager.send()` writes to stdin if process alive, respawns with `--resume` if dead.

### What CC sends that Lattice ignores

These hit `default: return null` in `normalizeClaude()`:

| CC stdout message | What it means | Opportunity |
|---|---|---|
| `control_request: can_use_tool` | CC blocked waiting for permission decision | Render permission prompt in UI, send `control_response` back |
| `control_request: initialize` | SDK handshake ready | Register hooks, configure MCP servers |
| `stream_event` | Token-by-token streaming delta | Real-time streaming instead of waiting for full assistant message |
| `system: status` | Compacting, permission mode changes | "Compacting..." indicator |
| `system: api_retry` | API failed, retrying | Retry indicator with attempt count |
| `rate_limit_event` | Rate limit info | Rate limit warnings |
| `control_cancel_request` | CC cancelled a pending control request | Clean up stale permission prompts |

### What Lattice could send but doesn't

| Stdin message | What it does | Opportunity |
|---|---|---|
| `control_response: can_use_tool` | Answer a permission prompt | User approves/denies tools from UI |
| `control_request: interrupt` | Clean interrupt (better than SIGINT) | Graceful stop without signal races |
| `control_request: set_model` | Change model mid-session | Model switcher |
| `control_request: set_permission_mode` | Change permission mode | Permission mode switcher |
| `control_request: mcp_status` | Query MCP server health | MCP dashboard |
| `control_request: get_context_usage` | Context window breakdown | Token usage by category |
| `control_request: rewind_files` | Undo file changes to a message | "Undo to here" feature |

## Three Highest-Value Changes

### 1. Permission prompts in the UI

Currently using `--dangerously-skip-permissions`. Handle `control_request: can_use_tool` from stdout → render prompt → send `control_response` on stdin. CC blocks cleanly while waiting. Enables per-tool approval in the browser.

### 2. Streaming deltas

`stream_event` carries `RawMessageStreamEvent` (Anthropic API streaming format) — token-by-token output. Currently waiting for full `assistant` message. Handling this gives real-time streaming.

### 3. Clean interrupt via control protocol

Instead of `process.kill('SIGINT')` with escalation timers, send `{ type: 'control_request', request_id: uuid, request: { subtype: 'interrupt' } }` on stdin. Cleaner, no signal race.

## CC Hook Events (lifecycle API)

26 hook events form CC's lifecycle contract. Most interesting for Lattice:

- `PreToolUse` / `PostToolUse` — tool execution lifecycle
- `Stop` / `StopFailure` — turn completion
- `SubagentStart` / `SubagentStop` — agent spawning
- `SessionStart` / `SessionEnd` — session lifecycle
- `PreCompact` / `PostCompact` — context compaction
- `TaskCreated` / `TaskCompleted` — task tracking
- `FileChanged` — file watcher events

## CC Message Type Reference

### stdout (StdoutMessage union)

```
SDKMessage (system/init, assistant, user, result, stream_event, rate_limit_event, compact_boundary, status, api_retry, local_command_output)
SDKStreamlinedTextMessage (streamlined_text — text only, no thinking/tool_use)
SDKStreamlinedToolUseSummaryMessage (streamlined_tool_use_summary)
SDKPostTurnSummaryMessage (post_turn_summary — background agent status)
SDKControlRequest (control_request — permission prompts, hook callbacks, elicitations)
SDKControlResponse (control_response — answers to stdin control_requests)
SDKControlCancelRequest (control_cancel_request)
SDKKeepAliveMessage (keep_alive)
```

### stdin (StdinMessage union)

```
SDKUserMessage (type: 'user' — user turns, tool results)
SDKControlRequest (control_request — interrupt, set_model, set_permission_mode, mcp_status, etc.)
SDKControlResponse (control_response — permission decisions)
SDKKeepAliveMessage (keep_alive)
SDKUpdateEnvironmentVariablesMessage (update_environment_variables)
```

## Source References

- CC control protocol schemas: `claude-code-yasas/src/entrypoints/sdk/controlSchemas.ts`
- CC message schemas: `claude-code-yasas/src/entrypoints/sdk/coreSchemas.ts`
- CC structured IO (stdin/stdout handler): `claude-code-yasas/src/cli/structuredIO.ts`
- CC SDK type stubs: `claude-code-yasas/src/entrypoints/agentSdkTypes.ts`
- Lattice normalizer: `agent-ui-harness/src/server/normalize-claude.ts`
- Lattice daemon adapter: `lattice-orchestrator/src/harness/daemon-process-adapter.ts`
- Lattice process daemon: `lattice-orchestrator/src/process-daemon/process-daemon.ts`
