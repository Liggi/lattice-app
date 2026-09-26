# Module Architecture — Deep Module Refactoring Plan

**Date**: 2026-04-09 (revised after Tier 1+2 deletion)
**Principle**: Each module owns its full stack — logic AND storage. (Ousterhout: "a module should hide a design decision.")
**Companion doc**: `architecture-audit.md` covers what to delete/test. This doc covers how to restructure what survives.

---

## The Diagnosis: Storage Parasitism

The god object pattern appears at every layer:

| Layer | God object | Size | Methods |
|-------|-----------|------|---------|
| Backend service | SessionInfoService | 2,968 lines | 85+ public methods, 33 consumers |
| Frontend API client | ApiService (6-level inheritance chain) | ~1,782 lines across 8 files | ~87 methods |
| Frontend state | ConversationsContext | 1,216 lines | ~15 exported, internally complex |

But the problem isn't that SessionInfoService is big. It's that **other modules dump their storage responsibilities into it**.

InsightsComputer computes insights but stores them through SessionInfoService. SessionReviewService computes reviews but stores recommendations through SessionInfoService. TurnCaptureService detects turns but persists them through SessionInfoService's turnRepository getter.

Each service is shallow not because its logic is simple, but because it outsources half its design decision (persistence) to another module. SessionInfoService becomes a grab-bag of everyone else's tables, and no module can be understood in isolation.

**The fix isn't "split SessionInfoService into N new stores." It's: make existing modules deeper by giving them the storage they were outsourcing.** The harness already does this — it owns SqliteEventStorage internally, nobody else touches those tables, and that's why it's the exemplar.

---

## What's Already Deep (Leave Alone)

1. **The harness** — 6 files, ~1,010 lines, 6 endpoints. Owns its own event storage.
2. **Infrastructure layer** — DatabaseProvider, Logger, ConfigService are properly isolated.
3. **Harness routes** (210 lines) — pure dispatch, all logic in SessionManager.

---

## The Consumer Map

Every external call to SessionInfoService's methods traced. They cluster into 6 concerns, each with a clear destination.

### Cluster 1: Insights Cache → InsightsEngine

8 methods. This is the biggest cluster and the clearest migration target.

| Method | Consumers |
|--------|-----------|
| `getInsights` | insights-computer (3 calls), insights.routes, session-review-service |
| `setInsights` | insights-computer, insights-trigger, session-transfer.routes |
| `getInsightsBatch` | insights-computer |
| `getMissingInsightsSessionIds` | insights-computer |
| `getAllInsights` | claude-history-reader, insights.routes |
| `updateToolMetrics` | claude-history-reader |
| `markInsightsStale` | **dead — zero callers** |
| `getStaleSessionIds` | **dead — zero callers** |

**Key insight**: InsightsComputer is already the dominant consumer (7 of 10 external calls). It's using SIS as a cache backend for its own data. Making it own that cache is a natural move.

### Cluster 2: Recommendations → SessionReviewService

6 methods. Almost exclusively consumed by insights.routes (the HTTP layer) and session-review-service (the computation layer).

| Method | Consumers |
|--------|-----------|
| `acceptRecommendation` | insights.routes |
| `dismissRecommendation` | insights.routes |
| `completeRecommendation` | insights.routes |
| `getPendingRecommendations` | insights.routes |
| `getAllRecommendations` | session-review-service |
| `getRecommendationsForSession` | insights.routes, session-review-service |

SessionReviewService already computes recommendations. It should own their lifecycle too.

### Cluster 3: Dev Notes → Own Module

6 methods. Consumed exclusively by notes.routes (backend) and frontend components via API client.

| Method | Consumers |
|--------|-----------|
| `createDevNote` | notes.routes |
| `getPendingDevNotes` | notes.routes |
| `updateDevNoteStatus` | notes.routes (via `updateDevNote` internally) |
| `updateDevNote` | notes.routes |
| `deleteDevNote` | notes.routes |
| `markAllDevNotesAsDone` | notes.routes |

Clean vertical: one route file, one set of SIS methods, one frontend dialog. The methods are pure CRUD — a thin module, but it's a genuine self-contained concern.

### Cluster 4: Runtime State → Harness/Registry

6 methods. In-memory state (Maps), not even persisted to SQLite.

