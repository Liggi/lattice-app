# Subagent Event Nesting Design

## Problem

When Claude spawns a subagent (Agent tool), the subagent's events (reads, edits, bash calls) appear as flat top-level blocks in the conversation view. They should render nested inside the parent TaskTool card.

## Current State

**What works:**
- `TaskTool` component already renders nested `childrenMessages` — full plumbing exists through ConversationView → MessageList → MessageItem → ToolUseRenderer → ToolContent → TaskTool
- `childrenMessages` is hardcoded to `{}` in ConversationView (line 925)
- Harness event stream captures all events including subagent work

**What's missing:**
- No mechanism to associate child events with their parent Agent tool_use
- `useHarnessSession.eventsToRenderItems()` treats all events as top-level

## Key Finding: Positional Boundary Detection

The parent-child boundary is already implicit in the event stream via tool_use/tool_result id pairing. No protocol changes needed.

Real data from one session:

```
seq 165-167: Bash calls (run 043182ba)     ← parent agent's own tools  
seq 168:     Agent tool_use id=toolu_01M21ZZZ...  ← subagent spawned
seq 169-248: Glob, Bash, Read, Grep...     ← ALL subagent work (80 events)
seq 249:     tool_result ref=toolu_01M21ZZZ...    ← subagent returns
seq 250:     thinking                       ← parent agent resumes
seq 251:     text                           ← parent agent responds
```

Every `tool_use` block has an `id`, and its corresponding `tool_result` has a `tool_use_id` that matches. For Agent tools, all events between the `tool_use` and its `tool_result` are the subagent's work. Same pairing mechanism `collapsedGroupToData` already uses — just at a larger scale.

### runId does NOT help

Investigated whether subagents get distinct `runId` values. They don't — parent and child share the same runId. The runId changes at turn boundaries, not subagent boundaries.

## Implementation Plan

### Step 1: Extract child events in useHarnessSession

In `eventsToRenderItems()`, add a pre-pass that:

1. Scans events for Agent/Task `content` events containing `tool_use` blocks
2. Notes each Agent tool's `id` as a pending parent
3. Collects all subsequent events until the matching `tool_result` with that `tool_use_id`
4. Converts those events to `ChatMessage[]` and stores as `childrenMessages[toolUseId]`
5. Excludes those child events from the top-level render items

This is a single-pass operation over the events array, maintaining a stack of open Agent contexts (handles nested subagents).

### Step 2: Return childrenMessages from useHarnessSession

Add `childrenMessages: Record<string, ChatMessage[]>` to `UseHarnessSessionReturn`. Derive it alongside `messages` and `renderItems` in the hook.

### Step 3: Thread through props

Replace `childrenMessages={{} as Record<string, ChatMessage[]>}` in ConversationView with the real data from `useHarnessSession`.

### Step 4: Nothing (TaskTool already renders children)

`TaskTool` already:
- Checks `childrenMessages[toolUseId]` for nested content
- Renders child messages via `renderChildMessage()` callback
- Has expand/collapse, scroll, and height management

## Edge Cases to Consider

- **Nested subagents**: Agent spawns Agent. The stack approach in step 1 handles this — inner Agent's events are children of the inner Agent, not the outer one.
- **Streaming**: During active streaming, the Agent's `tool_result` hasn't arrived yet. Child events should still be collected and rendered (the boundary is "pending" — all events after the Agent tool_use are tentatively children until proven otherwise).
- **Multiple Agent tools in one content block**: Unlikely but possible. Each would have its own `id` and matching `tool_result`.
- **Backfilled sessions**: Work the same — positional logic doesn't depend on runId.

## Complexity Assessment

| Step | Where | Effort |
|------|-------|--------|
| Extract child events | `useHarnessSession.ts` | Medium — new function, ~50-80 lines |
| Return from hook | `useHarnessSession.ts` | Trivial — add to return interface |
| Thread through props | `ConversationView.tsx` | Trivial — replace `{}` |
| TaskTool rendering | Already done | Zero |

Total: ~half day of focused work. The design is straightforward because the positional boundary detection is unambiguous and the rendering layer is already built.
