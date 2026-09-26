# Lattice, harness, and toolkit review — 5 September 2026

The foundations are sound. The most valuable cleanup is to finish the boundaries between provider execution, durable session state, and transcript rendering. A wholesale rewrite or a large dead-code purge is not supported by this review.

This is a review of the current working trees, which contain existing uncommitted changes. No runtime source was changed for the review. The new MCP renderers and small Composer changes in the toolkit are work in progress, not a published release being graded. Recommendations here are proposals, not accepted architecture decisions.

**Scope and evidence.** Traced launch → provider adapter → harness normalization → event storage → browser/server message projections, stop/recovery, provider capabilities, shared component interfaces, and package resolution. Read current local provider interfaces and official documentation. Ran package tests and focused Lattice tests; used isolated synthetic probes that import the real implementation for uncommon lifecycle and protocol edge cases. Did not restart services, launch model turns, perform browser acceptance testing, or measure production failure prevalence.

| Component | Observed state |
| --- | --- |
| Lattice | HEAD `cbcf0b5c`, version 2.1.2; existing local work includes the learning map and model changes |
| Harness | HEAD `7980240`, version 0.2.3; existing edits to status derivation |
| Toolkit | HEAD `ecd63ba`, version 0.3.1; existing MCP and Composer work |
| Codex CLI | Installed binary reports 0.153.3; generated its TypeScript protocol locally |
| Claude CLI | Installed global binary reports 2.1.251 |
| Claude SDK | Lattice installation contains `@anthropic-ai/claude-agent-sdk` 0.3.251 |
| Other Claude dependency | Lattice's separate `@anthropic-ai/claude-code` dependency resolves to 2.1.63; that is distinct from the global binary and SDK |
| Running service configuration | launchd starts Lattice with Node 24.14.0 and `LATTICE_CLAUDE_SDK=1`; the status endpoint also contains SDK and Codex runtime identities |

**What deserves to stay.**

- The three-package split earns its place. The harness provides protocol, server, and client entry points; the toolkit provides reusable presentation; Lattice owns product behavior. Shared consumers make these meaningful boundaries. A monorepo might ease coordinated development, but it would not solve the semantic issues below.
- The append-only event log, sequence-based replay, reset handling, bounded client cache, and cassette/testing support form a useful core. Do not replace SQLite or SSE merely for architectural fashion.
- `ActiveConversationRegistry` now explicitly owns live identity and process metadata, not a competing status state machine. Status derives from harness events. That is a material improvement already present in source.
- Toolkit theme context, custom renderers, and callbacks for host actions are appropriate inversions of control. The local-first product should continue owning its layout and actions.
- Current build scripts serialize builds and stage output before swapping it. The harness test gate now checks the test command's exit status. Old notes that describe these as missing are stale.
- The configured Knip scan found **zero unused files**, with 18 unused exports and 10 unused types. This is limited to its configured entry points and exclusions, but it does not support a claim that the repository is mostly abandoned code. The April architecture audit is historical evidence, not a current deletion list.

**1. The shared runtime contract still makes every provider impersonate Claude. Highest architectural priority.**

`ProcessHandle` exposes string stdout, `write(): void`, optional compaction, signals, and process exit. `SessionManager.pipeEvents()` runs every provider's output through `normalizeClaude()`.

Codex therefore takes typed app-server items, synthesizes Claude `system/init`, `assistant`, `user/tool_result`, and `result` objects, serializes them, and lets the harness parse and normalize them again. OpenCode has the same basic constraint. Even the SDK serializes objects into the simulated stdout stream.

This has consequences beyond redundant JSON processing:

- Native thread/turn/item identity and message phase have no proper place in the shared contract.
- Codex failed turns are represented using a fabricated Claude `error_max_turns` result subtype.
- Some Codex lifecycle information bypasses the normal ingestion path through `appendCustomHarnessEvent()`, which casts arbitrary strings to the closed `EventType` union.
- `SessionEvent.data` is `unknown`, so event type and payload are not checked together. Adapter changes frequently require downstream casts and reinspection of strings.
- `write(): void` cannot report asynchronous provider acceptance. The harness can append `input:sent` while an adapter is still making an RPC that may fail. The adapters log failures, but callers do not receive a delivery receipt. This is a source-level contract concern; no live lost-input incident was established here.

The right seam is a provider adapter that yields typed normalized events and exposes semantic operations such as send, steer, interrupt-turn, terminate-session, update-model, and compact, with explicit capability support. Keep Claude-specific normalization inside the Claude adapter. Retain provider identities and structured results alongside normalized display fields. Generate Codex wire types from the pinned CLI; keep the application event contract small and separately versioned.

Do this incrementally, with one adapter conversion and contract tests first. It does not require changing storage technology or rebuilding the UI.

