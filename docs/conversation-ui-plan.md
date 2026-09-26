# Conversation UI Plan

Adapt Claude Code's best UI patterns into Lattice's conversation view. Each wave is independently shippable. Each component has an explicit **pause point** for isolated UI prototyping before integration.

Companion to `harness-interpretation-layer-plan.md` (harness data layer). This doc covers the Lattice UI side.

## The Boundary

**Harness** (`agent-ui-harness`): pure data transforms. No React, no DOM. Stateless functions that take events in and return structured data.

**Lattice**: React components that consume harness functions and render them. All visual decisions live here.

### Harness functions needed

| Function | Input | Output |
|---|---|---|
| `classifyTool(name, input)` | Tool name + input object | `ToolClassification` — category, summary (present/past tense), collapsibility, detail string |
| `groupEvents(events)` | `SessionEvent[]` | `(SessionEvent \| CollapsedGroup)[]` — consecutive collapsible tools merged into summary objects |
| `deriveActivityState(events)` | `SessionEvent[]` (tail) | `ActivityState` — phase, current tool info, elapsed time, tool count |
| `deriveTaskState(events)` | `SessionEvent[]` | `TaskState` — task list with statuses, completed/pending/in-progress counts |

### Lattice components needed

**New:**
- `CollapsedGroupCard` — summary line for grouped read/search operations
- `ActivityIndicator` — current tool + verb + elapsed time
- `TaskProgress` — prioritized task checklist with completion fade
- `SubagentTree` — tree-style agent progress lines

**Modified:**
- `MessageList` — call `groupEvents()` before rendering, route collapsed groups
- `MessageItem` — handle streaming deltas
- `ThinkingIndicator` — compose with ActivityIndicator or replace
- `ConversationView` — subscribe to activity + task state, pass to new components
- `PermissionBanner` — wire to harness `permission:requested` events

---

## Wave 1: Collapsed Groups + Activity Indicator

No harness protocol extensions needed. Works on data that already flows through `normalizeClaude()` today — tool_use events in `assistant` messages.

### 1a. Collapsed Read/Search Groups

**The single biggest UX improvement.** Transforms conversation history from a wall of tool cards into scannable summaries. 8 reads become "Read 5 files, searched 3 patterns" with expand-on-click.

#### Harness work

Build `classifyTool()` and `groupEvents()` in `agent-ui-harness/src/protocol/classify/`.

`classifyTool()` maps tool names to categories:
- `read`: Read, Glob, LS — collapsible
- `search`: Grep, WebSearch, ToolSearch — collapsible
- `write`: Write, Edit, MultiEdit — never collapsed
- `execute`: Bash, REPL — never collapsed
- `agent`: Agent, Task, SendMessage — structural, never collapsed
- `meta`: AskUserQuestion, Plan tools — interactive, never collapsed
- `integration`: mcp__* — depends on tool

Returns human-friendly summaries in present ("Reading file") and past ("Read file") tense, plus the specific detail (file path, search pattern, command).

`groupEvents()` walks the event array:
- Consecutive collapsible tool_use events → one `CollapsedGroup` object
- Non-collapsible event breaks the group
- Groups of 1 don't collapse
- Tracks unique paths, deduplicates counts
- Summary string: "Read 3 files, searched 2 patterns"

Reference: CC's `collapseReadSearch.ts` (1100 lines). Our version will be simpler — CC tracks memory ops, git op extraction from bash results, hook timings. Start with core collapsing, extend later.

#### **>>> PAUSE: Build CollapsedGroupCard in isolation <<<**

Before wiring anything up, build the `CollapsedGroupCard` component with mock data. This component needs to handle:

**Visual states:**
- Collapsed (default): single summary line with counts and expand chevron
- Expanded: full list of individual tool calls with their results
- Active (live, group still growing): animated indicator + latest hint ("Reading config.json")
- Recently completed (< 30s): solid indicator, summary visible
- Historical: neutral indicator, summary only

**Design questions to resolve in isolation:**
- Card style: does it match existing tool cards or get its own treatment?
- Expand interaction: chevron? click anywhere? hover preview?
- Active state animation: match ThinkingIndicator energy or more subtle?
- How to show the "latest hint" (current file being read) during active grouping
- Path list layout when expanded: flat list? tree? truncated?

**Mock data shape:**
```typescript
interface CollapsedGroup {
  type: 'collapsed'
  events: SessionEvent[]          // Original events, for expand view
  summary: string                 // "Read 5 files, searched 3 patterns"
  counts: { read: number; search: number; list: number }
  paths?: string[]                // Unique paths touched
  isActive?: boolean              // Still accumulating
  latestHint?: string             // "Reading src/utils/index.ts"
}
```

Build with several mock groups: small (2 reads), medium (5 mixed), large (15+ reads), active (still growing), error (one tool failed in group).

#### Integration

- `MessageList.tsx`: call `groupEvents()` on the message array before rendering. When a `CollapsedGroup` appears in the result, render `CollapsedGroupCard` instead of individual `MessageItem`s.
- Existing per-tool renderers stay unchanged — they render inside expanded groups and for non-grouped tools.