| Method | Consumers |
|--------|-----------|
| `setMcpServers` | (set during session events, read by query-routes) |
| `getMcpServers` | unified-conversation.query-routes |
| `getConfiguredMcpServersFallback` | unified-conversation.query-routes |
| `setProposedNextSteps` | internal + passed to React as state setter |
| `getProposedNextSteps` | **dead — zero callers** |
| `clearProposedNextSteps` | **dead — zero callers** |

This is session runtime state that belongs on the runtime objects (ActiveConversationRegistry or similar), not on the data service.

### Cluster 5: Repository Getters → Direct Ownership

SessionInfoService exposes `turnRepository` and `auditRepository` as property getters. External code reaches through SIS to use them.

| Getter | Consumers |
|--------|-----------|
| `.turnRepository` | turn-capture-service (save + query), session-transfer.routes (export/import), unified-conversation.control-routes |
| `.auditRepository` | insights-computer (audit events), insights.routes (audit queries), debug-session.routes |

These repositories should be imported directly by their consumers, not accessed through SIS.

### Cluster 6: Dead Methods → Delete

8 methods with zero external callers:

- `markInsightsStale` — never called
- `getStaleSessionIds` — never called
- `getProposedNextSteps` — never called
- `clearProposedNextSteps` — never called
- `getSegmentForRecovery` — never called
- `getDatabaseHandle` — never called (and leaks raw DB connection)
- `updateSessionUsage` — never called
- `updateSessionMetadata` — never called

Delete these first. Free reduction.

---

## The Concrete Moves

### Move 1: Delete Dead Methods ✅ DONE

Deleted 8 dead methods from SessionInfoService + 1 dead method from InsightsEngine:
- SIS: `markInsightsStale`, `getStaleSessionIds`, `updateSessionMetadata`, `getProposedNextSteps`, `clearProposedNextSteps`, `getDatabaseHandle`, `updateSessionUsage`, `parseProposedNextStepsJson`
- InsightsEngine: `computeMissingInsights` (zero external callers)
- Also made 4 methods private: `extractTodoState`, `extractUserPrompts`, `extractRecentAssistantText`, `isAutomatedSession`

### Move 2: InsightsComputer → InsightsEngine ✅ DONE

InsightsComputer renamed to InsightsEngine. Absorbed all insights cache methods from SIS.

