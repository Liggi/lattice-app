# Runtime Diagnostics & Authority Collapse — Progress

Execution log for the plan in `runtime-diagnostics-and-authority-collapse.md`. Spec stays the design source of truth; this file tracks what's shipped, what's in flight, and what's next.

## Current state

**In flight:** Move 3, Slice 3.1 — failing test landed (`62-diagnostics-multi-source.spec.ts`), awaiting go-ahead to implement the five missing source collectors.

**Next consequential action:** wire `harness_manager`, `daemon`, `active_registry`, `database`, `public_status` into `collectConversationDiagnostics` so the Slice 3.1 test passes. Each is a `DiagnosticSourceSnapshot` with a `RuntimeFacts` payload pulled from its existing authority (no new state, just a read-projection per source).

## Branch strategy

| Phase | Branching |
|---|---|
| Move 1, Move 2, Tactical 6.1, Tactical 6.2, Move 3 | Direct commits to `main` (per Lattice convention) |
| Moves 4–6 | Branch per Move |
| Move 7+ | Revisit when earlier work settles |

## Working rules (carried from session)

- Failing test first → **stop** → wait for go-ahead → implement.
- Ratchet: no new authority lands without demoting an old one in the same PR.
- Every Move adds the invariant check that would have caught its class of bug.
- `pnpm deploy` (not `pnpm build`) for backend changes — server runs from `dist/` and won't pick up code without a restart.
- `pnpm test` = Playwright behavioral suite. `pnpm typecheck` before commit.
- Commit + push directly to `main`, but only with explicit per-session permission.

## Shipped

| Slice | Commit | Net change |
|---|---|---|
| **Move 1** — `/api/diagnostics/conversations/:id` foundation | `9313ae73` | + diagnostics route + collector + invariant scaffold (~800 LOC service, 80 LOC route). Anchor source: `harness_events`. Other sources: not yet wired. |
| **Tactical 6.1** — `findLatestRunReady` | `0b31ce81` (lattice) + harness `0.1.4` | Adds `EventStorageAdapter.findLatestRunReady(sessionId)` + `(session_id, type, seq DESC)` index. Recovery path no longer depends on the 50-event tail window for resume identity. |
| **Tactical 6.2** — `RunEndReason` + `SessionEventMeta` | `befd3619` (lattice) + harness `0.1.5` | Named union `completed \| stopped \| interrupted \| error \| process_exit \| idle_timeout \| server_restart` (drops `'crashed'`). `SessionEventMeta` carries `inferred?` + `source?: 'provider' \| 'daemon' \| 'harness' \| 'recovery' \| 'test'`. Recovery-injected events now marked `inferred: true, source: 'recovery'`. |
| **Move 2** — delete half-supported Codex | `45b7926f` | 18 files, +98 / −1354. Public API rejects non-Claude with 400 (`unsupported_provider`). Schema preserved; 327 historical codex segments hidden from list, reachable by URL. Removed: daemon Codex management, IPC client wrappers, `/auth/stream/*` infra, codex-only routes, Settings UI, DevHub entries, `defaultProvider` config. Behavioral coverage: tests 26, 28, 34, 35, 60, 61. |

## In flight — Move 3

> Replace the current debug-surface sprawl with one diagnostics system and one invariant engine.

### Pre-implementation decisions (settled this session)

| Question | Decision |
|---|---|
| Mutating `/api/debug/*` routes (`repair`, `messages/archive`, `timeline/milestone` POST) | **Out of scope.** Mixing route relocation into a read-truth consolidation dilutes the ratchet. Note in plan, leave alone. |
| DevTools tab routes (`events`, `audit-trail`, `costs`) | **Fold `events` into the diagnostics report's existing `events` section.** Leave `audit-trail` and `costs` as-is — orthogonal data, not runtime truth. |
| Wrapper period | **Same PR.** Wrappers exist but their innards already point at the new collector. No parallel-truth window. |

### Slices

