import type { SessionEvent } from '../events.js'

/** Tool names whose tool_use → tool_result span contains subagent work. */
const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task'])

export interface SubagentExtraction {
  /** Events that belong to the top-level conversation (or the current nesting scope). */
  topLevel: SessionEvent[]
  /** Child events keyed by their parent Agent/Task tool_use id. */
  childrenByToolUseId: Record<string, SessionEvent[]>
}

/** Data shape for content/result events that may carry parentToolUseId. */
interface EventData {
  blocks?: Array<{ type: string; name?: string; id?: string; tool_use_id?: string }>
  messageId?: string
  parentToolUseId?: string | null
}

/**
 * Walks the raw event stream and separates subagent child events from top-level
 * events.
 *
 * Primary strategy: use `parentToolUseId` from the CLI, which explicitly tags
 * every event with its owning agent's tool_use ID (null = top-level). This
 * handles parallel agents, nested agents, and abandoned agents correctly.
 *
 * Fallback (legacy events without parentToolUseId): positional boundary
 * detection — all events between an Agent/Task tool_use and its matching
 * tool_result are children. Parallel agents detected by message ID grouping
 * are excluded from positional nesting since their events interleave.
 */
export function extractSubagentChildren(events: readonly SessionEvent[]): SubagentExtraction {
  // Check if events carry parentToolUseId (new CLI versions).
  // A single non-null parentToolUseId anywhere means we can use the explicit strategy.
  const hasExplicitParenting = events.some(
    (e) => {
      const data = e.data as EventData | undefined
      return data?.parentToolUseId != null
    },
  )

  return hasExplicitParenting
    ? extractByParentId(events)
    : extractByPosition(events)
}

// ---- Explicit strategy: use parentToolUseId ----

function extractByParentId(events: readonly SessionEvent[]): SubagentExtraction {
  const topLevel: SessionEvent[] = []
  const childrenByToolUseId: Record<string, SessionEvent[]> = {}

  // Collect all known agent tool_use IDs so we can initialise their child arrays.
  const agentIds = new Set<string>()
  const seenAgentIds = new Set<string>() // Dedup streaming splits
  for (const event of events) {
    if (event.type !== 'content') continue
    const data = event.data as EventData
    for (const block of data.blocks ?? []) {
      if (block.type === 'tool_use' && SUBAGENT_TOOL_NAMES.has(block.name ?? '') && block.id) {
        agentIds.add(block.id)
      }
    }
  }
  for (const id of agentIds) {
    childrenByToolUseId[id] = []
  }

  for (const event of events) {
    const data = event.data as EventData | undefined
    const parentId = data?.parentToolUseId

    // Streaming duplicate detection: if this content event introduces an
    // Agent tool_use we've already seen, skip it.
    if (event.type === 'content') {
      let isDuplicate = false
      for (const block of (data?.blocks ?? [])) {
        if (block.type === 'tool_use' && SUBAGENT_TOOL_NAMES.has(block.name ?? '') && block.id) {
          if (seenAgentIds.has(block.id)) {
            isDuplicate = true
          } else {
            seenAgentIds.add(block.id)
          }
          break
        }
      }
      if (isDuplicate) continue
    }

    if (parentId && childrenByToolUseId[parentId]) {
      childrenByToolUseId[parentId].push(event)
    } else {
      topLevel.push(event)
    }
  }

  return { topLevel, childrenByToolUseId }
}

// ---- Legacy fallback: positional boundary detection ----

function extractByPosition(events: readonly SessionEvent[]): SubagentExtraction {
  const parallelIds = findParallelAgentIds(events)

  const topLevel: SessionEvent[] = []
  const childrenByToolUseId: Record<string, SessionEvent[]> = {}
  const stack: string[] = []
  const seenAgentIds = new Set<string>()

  for (const event of events) {
    // Check if this result event closes the current subagent context
    if (event.type === 'result' && stack.length > 0) {
      const data = event.data as EventData
      const currentAgentId = stack[stack.length - 1]
      const closesAgent = (data.blocks ?? []).some(
        (b) => b.type === 'tool_result' && b.tool_use_id === currentAgentId,
      )
      if (closesAgent) {
        stack.pop()
        if (stack.length > 0) {
          childrenByToolUseId[stack[stack.length - 1]].push(event)
        } else {
          topLevel.push(event)
        }
        continue
      }
    }

    // Detect Agent/Task tool_use blocks and check for streaming duplicates.
    let isDuplicate = false
    let newAgentId: string | undefined
    if (event.type === 'content') {
      const data = event.data as EventData
      for (const block of data.blocks ?? []) {
        if (block.type === 'tool_use' && SUBAGENT_TOOL_NAMES.has(block.name ?? '') && block.id) {
          if (seenAgentIds.has(block.id)) {
            isDuplicate = true
          } else {
            newAgentId = block.id
          }
          break
        }
      }
    }
    if (isDuplicate) continue

    // Route event to current level
    if (stack.length > 0) {
      childrenByToolUseId[stack[stack.length - 1]].push(event)
    } else {
      topLevel.push(event)
    }

    // Open new subagent context (AFTER routing, since the Agent tool_use
    // itself belongs to the parent level — it renders the TaskTool card there).
    // Skip parallel agents — their events stay flat at the parent level.
    if (newAgentId) {
      seenAgentIds.add(newAgentId)
      if (!parallelIds.has(newAgentId)) {
        stack.push(newAgentId)
        childrenByToolUseId[newAgentId] = []
      }
    }
  }

  return { topLevel, childrenByToolUseId }
}

/**
 * Pre-scan to identify agents that are parallel (launched simultaneously by
 * the same model turn) vs. serial/nested.
 */
function findParallelAgentIds(events: readonly SessionEvent[]): Set<string> {
  const parallelIds = new Set<string>()
  const agentsByMessageId = new Map<string, string[]>()

  for (const event of events) {
    if (event.type === 'content') {
      const data = event.data as EventData
      const messageId = data.messageId
      if (!messageId) continue

      for (const block of data.blocks ?? []) {
        if (block.type === 'tool_use' && SUBAGENT_TOOL_NAMES.has(block.name ?? '') && block.id) {
          const group = agentsByMessageId.get(messageId)
          if (group) {
            group.push(block.id)
          } else {
            agentsByMessageId.set(messageId, [block.id])
          }
        }
      }
    }
  }

  for (const [, ids] of agentsByMessageId) {
    if (ids.length > 1) {
      for (const id of ids) parallelIds.add(id)
    }
  }

  return parallelIds
}