**What was done:**
- Renamed `InsightsComputer` → `InsightsEngine` (class + file: `insights-engine.ts`)
- Renamed `CachedInsights` → `InsightsRecord` (backward-compat re-export from SIS)
- Moved cache methods: `getInsightsRecord`, `setInsightsRecord`, `getAllInsightsRecords`, `getInsightsRecordBatch`, `getMissingInsightsSessionIds`, `updateToolMetrics`
- Extracted `resolveCanonicalSessionId` to shared utility: `resolve-canonical-id.ts`
- Cleaned dead types from `insight-types.ts` (5 dead trigger subtypes)
- InsightsEngine gets its own DB handle via DatabaseProvider
- All consumers updated (insights.routes, session-transfer.routes, unified-conversation routes, session-activity-watcher, claude-history-reader, session-review-service)
- Identity image methods stay on SIS (they're columns on the sessions table)

### Move 2b: Merge InsightsTrigger into InsightsEngine ✅ DONE

Eliminated the parallel JSONL compute pipeline. InsightsEngine now reads directly from harness events.

**What was done:**
- Added `readConversationFromEvents(sessionId)` — reads `harness_events` table directly
- Rewrote `computeInsights` to use events instead of JSONL/ClaudeHistoryReader
- Moved `onTurnEnd` + gating logic (cooldown, min messages, license check) into InsightsEngine
- Made InsightsEngine a singleton (`getInstance()`) — was previously 5 redundant instances
- Updated event-persistence callback to call `InsightsEngine.getInstance().onTurnEnd()`
- Removed `ClaudeHistoryReader` dependency from InsightsEngine
- Deleted `insights-trigger.ts` (185 lines)
- Deleted old message extraction methods: `extractTodoState`, `extractUserPrompts`, `extractRecentAssistantText`, `generateStructuredInsights`, `resolveHistorySessionId`, `shouldTreatAsSessionNotReady`

**What InsightsEngine hides now**: Which LLM to call, how to read conversation events, how to cache, how to detect staleness, how to batch-query, identity image generation, audit trail. Full stack behind a small public API.

### Move 3: SessionReviewService Absorbs Recommendations ✅ DONE

SessionReviewService now owns the full recommendation lifecycle — computation AND persistence.

**What was done:**
- Moved 6 methods: `acceptRecommendation`, `dismissRecommendation`, `completeRecommendation`, `getPendingRecommendations`, `getAllRecommendations`, `getRecommendationsForSession`
- Added `private db` from DatabaseProvider (replaced dynamic import that was already present)
- insights.routes calls `reviewService.*` instead of `sessionInfoService.*` for all recommendation ops
- Internal calls (`filterStoredRecommendations`, `buildExistingItemsContext`) now use `this.*` instead of `this.sessionInfoService.*`
- SIS lost 6 methods (~260 lines) + `StoredRecommendation` import

**What it hides**: How reviews are computed, how recommendations are stored and lifecycle-managed, which AI services are used, dedup logic.

### Move 4: Dev Notes Module ✅ DONE

Extracted dev notes CRUD into a standalone `DevNotesService`.

**What was done:**
- New `src/services/notes/dev-notes-service.ts` (~140 lines) — singleton, gets DB via DatabaseProvider
- Methods: `createDevNote`, `getPendingDevNotes`, `updateDevNote`, `deleteDevNote`, `markAllDevNotesAsDone`
- `notes.routes.ts` imports DevNotesService directly instead of SIS
- SIS lost 6 methods (~175 lines)

### Move 5: Repositories Become Independent ✅ DONE

TurnRepository and InsightAuditRepository promoted to independent singletons, plus aggressive dead code cleanup.

**What was done:**
- Both repos: added `static getInstance()` + `static resetInstance()`, get DB via DatabaseProvider
- turn-capture-service, session-transfer.routes, control-routes all import TurnRepository directly
- InsightsEngine, debug-session.routes import InsightAuditRepository directly
- SIS lost `turnRepository` and `auditRepository` getter properties
- Deleted TurnRepository.`copyForBranch` (zero callers)
- Deleted entire legacy audit system: `auditLegacy`, `getByTraceId`, `getRecentForSession`, `getLegacyForSession`, `getAllLegacyAudit`, legacy `insight_audit` table DDL, 5 legacy prepared statements, `LegacyAuditParams`/`LegacyAuditRecord` interfaces
- Deleted insights.routes `/stats` endpoint (consumed dead `getAllLegacyAudit`)
- Removed `auditHistory` from insights debug endpoint (read from dead table)
- InsightAuditRepository: ~500 lines → ~235 lines

### Move 6: Runtime State Leaves SIS ✅ DONE

Investigation revealed the "runtime state" was simpler than expected — the writers were dead code, not the readers.

**What was done:**
- Deleted `setMcpServers` (~25 lines, zero external callers)
- Deleted `setProposedNextSteps` (~15 lines, zero external callers)
- Removed ghost `getProposedNextSteps` call in query-routes — was using an optional-chain type cast to call a method deleted in Move 1, silently returning `undefined` every time
- Kept: `getMcpServers`, `getConfiguredMcpServersFallback` (active readers of session metadata), `copyTurnsForBranch` (called by session-branch-service and control-routes)

### Endgame

After moves 1-6, SessionInfoService is reduced to:
- Session CRUD: `getSessionInfo`, `getSessionInfoSync`, `updateSessionInfo`, `deleteSession`, `getAllSessionInfo`
- Session metadata: `updateCustomName`, `setIdentityImage`, `hasIdentityImage`
- Session queries: `getNonArchivedSessionIds`, `getArchivedSessionsWithInsights`, `getArchivedSessionCount`
- Bulk operations: `archiveAllSessions`
- Stats: `getStats`, `getDbPath`, `getConfigDir`

~15 methods, likely ~500 lines. At that point, consider merging with ConversationService (625 lines) — they're both answering "what sessions exist and what do they look like."

---

## Execution Strategy

**Test-then-refactor for each move.** Add a behavioral test for the affected feature surface, then migrate the storage.

| Move | Status | Notes |
|------|--------|-------|
| 1. Dead methods | ✅ Done | 8 SIS methods + 1 InsightsEngine method deleted |
| 2. Insights → InsightsEngine | ✅ Done | Cache methods migrated, CachedInsights → InsightsRecord |
| 2b. Merge InsightsTrigger | ✅ Done | Single compute pipeline via harness events, JSONL path eliminated |
| ID collapse (Phase 1) | ✅ Done | Dead switch route/service/methods deleted, resolveProviderSessionId collapsed |
| 3. Recommendations → SessionReview | ✅ Done | 6 methods moved, SIS lost ~260 lines |
| 4. Dev notes module | ✅ Done | DevNotesService standalone, SIS lost 6 methods |
| 5. Repositories independent | ✅ Done | Singletons + legacy audit system eliminated |
| 6. Runtime state | ✅ Done | Dead writers removed, ghost call cleaned |

---

## Discovered: ID Indirection Collapse ✅ DONE (Phase 1)

During Move 2, we discovered three ID schemes (CLI UUIDs, conv-* IDs, segments) from multi-provider. Phase 1 deleted dead infrastructure:

**What was done:**
- Deleted `SegmentTransitionService` (291 lines) — only consumer was the dead switch route
- Deleted provider switch route (`/:conversationId/switch`) — always returned 409 with single provider
- Deleted `switchConversationProvider` from frontend API — zero callers
- Deleted `switchSegment`, `findSegmentByProvider`, `updateSegmentProviderSessionId` from ConversationService
- Deleted `registerRecoveredSession`, `generateRecoveryStreamingId` from ActiveConversationRegistry — zero callers
- Removed `context_rollover` from type unions — never invoked
- Removed segments table query from `resolveCanonicalId` — was accidentally resolving placeholder IDs (`pending-*`, `seed-*`) through a roundtrip that masked the real bug
- Collapsed `resolveProviderSessionId` to identity function — with single provider, segment providerSessionIds are always placeholders, never meaningful
- Fixed `resolveResumeSessionId` (harness resolver) to skip placeholder IDs

**What remains (Phase 2, future):**
- Segments table still exists (data exists, harmless, resume flow reads from it)
- `conversation_segments` still created per-conversation (one segment each)
- Registry `byProviderSessionId` index still maintained (used by existing callers)
- `resolveCanonicalId` still queries `sessions.conversation_id` for legacy session UUIDs
- Full collapse would move `provider_session_id` to conversations table and stop creating segments entirely

---

## Discovered: Codebase Health Audits Needed

Two cross-cutting quality issues identified during the refactoring:

### Silent Error Swallowing
`catch {}`, `.catch(() => {})`, "best-effort" patterns that hide degradation. Multiple instances introduced during this refactor (claude-history-reader metrics backfill, session-review-service insights lookup) and many pre-existing. Principle: prefer loud failures with logging over silent fallbacks.

### Unsafe Casts at Parse Boundaries
`JSON.parse(row.context) as SomeType` — trusts the DB/external data shape without validation. Low risk for internal data (we control the writer), higher risk for session transfer imports. Options: typed parse helpers, try-catch at parse sites, or Zod for external boundaries.

---

## Later: Routes and Frontend (Phases 2-3)

### Phase 2: Route Thinning

Route layer is 9,782 lines — 3x the service layer. The harness routes (210 lines) are the model: pure dispatch, all logic in services.

Worst offenders:
- `unified-conversation.control-routes.ts` (979 lines) — message normalization, hook sync
- `unified-conversation.query-routes.ts` (746 lines) — insight backfilling, session enrichment
- `insights.routes.ts` (935 lines) — recommendation lifecycle, audit queries

After Phase 1, the deeper services create natural homes for this logic. Business logic migrates into services; routes become thin dispatchers.

### Phase 3: Frontend Follows

**API client**: Replace the 6-level inheritance chain (`ApiCore → ConversationApi → PermissionsApi → TeamsApi → ConfigApi → SessionApi → ApiService`) with focused clients that mirror backend boundaries. Each extends ApiCore for shared infrastructure but does NOT inherit from each other.

**ConversationsContext** (1,216 lines): Split concerns — session list, live status (SSE + polling), optimistic state. Partially extracted already via `useSessionStatus` hook.

Frontend refactoring falls out naturally once backend boundaries are clean.

---

## Design Principles (Ousterhout Reference)

These guided the analysis above:

1. **Trace information boundaries, not code structure.** The right modules emerge from "what information can be completely hidden?"
2. **Each module owns its storage.** If a module persists data, it owns those tables. Dumping storage into another module creates the god object.
3. **Decompose by question, not data type.** "What does this session mean?" (InsightsEngine) vs. "What sessions exist?" (SessionStore) — not InsightsCache vs. RecommendationStore.
4. **Thin wrappers are a smell.** If a module's interface is 2 methods with 1 consumer, fold it into the deep module it serves.
5. **Validate with the change test.** "If I change X's implementation, what else changes?" If the answer is "nothing outside the module," the boundary is right.
