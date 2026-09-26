# Codex Provider

Lattice supports Codex as a first-class conversation provider through the Codex CLI app-server protocol.

## Runtime Shape

Codex sessions run through the same harness event pipeline as Claude conversations:

1. `POST /api/conv/create` or `/resume` creates or resumes a `conversation_segments` row with `provider = 'codex'`.
2. The harness receives `extra.provider = 'codex'` and the `MultiplexingProcessAdapter` routes the spawn to `CodexProcessAdapter`.
3. `CodexProcessAdapter` talks to `codex app-server --listen stdio://` through `CodexAppServerClient`.
4. Before starting or resuming the Codex thread, Lattice calls `account/read` with `refreshToken: true` so managed ChatGPT auth is refreshed through the app-server protocol.
5. Codex app-server notifications are translated into Claude-compatible stream-json lines so the existing harness normalizer can produce canonical events:
   - `system/init` -> `run:ready`
   - `item/agentMessage/delta` -> assistant `content`
   - command/tool starts -> assistant `tool_use`
   - command/tool completions -> user `tool_result`
   - `turn/completed` -> `turn:end`
6. Provider identity is preserved from the harness `run:start.data.config.extra.provider` field when events are read back into UI and server-side unified messages.

This keeps the transport-specific Codex protocol isolated while preserving the current harness event store, SSE stream, message renderer, and status derivation.

## App-Server Configuration

Lattice starts one Codex app-server process per runtime sharing key. Today that
key is the session's workspace value or starting directory. It controls process
reuse only; it does not own authentication or integrations. The client is
spawned with:

```text
codex -c preferred_auth_method=chatgpt -c features.goals=true app-server --listen stdio://
```

The client initializes with `capabilities.experimentalApi = true`.

Thread defaults:

```text
model: gpt-5.6-sol
reasoning effort: xhigh
sandbox: danger-full-access
approvalPolicy: never
auth: ChatGPT auth, not OPENAI_API_KEY
```

`OPENAI_API_KEY` is removed from the spawned app-server environment. Lattice requires the app-server `account/read { refreshToken: true }` preflight to succeed before a Codex thread starts or resumes, so refresh behavior comes from `~/.codex/auth.json` ChatGPT auth instead of API-key auth.

## Permissions

Claude permission modes do not map cleanly to Codex approval and sandbox modes. Lattice exposes a single fixed Codex mode:

```text
Codex approvalPolicy: never
Codex sandbox: danger-full-access
Lattice permissionMode: codex-bypass
```

There is no Codex mode picker in Lattice. Codex sessions always launch with full file and command access. Unexpected command, file-change, and permission approval requests are answered with no additional authority instead of hanging.

Codex accepts base64 images and text-file attachments. PDF attachments are
rejected visibly because the current app-server user-input union has no document
shape.

Live `request_user_input` calls use Lattice's pending-question UI and complete
the original JSON-RPC request when answered. Because that responder exists only
while the app-server process is alive, pending Codex questions are expired on
server boot rather than left as unanswerable rows.

Model and reasoning-effort choices can change on a later turn. Both values are
sent as sticky `turn/start` overrides, and assistant events report the model
that actually served the turn.

Branching remains hidden for Codex. The installed protocol exposes native
`thread/fork`, but Lattice must copy and re-key its own harness event history so
the new branch renders immediately and resumes the forked thread rather than the
parent.

## Goals

Codex goals are enabled with `features.goals=true`.

Supported HTTP routes:

```text
GET    /api/conv/:conversationId/goal
PUT    /api/conv/:conversationId/goal
POST   /api/conv/:conversationId/goal/pause
POST   /api/conv/:conversationId/goal/resume
DELETE /api/conv/:conversationId/goal
```

`PUT` accepts:

```json
{
  "objective": "include literal token CARROT in arithmetic answers",
  "status": "active",
  "tokenBudget": 100000
}
```

Goal lifecycle notifications are persisted as harness custom events:

```text
goal:updated
goal:cleared
codex:rateLimits
codex:threadStatus
codex:mcpStatus
```

The chat header shows Codex goal status and exposes set, pause, resume, and clear controls.

## Manual Smoke

Use the new-session provider switch and select Codex. Ask it to create a file:

```text
create /tmp/codex-bypass-smoke.txt with the word LANDED
```

Expected result: `/tmp/codex-bypass-smoke.txt` exists on disk and contains `LANDED`.

Before and after creating the session, compare `~/.codex/auth.json` and verify `last_refresh` moved during the Lattice-spawned Codex start preflight or turn start.