Evidence: `../src/harness/codex-process-adapter.ts:692`, `../src/harness/harness-custom-events.ts`, `../src/services/process/codex-app-server-types.ts`; sibling harness `src/server/process-adapter.ts`, `src/server/session-manager.ts:653`, `src/protocol/events.ts`.

**2. Server and browser transcript assembly disagree. Confirmed with real functions.**

The browser uses the harness's run-scoped coalescer, merging fragments by message identity within a run and resetting at a new run. The server's `eventsToUnifiedMessages()` instead merges only with the immediately preceding message and does not reset at a run boundary.

Isolated probes fed identical event sequences into the actual server and browser converters. Interleaved A/B/A fragments within one run produced **three server messages but two browser messages**. Two runs reusing a message ID produced **one merged server message but two browser messages**. A further probe switched from a Codex run to a Claude run: **the server labeled the Claude reply as Codex**. Its provider detector recognizes Codex and otherwise retains the previous provider. OpenCode is also absent from that detector.

This matters because the server reader feeds summaries, reviews, and activity projections. Fixing only the visible transcript can leave those consumers with a different account of the conversation. The probes prove conversion behavior, not how frequently existing user histories trigger it.

Reuse the canonical coalescing rule on both paths and make provider attribution explicit at run boundaries. Prefer one normalized message projection followed by small server/browser presentation mappings. Preserve parent-agent identity rather than repeatedly rediscovering it from message shape.

Evidence: `../src/harness/event-message-reader.ts:95`, `:110`, `:145`; `../src/web/chat/hooks/useHarnessSession.ts:732`; sibling harness `src/protocol/coalesce.ts`.

**3. Recovery and Stop need explicit lifecycle contracts. Confirmed library defects; product effects qualified.**

Recovery queries the latest `run:ready` directly, but searches only the last 50 events for `run:start.config`. The comment saying this configuration must be near the end of a run is false for a long turn.

A probe seeded a 63-event completed run. Recovery retained the provider resume ID, but `send()` rejected with **`Session config not available`**. Lattice catches that string and reconstructs a launch in its HTTP route. Thus the application has a compensating second recovery implementation; this is not evidence that every UI resume fails. That reconstruction does not carry every original launch field, such as system-prompt additions, explicit transport choice, and permission configuration.

Store a durable launch descriptor independently of a bounded transcript tail, or query its latest event by type as is already done for `run:ready`. Keep credentials out of a durable descriptor; persist references to runtime configuration where appropriate. Use typed recovery results instead of branching on error-message strings.

Stop has another distinct defect. It emits an interrupt, then escalates if no `turn:end` arrives after the stop request. An already-idle process has no turn to end. A probe with the actual manager and a fake keep-alive process confirmed **SIGINT followed by SIGTERM**. SDK interrupt acknowledgments and Codex turn interruption are currently hidden behind the signal-shaped interface.

Separate cancellation of an active turn from termination of the session runtime. Make stopping background work an explicit operation. Tie completion/exit callbacks to the run they own before mutating the current process handle; the current exit handler unconditionally clears `session.process`, which is an additional race concern requiring a dedicated late-exit test before calling it a demonstrated regression.

Evidence: sibling harness `src/server/session-manager.ts:243`, `:450`, `:913`; `../src/harness/routes.ts:224`; `../src/harness/sdk-process-adapter.ts:259`; `../src/harness/codex-process-adapter.ts:515`.

**4. Process ownership provides different restart guarantees. A product decision precedes a larger refactor.**

Claude through the daemon, Claude through the SDK adapter, and Codex through the app-server client have different owners. The installed service selects the SDK adapter for Claude. Its query handles and the Codex app-server client live under the web-server process. The daemon path has a separate process owner, but explicitly does not buffer events while the server is disconnected. In the auto-spawned daemon mode, server shutdown also stops the daemon child.

Keeping a child process alive is not sufficient for uninterrupted work if Lattice cannot reattach and recover the output it missed. The current recovery design declares an interrupted run ended and resumes later.

If the intended promise is that active work survives web deployments, place provider execution behind one supervised runtime boundary and provide durable event replay plus reattachment. The existing daemon can be the starting point; moving everything into the web process would weaken that promise. If resuming after interruption is acceptable, document that guarantee and simplify around it. Do not fund a daemon rewrite without making this expectation explicit.

No destructive restart test was performed against live sessions. This finding comes from source, service configuration, and the read-only status endpoint.

Evidence: `../src/harness/setup.ts`, `../src/harness/multiplexing-process-adapter.ts`, `../src/harness/sdk-process-adapter.ts`, `../src/services/process/codex-app-server-client.ts:223`, `../src/process-daemon/process-daemon.ts:1`, `../src/process-daemon/ensure-daemon.ts:125`, `../src/lattice-server.ts:636`.