---

### 1b. Activity Indicator

**Shows what Claude is doing, not just that it's "thinking."** Replaces the generic neural canvas with actionable context: tool name, verb, elapsed time, tool count.

#### Harness work (optional for v1)

`deriveActivityState()` scans the event tail:
- After `run:start` with no `content` → `thinking`
- After `content` with unresolved tool_use → `tool_active` (with tool info from `classifyTool()`)
- After `permission:requested` → `blocked`
- After `status:changed` compacting → `compacting`
- After `status:retry` → `retrying`
- After `turn:end` → `idle`

For v1, Lattice can derive this directly from the message stream without the harness function — look at the most recent unresolved tool_use, classify it, show it. The harness function formalizes this for both apps later.

#### **>>> PAUSE: Build ActivityIndicator in isolation <<<**

Before integration, build the `ActivityIndicator` component with mock state. This component shows:

**Display elements:**
- Phase label: "Thinking", "Reading files", "Running command", "Blocked on permission", "Compacting context"
- Current tool detail: "src/utils/config.ts" or "npm test" or "searching for: auth middleware"
- Elapsed time: live-ticking seconds counter (CC uses 1s interval)
- Tool call count: "12 tool calls this turn"
- Verb from task context (if available): "Fixing the auth bug" or "Researching codebase"

**Design questions to resolve in isolation:**
- Relationship to ThinkingIndicator: replace entirely? overlay on top? compose side-by-side?
- The neural canvas animation is visually distinctive — is it worth keeping as a subtle background while showing text info?
- Typography and hierarchy: what's primary (verb/phase) vs secondary (elapsed, count)?
- Transition animations between states (thinking → tool_active → thinking → idle)
- Where does it live? Current ThinkingIndicator position? Floating? Sticky header?

**CC's timing discipline to consider:**
- Min 2s display per state (prevents jitter from fast tool calls)
- Min 700ms for hint text display
- These thresholds matter — without them, fast read sequences create a strobe effect

**Mock states to build:**
```typescript
type ActivityPhase = 'idle' | 'thinking' | 'tool_active' | 'blocked' | 'compacting' | 'retrying'

interface ActivityState {
  phase: ActivityPhase
  currentTool?: { name: string; summary: string; detail?: string }
  verb?: string                   // From task context: "Fixing auth bug"
  turnStartedAt?: number
  toolCallCount: number
  elapsedMs?: number
}
```

Build with all phases, fast transitions (to test jitter prevention), and long-running tools (to test elapsed time display).

#### Integration

- `ConversationView` derives activity state from event stream (or calls harness function)
- `ActivityIndicator` receives state as props
- Replace or compose with `ThinkingIndicator` based on design decisions from pause point

---

## Wave 2: Task Progress + Streaming

### 2a. Task Progress Overlay

**Shows Claude's plan and progress as a live checklist.** Surfaces TaskCreate/TaskUpdate tool calls as a persistent, prioritized task list.

#### Harness work

`deriveTaskState()` scans for tool_use blocks where `name === 'TaskCreate'` or `name === 'TaskUpdate'`. Extracts the task list from inputs and results. Returns:

```typescript
interface TaskState {
  tasks: TaskItem[]
  completedCount: number
  pendingCount: number
  inProgressCount: number
}

interface TaskItem {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  blockedBy: string[]
}
```

#### **>>> PAUSE: Build TaskProgress in isolation <<<**

Build the `TaskProgress` component with mock task lists. This is the equivalent of CC's `TaskListV2`.

**Display elements:**
- Prioritized task list: recently completed (fading) → in-progress → pending
- Max visible count (CC uses 10, with "+N pending, +M in progress" overflow)
- 30s TTL for completed tasks (fade then remove)
- Status indicators per task: checkbox, spinner, or blocked icon
- Optional: owner/agent labels if subagents own tasks

**Design questions to resolve in isolation:**
- Placement: sidebar panel? floating overlay? collapsible header section? inline in conversation?
- Should it persist across scroll or float in a fixed position?
- Interaction: clickable tasks? jump to the message where the task was created?
- Visual weight: this competes with the conversation for attention — how prominent?
- Empty state: hide entirely when no tasks? show "No active tasks"?
- Mobile/narrow viewport behavior?

**Mock data to build with:**
- No tasks (empty state)
- 3 tasks: 1 completed, 1 in-progress, 1 pending
- 8 tasks with overflow
- Rapid completions (test 30s fade timing)
- Blocked tasks (depends on another task)

#### Integration

- `ConversationView` calls `deriveTaskState()` on events
- `TaskProgress` rendered at the chosen position
- Re-derives on every new event (or debounced)

---

### 2b. Streaming Deltas

**Token-by-token text output instead of waiting for full messages.** Reduces perceived latency significantly.

#### Harness work (Phase 1 dependency)

- `normalizeClaude()` handles `stream_event` → emits `content:delta` as transient event
- EventLog fires transient events to subscribers but skips SQLite storage
- SSE delivers deltas to connected clients

#### **>>> PAUSE: Build streaming text rendering in isolation <<<**