| Slice | Status | Description |
|---|---|---|
| **3.1** Multi-source snapshots | ⏳ failing test landed (`62-diagnostics-multi-source.spec.ts`) | Wire `harness_manager`, `daemon`, `active_registry`, `database`, `public_status` as `DiagnosticSourceSnapshot`s in `collectConversationDiagnostics`. |
| **3.2** Multi-source invariants | not started | Implement `runtime_authority_consensus`, `daemon_manager_process_consistency`, `single_live_run`, `resume_id_consistency` against the now-populated sources. |
| **3.3** Aggregate endpoint | not started | `GET /api/diagnostics/runtime-reconciliation` with `activeOnly`, `recentMinutes`, `limit`, `includeRawSources` — same collectors, scoped scan. |
| **3.4** Subsume legacy debug routes | not started | Convert `/api/debug/sessions/:id/diagnostic`, `state-reconciliation`, `active-sessions`, `sessions/:id/harness-snapshot`, `timeline/:conversationId`, `switch-history`, `message-linkage` to thin wrappers delegating to the new collector. **Delete old collectors in same PR.** Wrappers carry `Deprecation: true` + `X-Lattice-Diagnostics-Canonical` headers. |
| **3.5** CLI repoint | not started | `diag:agent` → `/api/diagnostics/runtime-reconciliation`; `diag:agent:session` → `/api/diagnostics/conversations/:id`. Human output preserved. |
| **3.6** SQLite instrumentation | not started | Slow-op visibility for `harness_events.write`, `harness_events.read_window`, `harness_events.find_latest_run_ready`, `conversation.status.bulk`, `diagnostics.collect_sources`. |

### Audit — debug surface to demolish

| Endpoint | LOC | Disposition | Caller(s) |
|---|---|---|---|
| `GET /api/debug/sessions/:id/diagnostic` | ~250 | wrapper, delete collector | `session-api.ts:353`, `FeedbackPanel` |
| `GET /api/debug/state-reconciliation` | ~120 | wrapper, delete | (curl/script only) |
| `GET /api/debug/active-sessions` | ~50 | wrapper | `session-api.ts:397` |
| `GET /api/debug/sessions/:id/harness-snapshot` | 281 | wrapper | `useHarnessSession` (comment), curl |
| `GET /api/timeline/:conversationId` | 116 (4 routes) | delegating route, expose as `timeline` section | `timeline-reporter` POSTs `/milestone` |
| `GET /api/debug/conversations/:id/switch-history` | ~220 | optional `switchHistory` section | (none in tree) |
| `GET /api/debug/conversations/:id/message-linkage` | ~180 | optional `messageLinkage` section | (none in tree) |
| `GET /api/debug/sessions/:id/events` | — | fold into diagnostics `events` section | `EventsTab`, FeedbackPanel |
| `GET /api/debug/sessions/:id/audit-trail` | — | leave as-is (orthogonal) | `AuditTab` |
| `GET /api/debug/sessions/:id/costs` | — | leave as-is (orthogonal) | `CostsTab` |
| `POST /api/debug/conversations/:id/repair` | — | **out of scope** (mutating) | — |
| `GET /api/debug/conversation-integrity` | — | fold into aggregate diagnostics | (none in tree) |
| `GET /api/debug/conversations/:id/runtime` | — | fold into per-conv diagnostics | — |
| `GET /api/debug/registry` | — | fold into aggregate summary | — |
| `GET /api/debug/messages/storage` + `POST /messages/archive` | — | **out of scope** (mutating) | — |
| `POST /api/timeline/milestone` | — | **out of scope** (mutating) | `timeline-reporter` |

Total surface inside `/api/debug/*` + `/api/timeline/*`: **~2,110 LOC across 8 route files.**

## Pending

| Move | Status | Notes |
|---|---|---|
| **Move 4** — public status harness-derived | not started | New doctrine: "Runtime status comes from harness-derived `RuntimeFacts`. Polling is only a transport/cache mechanism for those facts." Replaces existing CLAUDE.md invariant. Branch per Move. |
| **Move 5** | not started | Branch per Move. |
| **Move 6** | not started | Branch per Move. |
| **Move 7+** | deferred | Revisit when 1–6 settle. |

## Open threads / things to watch

- **`session-api.ts` callers** rely on the legacy debug shapes. Slice 3.4 wrappers must return back-compat projections, not the new shape, until those callers are migrated.
- **`useHarnessSession` debug comment** points at `harness-snapshot`. Update when wrapper lands.
- **`FeedbackPanel`** embeds curl URLs for the legacy debug endpoints into copyable bug-report text. Update curl strings to canonical diagnostics URLs in Slice 3.4.
- **CLAUDE.md "Session status comes from polling" invariant** is the doctrine Move 4 overturns. Don't reinforce it in any docs added during Move 3.
