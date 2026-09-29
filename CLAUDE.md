# Lattice

Self-hosted web workspace for running Claude Code and Codex agents on projects.

## Start Here

Read only what matches the task:

- `docs/product-thesis.md` - product vision and roadmap
- `docs/visual-language-audit.md` - read before writing any UI. Cyan is the interactive accent; amber means caution only; body copy is Geist, not mono
- `test/behavioral/` - behavioral contract tests (Playwright)
- `src/server/register-app-routes.ts` - route registration (source of truth for API surface)

Keep this file repo-generic. Put machine-specific paths, hostnames, personal workflow rules, and private URLs in your user-level globals.

## Safety

### Critical rules

1. Do not casually break the running server.
   - Do not kill Node processes indiscriminately.
   - Do not run dev servers through the dashboard UI.
   - Do not use the wrong Node version for install/build work.

2. Native modules must be built with the Node toolchain this repo expects.
   - `better-sqlite3`, `node-pty`, and `sharp` are native.
   - If you mismatch Node versions, the server will crash with `NODE_MODULE_VERSION` errors.

3. Treat unexpected local changes as collaborator work.
   - Claude and humans may both be editing this repo at once.
   - Do not revert or discard changes you did not make unless the user explicitly asks.

### Safe operations

- Edit code under `src/`, `test/`, `docs/`, and `scripts/`
- Run tests: `pnpm test`
- Build: `pnpm build`
- Deploy safely: `pnpm deploy`

### Unsafe operations

- `npm run clean` while the server is running
- `npm run build:unsafe` while the server is running
- Manual `rm -rf dist`
- Broad process kills like `pkill -f node`

### Recovery

```bash
tail -50 ~/.lattice-app/logs/server.jsonl   # or $LATTICE_CONFIG_DIR/logs; `pnpm dev` also writes server.log
tail -50 ~/.lattice-app/logs/daemon.log
```

### Build safety

`pnpm build` and `pnpm deploy` are safe against the live server:

- builds go to staging first
- dist swaps atomically
- concurrent builds are serialized
- failed builds leave the live dist untouched

## Running

### Production

```bash
pnpm start            # node dist/cli.js serve; the server starts its own daemon
```

On Linux, `pnpm service:setup` installs optional systemd user units, managed with the `service:*` scripts.

### Development

```bash
pnpm dev
pnpm dev:debug
```

Debug logs go to `~/.lattice-app/logs/`.

### After code changes

- **`pnpm deploy`** (not `pnpm build`) for any backend, harness, or shared runtime change. `build` compiles but does NOT restart the server — the running process keeps old code in memory. `deploy` = build + restart. The restart goes through the launchd (`com.lattice.server`) or systemd service (`lattice-app-server`, named after the config dir) that runs this checkout; a server started with `pnpm start` must be restarted by hand, and deploy says so and exits non-zero.
- `pnpm deploy:quick` skips lint for faster iteration.
- For harness or toolkit changes: rebuild them with `pnpm build:packages`, then `pnpm deploy`.
- Dev-mode UI changes: restart the dev server if behavior looks stale.
- A source checkout started with `LATTICE_CLIENT=built` serves `dist/web` instead of Vite's dev client. A client-only change goes live with `pnpm build:web:live` (staged build, swapped into `dist/web`, no restart) and a page reload; for a toolkit change, run `pnpm build:packages` first (the build reads the toolkit's `dist` unless `LATTICE_TOOLKIT_SRC` points it at the source). Server, harness and daemon changes still need a restart.

### Concurrent deploys can trample each other

Multiple active Claude sessions may deploy over each other. When code behavior looks stale, check the bundle hash in the browser (via `window.__latticeDebug` or the network tab) against `dist/server/*.js` on disk before assuming a code bug. A mismatch means another session deployed on top of yours. Also confirm which checkout the running server was started from.

## What This System Is

Lattice has two long-lived runtime processes:

- `lattice-server` - Express API + static frontend
- `lattice-daemon` - PTY/process owner for provider sessions

The daemon and the Claude PTYs outlive server restarts, but in-flight stream events are not buffered across the gap. A server restart mid-response loses the in-flight output; the next user message resumes the conversation via `--resume`. Treat server restart as "session survives, current turn does not."

### Canonical IDs

Treat `conversationId` (`conv-*`) as the canonical external session ID.

There are other IDs in the system:

- provider session IDs
- streaming IDs
- legacy session IDs

Common rule:

- API surfaces, frontend state, and cross-provider flows should prefer `conv-*`
- runtime process plumbing may still use provider/session/streaming IDs internally

If you only have a legacy ID, resolve it first with `GET /api/conv/resolve/:id`.

## Source Of Truth

Do not hand-maintain volatile facts in docs when code already owns them.

- Route registration: `src/server/register-app-routes.ts`
- Session DB schema: `src/services/sessions/session-info-migrations.ts`
- Anthropic defaults: `src/services/insights/anthropic-service.ts`
- Gemini consultation model and session-image implementation: `src/services/gemini-service.ts`
- MessageList block budgets: `src/web/chat/components/MessageList/message-list-constants.ts`
- Runtime HTTP contract: `src/server/register-app-routes.ts`

## Key Areas