Before wiring up real deltas, build the streaming text append behavior with mock token sequences.

**Behavior to prototype:**
- Text appears token-by-token in the current assistant message
- Markdown rendering updates incrementally (not re-parsing full text each token)
- Cursor/caret indicator at the end of streaming text
- Smooth transition when streaming completes and full message replaces deltas

**Design questions to resolve in isolation:**
- Does the streaming text render inside the existing `MessageItem` or a temporary overlay?
- Markdown rendering during streaming: render incrementally or show raw text then format on completion?
- Performance: at 50-100 tokens/sec, can the markdown renderer keep up?
- Visual indicator that text is still streaming (cursor blink, subtle pulse on last line)

**Mock sequence:** array of token strings with realistic timing (10-50ms gaps), including markdown formatting mid-stream (code blocks that open before they close, etc.).

#### Integration

- `MessageItem` subscribes to `content:delta` events for the current message
- Appends tokens to a streaming buffer
- On full `content` event, replaces buffer with complete message
- Handles markdown gracefully during streaming

---

## Wave 3: Subagent Tree + Permissions

### 3a. Subagent Tree

**Tree-style visualization of agent spawning with live progress.** Shows parent-child relationships, tool counts, token usage per agent.

#### Harness work

Needs agent lifecycle tracking — `classifyTool()` already identifies agent/task tools. Additional state derivation to build the tree structure from spawn events and their results.

#### **>>> PAUSE: Build SubagentTree in isolation <<<**

**Display elements (from CC's patterns):**
- Tree lines: `├─` / `└─` with proper nesting
- Per agent: type badge (colored), description, tool count, token count
- Status: running (with current tool), backgrounded, completed
- Elapsed time per agent (1s tick)

**Design questions to resolve in isolation:**
- Where does this render? Inside the conversation flow? Persistent panel?
- Depth limit: how deep can nesting go before it's unreadable?
- Interaction: click to focus on agent's output? expand/collapse subtrees?
- Relationship to TaskProgress: are these the same panel or separate concerns?

**Mock data:** 1 agent (simple), 3 parallel agents (flat), nested agents (2 levels deep), mixed states (one running, one done, one backgrounded).

#### Integration

- Derive agent tree from event stream
- Render in chosen position
- Update on agent lifecycle events

---

### 3b. Permission Prompts

**Render CC's permission requests in the Lattice UI.** Wire the existing PermissionBanner/PermissionTracker to the harness control protocol.

#### Harness work (Phase 1 dependency)

- `normalizeClaude()` handles `control_request: can_use_tool` → `permission:requested`
- Write path: send `control_response` back via `ProcessHandle.write()`

#### **>>> PAUSE: Build permission prompt UI in isolation <<<**

Lattice already has PermissionBanner and PermissionTracker. The pause here is to design the specific prompt for CC tool permissions:

**Design questions:**
- Show tool name, input summary, and classification from `classifyTool()`
- Allow/deny buttons with optional "always allow this pattern" checkbox
- Queue multiple pending permissions (CC can have several queued)
- Timeout behavior if user doesn't respond

**Mock data:** single permission request, multiple queued, various tool types (Bash with command, Write with path, MCP tool).

#### Integration

- Bridge `permission:requested` events to PermissionTracker
- Route approval/denial back through harness write path
- Accumulate allowlist patterns per session/project

---

## Wave Summary

| Wave | Components | Harness Dependency | Pause Points |
|---|---|---|---|
| **1a** | CollapsedGroupCard, MessageList changes | `classifyTool()`, `groupEvents()` | CollapsedGroupCard isolation |
| **1b** | ActivityIndicator, ThinkingIndicator changes | `classifyTool()` (reuse), optional `deriveActivityState()` | ActivityIndicator isolation |
| **2a** | TaskProgress | `deriveTaskState()` | TaskProgress isolation |
| **2b** | Streaming text in MessageItem | Phase 1 normalizer + transient events | Streaming render isolation |
| **3a** | SubagentTree | Agent lifecycle derivation | SubagentTree isolation |
| **3b** | Permission prompt UI | Phase 1 normalizer + write path | Permission prompt isolation |

Each wave is independently shippable. Within each wave, the harness function ships first (testable with unit tests), then the UI component is prototyped in isolation, then integration wires them together.

## File Locations

### Harness (agent-ui-harness)
- `src/protocol/classify/tool-classification.ts` — `classifyTool()`
- `src/protocol/classify/group-events.ts` — `groupEvents()`
- `src/protocol/classify/derive-state.ts` — `deriveActivityState()`, `deriveTaskState()`

### Lattice (lattice-orchestrator)
- `src/web/chat/components/CollapsedGroup/CollapsedGroupCard.tsx`
- `src/web/chat/components/ActivityIndicator/ActivityIndicator.tsx`
- `src/web/chat/components/TaskProgress/TaskProgress.tsx`
- `src/web/chat/components/SubagentTree/SubagentTree.tsx`
- Modified: `MessageList.tsx`, `MessageItem.tsx`, `ThinkingIndicator.tsx`, `ConversationView.tsx`, `PermissionBanner/`
