import type { SessionEvent, ContentBlock, ToolUseBlock } from '../events.js'
import { classifyTool, type ToolClassification } from './tool-classification.js'

// ---- Types ----

export interface CollapsedGroup {
  type: 'collapsed'
  events: SessionEvent[]
  summary: string
  counts: { read: number; search: number; list: number }
  paths: string[]
  /** True when the group is still accumulating (set by the consumer, not this function). */
  isActive?: boolean
  /** Hint text for the most recent tool in an active group (set by the consumer). */
  latestHint?: string
}

export type GroupedEvent = SessionEvent | CollapsedGroup

export function isCollapsedGroup(event: GroupedEvent): event is CollapsedGroup {
  return (event as CollapsedGroup).type === 'collapsed'
}

// ---- Internals ----

function getToolUseBlocks(event: SessionEvent): ToolUseBlock[] {
  if (event.type !== 'content') return []
  const data = event.data as { blocks?: ContentBlock[] }
  if (!data.blocks) return []
  return data.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
}

function isCollapsibleEvent(event: SessionEvent): boolean {
  const tools = getToolUseBlocks(event)
  if (tools.length === 0) return false
  return tools.every((t) => classifyTool(t.name, t.input).isCollapsible)
}

function buildSummary(counts: { read: number; search: number; list: number }): string {
  const parts: string[] = []

  if (counts.read > 0) {
    parts.push(`Read ${counts.read} file${counts.read !== 1 ? 's' : ''}`)
  }
  if (counts.search > 0) {
    parts.push(`searched ${counts.search} pattern${counts.search !== 1 ? 's' : ''}`)
  }
  if (counts.list > 0) {
    parts.push(`listed ${counts.list} director${counts.list !== 1 ? 'ies' : 'y'}`)
  }

  if (parts.length > 0) {
    parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  }

  return parts.join(', ') || 'Explored codebase'
}

function flushGroup(
  pendingEvents: SessionEvent[],
  classifications: ToolClassification[],
  output: GroupedEvent[],
): void {
  if (classifications.length < 2) {
    output.push(...pendingEvents)
    return
  }

  const counts = { read: 0, search: 0, list: 0 }
  const paths = new Set<string>()

  for (const c of classifications) {
    switch (c.category) {
      case 'read':
        if (c.name === 'LS' || c.name === 'ListMcpResourcesTool') {
          counts.list++
        } else {
          counts.read++
        }
        break
      case 'search':
        counts.search++
        break
    }
    if (c.detail) paths.add(c.detail)
  }

  output.push({
    type: 'collapsed',
    events: [...pendingEvents],
    summary: buildSummary(counts),
    counts,
    paths: [...paths],
  })
}

// ---- Public ----

/**
 * Groups consecutive collapsible tool events into collapsed summaries.
 *
 * Walks the event array in order. Consecutive `content` events whose tool_use
 * blocks are all collapsible (reads, searches, listings) — plus their
 * corresponding `result` events — are merged into a single `CollapsedGroup`.
 *
 * Groups of 1 are not collapsed (no benefit to summarizing a single tool call).
 * Non-collapsible events (writes, executes, agent ops) always pass through
 * individually and break any pending group.
 */
export function groupEvents(events: readonly SessionEvent[]): GroupedEvent[] {
  const output: GroupedEvent[] = []
  let pendingEvents: SessionEvent[] = []
  let pendingClassifications: ToolClassification[] = []

  for (const event of events) {
    if (event.type === 'content' && isCollapsibleEvent(event)) {
      pendingEvents.push(event)
      for (const tool of getToolUseBlocks(event)) {
        pendingClassifications.push(classifyTool(tool.name, tool.input))
      }
    } else if (event.type === 'result' && pendingEvents.length > 0) {
      // Result following collapsible content — include in the group
      pendingEvents.push(event)
    } else {
      // Non-collapsible event — flush pending, then emit
      if (pendingEvents.length > 0) {
        flushGroup(pendingEvents, pendingClassifications, output)
        pendingEvents = []
        pendingClassifications = []
      }
      output.push(event)
    }
  }

  if (pendingEvents.length > 0) {
    flushGroup(pendingEvents, pendingClassifications, output)
  }

  return output
}