- **Routes**: `src/server/register-app-routes.ts` (registration), `src/routes/` (handlers)
- **Sessions**: `src/services/sessions/` (MessageStore, ConversationService, SessionInfoService)
- **Insights**: `src/services/insights/` (InsightsEngine — owns computation, caching, and event-driven generation; AnthropicService — API calls)
- **Frontend**: `src/web/chat/components/ConversationView/ConversationView.tsx` (main view), `useSessionStatus` hook (status polling)
- **Harness**: `src/harness/` (SessionManager, DaemonProcessAdapter, event storage)
- **Tests**: `test/behavioral/` — Playwright browser tests. Run with `pnpm test`

## Key Invariants

### Session status: push first, poll as fallback

- `GET /api/conv/activity-stream` (SSE via ActivityStreamContext) pushes session
  lifecycle, activity, permission, and pending-question events in real time
- `GET /api/sessions/status` + `useSessionStatus` remain the source of truth for
  status *values*; their polls stretch to slow safety nets while the stream is
  connected and tighten when it is not
- Don't rebuild status from local heuristics

### All sessions go through the harness

One pipeline: `SessionManager` → `DaemonProcessAdapter` → `ProcessDaemon` → CLI.
Events flow through `EventLog` → per-session SSE + `SqliteEventStorage`.
There is no secondary streaming path.

### Session launch API

- `POST /api/conv/create` — new conversation
- `POST /api/conv/:conversationId/resume` — continue existing

## Logging And Diagnostics

Primary logs live in:

- `~/.lattice-app/logs/server.log`
- `~/.lattice-app/logs/daemon.log`

Preferred agent-facing diagnostics:

```bash
pnpm -s diag:agent > /tmp/lattice-diag.json
pnpm -s diag:agent:session -- <session-id-or-prefix> > /tmp/lattice-session-diag.json
```

Keep the wrapper commands. Prefer them over maintaining long curl/grep runbooks in this file.

### Debug routes

`src/routes/debug/` has existing diagnostic endpoints for session state, conversation integrity, provider switches, message linkage, and stream buffer health. Check what exists there before proposing new observability or debug infrastructure.

Key endpoints (registered under `/api/debug`):

- `sessions/:id/diagnostic` — cross-system state (statusManager, database, daemon, stream buffers, timeline)
- `conversations/:id/switch-history` — provider switch forensics
- `conversations/:id/message-linkage` — message persistence forensics
- `state-reconciliation` — cross-references active state across all systems
- `active-sessions` — quick overview of all active sessions
- `timeline/:conversationId` — SessionTimeline milestones for a conversation (mounted at `/api/timeline`)
- `sessions/:id/harness-snapshot` — raw event log tail + `deriveStatus`/`deriveProcessAlive`/`deriveBackgroundTasks` run server-side. Answers "what would the client derive if it had the full event log?" in one curl. Pairs with `window.__latticeDebug` (client-side, exposed by `useHarnessSession`) for cold-load/hydration visual bug investigations.


## Testing

```bash
pnpm test              # Behavioral tests (Playwright)
pnpm test:behavioral   # Same thing, explicit
pnpm typecheck         # Always use this, not bare tsc --noEmit (silent on success)
pnpm lint
```

### Real recordings over synthetic fixtures

For tests that depend on event streams, protocol data, or multi-step runtime behavior, prefer recording real sessions as fixtures over hand-constructed synthetic event sequences. Real recordings capture timing, ordering, and interleaving that synthetic fixtures miss. Fall back to synthetic only for states that can't be triggered naturally (error injection, edge timing).

## Development Patterns

### Route handlers

Wrap async route logic with explicit error forwarding. Do not leave floating promises in Express handlers.

### Skill prompt changes

If behavior depends on cached reflection/review outputs, restart the server and clear the relevant cache before trusting results.

### Native tools vs rendered tools

Lattice renders native Claude tools but does not inject them. Do not confuse tool rendering code with tool provisioning.

## Design Principles

### Visual language

New UI keeps drifting toward amber-and-monospace because several files used to
say so. They no longer do. The three rules that matter:

- **Cyan `#22d3ee` is the interactive accent** — buttons, focus, links, live
  state. Amber means caution, attention, or transient (queued work, token
  pressure, a fading highlight) and is applied per-use. Emerald is success, rose
  is destructive, violet marks a named product concept.
- **Body copy is Geist.** `font-mono` (Geist Mono) is the *data* role: code,
  paths, IDs, counters, log lines. The dense technical texture comes from
  `uppercase tracking-wider` at 9–11px, not from a monospace face.
- **`font-display` (Orbitron) is scoped** to the app header, composer, and
  session surfaces. Elsewhere, keep the uppercase and tracking, drop the face.

Full role table and component references: `docs/visual-language-audit.md`.

### Problem-first design

Look for concrete pain before designing a feature. Do not invent feature work because a space in the UI or architecture feels empty.

### Memory architecture

- `CLAUDE.md` should hold stable prescriptive guidance
- recommendations should hold contextual learnings
- do not create parallel memory systems unless the existing split truly fails

### Prefer orientation pointers over duplicated reference dumps

If a fact changes often, point to the code that owns it instead of copying it here.

### Local features

- Lattice is self-hosted and uses the user's own provider credentials; no feature is gated
- always render persisted local data such as session art, insights, reviews, and turn history
- model-backed local features depend on configured provider credentials and should fail explicitly when those credentials are absent

## Keep This File Tight

When adding to this file, ask:

1. Is this stable?
2. Is it hard to infer from code?
3. Would a new agent actually need it before opening files?

If the answer is no, put it in a local README, a focused doc, or the code itself instead.