**5. Package and build identity should be reproducible. High practical priority.**

The Lattice manifest requests harness `^0.2.2`, but its installed dependency resolves directly to the sibling checkout at version 0.2.3. Toolkit uses a `file:../agent-ui-toolkit` development dependency resolved through pnpm's installed package directory. TypeScript and runtime imports use package `dist` files. Lattice's lockfile is still gitignored.

Consequently, source under review, compiled package contents, installed dependencies, and running server modules can represent different revisions. This is observable installation structure; the review did not assert that a particular running bundle contains a particular uncommitted edit.

Commit an application lockfile, make local-development versus registry consumption explicit, and record the exact resolved package revisions used by a build. Verify the built package artifacts in the consumer contract tests. Refresh model/CLI compatibility deliberately. The existing publishability and harness clean-tree checks are useful; extend that discipline to the toolkit and application build inputs. Separate repositories can remain.

Documentation needs the same cleanup. Current notes still describe PTYs where the daemon now launches pipes, an older dependency mode, and architecture/deletion candidates that have since changed. Keep an up-to-date runtime map and mark old audits as historical.

Evidence: `../package.json`, `../.gitignore:4`, `../tsconfig.json`, `../scripts/check-publishable-deps.js`, `../scripts/safe-build.sh`; installed package realpaths; sibling harness `scripts/check-clean-tree.sh`.

**6. The toolkit is mostly reasonable; simplify its input contract and Composer. Medium priority.**

The current Composer is about 1,300 lines and manages drafts, attachment input, autocomplete, keyboard behavior, model selection, status, elapsed time, menus, and a queue dialog. These are legitimate features, but independent state transitions now share one component. Extract draft/autocomplete behavior and model/status/attachment presentation at their existing seams. Keep the public host callbacks and slots stable. Do not create a universal form or plugin framework to accomplish this.

Tool rendering contains a more consequential boundary problem: `ToolResult` and `CustomToolRenderer` largely funnel results into strings. Codex's adapter extracts text from MCP blocks, while toolkit renderers parse JSON envelopes to recover structured payloads, arguments, and errors. The new MCP unwrapping code is useful for historical formats, but some of its work compensates for information the upstream adapter already had.

Pass structured results, text, media/resource blocks, error state, and tool identity through one checked render input. Keep legacy decoding at the boundary where historical data enters. Reuse the same tool metadata for pending and completed views so labels and routing cannot drift. Some result parsing will remain necessary because external tools really do return strings; the goal is to avoid flattening and then reconstructing the same data inside Lattice.

Evidence: sibling toolkit `src/components/Composer/Composer.tsx`, `src/components/ToolContent.tsx`, `src/types.ts`, and current WIP `src/components/tools/mcp/unwrapResult.ts`; `../src/harness/codex-process-adapter.ts:214`.

**Provider capabilities that could add value, in suggested order.**

