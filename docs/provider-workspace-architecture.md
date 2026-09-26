# Provider, workspace, and activity architecture

**Status:** Adopted direction, with the capability audit current to 2026-08-08.

This note records the product and engineering decisions behind the provider
contract, workspace model, integrations, activity receipts, and the bounded
Effect experiment. It distinguishes current support from protocol features we
have not wired yet.

## Decisions

1. Integrations are global. Credentials and external accounts belong to the
   Lattice installation, not to a workspace.
2. A workspace is a logical context, not a filesystem boundary. A session has a
   starting directory and may work across any directories the user can access.
3. Provider implementations register behind one driver contract and publish
   their actual Lattice capabilities.
4. Every consequential turn should carry an activity receipt covering local
   files and external artifacts.
5. Dedicated worktrees are optional execution and rollback scopes. They must not
   restrict an agent to one repository.
6. Effect will be judged at a difficult asynchronous boundary before any wider
   adoption.

## Global integrations, workspace bindings

Lattice should install and authenticate GitHub, Linear, Slack, and similar
services once. A global connection record owns credentials, account identity,
granted scopes, refresh state, and audit history.

A workspace may reference a global connection and save useful defaults:

- a Linear team or project;
- a Slack workspace and channel;
- a GitHub organization or repository set;
- saved searches, filters, and display shortcuts.

Those are bindings, not separate installations. Multiple external accounts can
exist globally; a workspace may choose a default connection by ID without owning
its token. Sessions can override a default explicitly.

This avoids repeated OAuth, makes revocation honest, and lets a session cross
workspace and directory boundaries without silently changing identity.

## Workspace and filesystem semantics

`workingDirectory` means “where this session starts.” It is not the workspace's
root and is not an access-control boundary.

Lattice should maintain a session working set as the agent touches locations:

- directories and repositories read or changed;
- the starting directory;
- optional named roots pinned by the user;
- optional owned roots that Lattice is allowed to checkpoint and restore.

An opt-in worktree gives a session a clean home for one repository. The agent can
still cross into other directories. Rollback only applies to roots explicitly
owned by that checkpoint. Accessible but unowned locations stay outside the
rollback promise.

## Provider driver contract

The shared contract has two parts:

- a process adapter that starts, resumes, sends, interrupts, and streams;
- a capability declaration that the UI and routes can inspect.

The initial contract lives in `src/harness/provider-driver.ts` and
`src/types/provider-capabilities.ts`. The multiplexer chooses a registered
driver instead of embedding transport calls in the selection branch.

### Capability audit

| Capability | Claude | Codex | Remaining gap |
|---|---|---|---|
| Image attachments | Supported | Supported | None in the wired path |
| Text-file attachments | Supported | Supported | None in the wired path |
| PDF attachments | Supported | Unsupported | Codex has no document input in the current app-server shape; decide whether explicit local extraction is desirable |
| Interactive questions | Supported | Supported | Codex requests require a live JSON-RPC responder; orphaned rows now expire on server boot |
| Approvals | Interactive | Fixed `never` policy | Codex does not expose a mode picker; unexpected requests are declined explicitly |
| Goals | Unsupported | Supported | Provider-specific by design |
| Branching | Claude history copy | Not wired | Codex 0.144.1 exposes native `thread/fork`, but Lattice must re-key its own event history before enabling it |
| Model switching | Supported | Supported | None in the wired path |
| Reasoning-effort switching | Not applicable | Supported | None in the wired path |
| MCP elicitation | Provider/tool dependent | Explicitly declined | Lattice needs a typed form and OAuth surface before enabling Codex elicitation |
| Client-side dynamic tools | Provider/tool dependent | Explicitly rejected | Requires a real registration and execution contract |

The contract describes Lattice support, not every method a provider happens to
offer. Protocol discovery can suggest work, but it must not cause the UI to
advertise an unfinished feature.

### Codex branching slice

The installed protocol can fork a thread through a specific turn. Enabling the
button safely still requires one coherent transaction:

1. resolve the selected Lattice turn to a Codex turn ID;
2. call `thread/fork`;
3. create the new conversation and segment with the forked thread ID;
4. copy Lattice events only through the selected turn;
5. rewrite the copied resume identity and remembered run configuration to the
   forked thread and conversation;
6. copy turn summaries and branch lineage;
7. prove that history renders immediately and the first follow-up resumes the
   fork rather than the parent.

Until all seven steps pass, Codex branching stays hidden rather than failing
after the user clicks it.

## Turn activity receipts

The file-diff idea generalizes to an append-only activity ledger. Every receipt
belongs to a turn and records one artifact interaction.

```ts
interface ActivityReceipt {
  id: string;
  conversationId: string;
  turnId: string;
  operationId: string;
  kind: 'file' | 'linear_issue' | 'slack_message' | 'github_pr' | 'github_issue' | 'artifact';
  action: 'read' | 'created' | 'updated' | 'deleted' | 'sent';
  stableExternalId: string;
  permalink?: string;
  before?: unknown;
  after?: unknown;
  patch?: string;
  recordedAt: string;
}
```

The UI should render a small receipt table under each turn and a session-wide
ledger. File entries link to the path and patch. Linear, Slack, and GitHub
entries link to the external object and show the fields or content changed.

`operationId` also serves as the idempotency key for external mutations. A
reconnected client can retry a request without posting twice. Connectors that
offer their own idempotency key should receive the same value; other connectors
need a local operation record with pending, applied, or failed state.

The ledger does not depend on worktree isolation and works across directories.

## Safety boundaries

Required now:

- durable operation receipts for external or irreversible mutations;
- explicit capability checks before showing a control;
- visible provenance for what a turn read or changed;
- loud failure when a requested capability is unsupported.

Required if rollback ships:

- named owned roots;
- a checkpoint associated with the owning session and repository identity;
- a preview of changes that restore will discard;
- protection for untracked files and changes owned by another session or user.

A broad `git restore` plus `git clean -fd` is not safe for shared or multi-root
work. A dedicated worktree can make rollback reliable, but it is not required
for ordinary sessions or activity receipts.

## Effect experiment

The first experiment targets the live request lifecycle used by Codex
`request_user_input`: one answer or cancellation must win, duplicate mutations
must be observable, and the waiting turn must receive a typed result.

The test-only implementation is in
`test/unit/effect-request-lifecycle-experiment.test.ts`, using Effect 3.22.1.
It showed:

- `Deferred` makes the waiting request explicit;
- `Ref.modify` expresses the exactly-once transition atomically;
- cancellation remains a typed `RequestCancelled` failure instead of becoming
  an empty answer or an exception string;
- the happy path and duplicate-answer behavior are short and deterministic.

This is encouraging, not an adoption decision. The experiment has not yet
proved scoped cleanup, tracing, or integration with Express and the app-server
client. The next useful comparison is to implement the coordinator boundary
once with the existing class and once with Effect, then compare:

- unhandled failure visibility;
- cancellation and timeout behavior;
- deterministic test control;
- trace output;
- code size and concepts a maintainer must learn.

Core Effect is the candidate. The experimental Effect AI package is not a
foundation dependency at this stage.