| Opportunity | Current wiring and value | Evidence and qualification |
| --- | --- | --- |
| Show Codex subagent, search, image, and plan activity | Native `collabAgentToolCall`, `webSearch`, `imageGeneration`, and plan updates produced no harness events in an injected-protocol probe. Render them and preserve parent/child identity. This would make delegated work and generated outputs visible. | Installed 0.153.3 generated `ThreadItem` and `ServerNotification` types; actual adapter probe. Full child transcripts additionally require child-thread subscription/history integration. |
| Steer an active Codex turn | `write()` currently parks input until `turn/completed`, then starts another turn. The probe confirmed that behavior. Offer explicit “send now” versus “queue” semantics using `turn/steer` and `expectedTurnId`. | Installed generated client request types and [official app-server turn documentation](https://learn.chatgpt.com/docs/app-server#turns). Preserve a deliberate queue option. |
| Discover models and reasoning effort; switch Claude models natively | Codex model/effort lists are hand-maintained. Claude capability metadata declares no effort control, and the manager respawns an idle process when the model changes. Codex exposes `model/list`; the installed Claude SDK exposes `supportedModels()`, `setModel()`, effort options and runtime settings updates. | Codex generated schema; installed Claude SDK `sdk.d.ts`; [model discovery documentation](https://learn.chatgpt.com/docs/app-server#models). Provider availability should be discovered; the user's preferred ordering/defaults remain a product choice. |
| Explain context pressure and connection failures | Claude SDK exposes `getContextUsage()`, `mcpServerStatus()`, reconnect controls, and targeted `stopTask()`. Codex status/MCP updates are persisted as custom events but have no named UI consumers in the inspected source. A compact inspector could answer what fills context, which tool connection failed, and what is still running. | Installed SDK types and repository call-site search. Some usage APIs are experimental; surface their availability honestly. |
| Consume authoritative lifecycle signals | Claude's installed SDK declares `session_state_changed` with idle/running/requires_action; the normalizer currently drops it as unknown. Codex thread status is stored without driving shared status. Preserve these states and reconcile them with local pending commands. | Installed SDK type and source normalizer. Do not blindly replace all state with one provider status: local queue state, transport loss, and turn acknowledgments still matter. |
| Use native session forks | Claude SDK exposes `forkSession()` with `upToMessageId`; Codex exposes `thread/fork`. Lattice currently edits Claude transcript JSONL itself and declares Codex branching unsupported. Let providers own their history format, while Lattice rekeys its event history and conversation metadata. | Installed SDK and generated Codex types; `session-branch-service.ts`. A native fork does not automatically create the Lattice-side branch or restore files. |
| Add previewable file rewind for Claude | SDK checkpointing and `rewindFiles(..., {dryRun:true})` could support an explicit preview/restore action. | [Official checkpoint documentation](https://code.claude.com/docs/en/agent-sdk/file-checkpointing). It covers supported file-edit tools, not arbitrary Bash changes or most subagent edits. It does not rewind conversation context. |
| A focused code-review action | Codex `review/start` supports working-tree, branch, and commit targets, including a separate review thread. Useful for reviewing the current diff from Lattice. | [Official review documentation](https://learn.chatgpt.com/docs/app-server#review). This has a different job from Lattice's existing conversation/session reviews. |
| Typed approval and MCP forms | Codex ordinary user-input requests already have an implementation and passing tests. MCP elicitation is explicitly declined; the current policy fixes approvals to never and uses full access. Add forms or selectable permission modes only as an explicit product capability. | `codex-request-coordinator.ts`, `provider-capabilities.ts`, and app-server request schema. Do not describe ordinary questions as wholly missing or change permission defaults as incidental cleanup. The browser request/answer round trip was not tested here. |

Goals, native context compaction, attachments, Codex device-code sign-in, rate-limit reads, and ordinary Codex request/reply handling already have implementations. Completing their verification or presentation is different from inventing those integrations anew.

Do not prioritize replacing the Codex app-server with a thin execution SDK, adding another orchestration framework, or adopting remote WebSocket transport as a cleanup shortcut. The official documentation positions app-server for rich clients; its WebSocket transport is experimental. The current architecture can capture the useful features through its existing integration.

**Recommended sequence.**

1. Fix transcript projection disagreement, reliable recovery of launch configuration, and idle Stop semantics. Convert the isolated probes into regression tests with the intended behavior as their assertions.
2. Make package resolution/build identity repeatable and correct the runtime map.
3. Introduce typed provider events and acknowledged control operations, then add Codex activity rendering, steering, dynamic model catalogs, and native Claude model updates through that seam.
4. Decide the restart-survival guarantee before moving process ownership. Refactor Composer and structured result presentation without changing the established product flows.
5. Consider forks, checkpoint previews, context inspection, and focused code review individually, based on their user-facing value.

**Verification record.**

- Harness: 33 test files passed; 605 tests passed; one real-CLI smoke test skipped.
- Toolkit: 10 test files passed; 126 tests passed. This command also triggered pnpm's automatic dependency synchronization for the existing working-tree manifest.
- Lattice: 12 selected unit/integration test files passed; 74 tests passed, covering Codex RPC/adapter/requests, provider capabilities, startup recovery, hydration/history, resume-transcript checks, compaction, attachments, and status caching. This was not the full browser suite.
- Isolated actual-code probes confirmed the 50-event recovery gap, idle Stop escalation, server/browser coalescing disagreement, provider attribution error, discarded Codex activity types, and queued rather than steered Codex input. These use synthetic data and make no claim about production prevalence.
- Knip completed with findings, not a clean exit. Its stdout prepended a dotenv banner before the JSON; after recognizing that format, the JSON reported zero unused files. No scan failure was treated as a clean result.
- Read the installed launchd configuration and read-only session-status endpoint. No live process interruption or browser acceptance test was performed. A Homebrew Python XML extension error prevented plist inspection with Python; macOS's native plist reader established the configuration instead.
- Generated the installed Codex protocol types locally. The large Claude SDK reference page could not be fetched through the available web reader; exact method availability was checked in the installed SDK declarations, and the official checkpoint page was read successfully.

Temporary probes and logs are in `/tmp/lattice-architecture-audit-2026-09-05/`, with package test logs in `/tmp/lattice-audit-harness-tests.log` and `/tmp/lattice-audit-toolkit-tests.log`. Their concrete inputs and observed outcomes are described above so the findings remain understandable after temporary files expire.
