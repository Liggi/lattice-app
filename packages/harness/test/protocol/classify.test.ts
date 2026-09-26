import { describe, it, expect } from 'vitest'
import { classifyTool } from '../../src/protocol/classify/tool-classification.js'
import {
  groupEvents,
  isCollapsedGroup,
  type CollapsedGroup,
} from '../../src/protocol/classify/group-events.js'
import type { SessionEvent } from '../../src/protocol/events.js'

// ---- Helpers ----

let seqCounter = 0

function toolContentEvent(
  name: string,
  input: Record<string, unknown>,
): SessionEvent {
  return {
    sessionId: 'test',
    runId: 'run-1',
    seq: ++seqCounter,
    timestamp: Date.now(),
    type: 'content',
    data: {
      blocks: [{ type: 'tool_use', id: `tool-${seqCounter}`, name, input }],
    },
  }
}

function resultEvent(toolUseId: string): SessionEvent {
  return {
    sessionId: 'test',
    runId: 'run-1',
    seq: ++seqCounter,
    timestamp: Date.now(),
    type: 'result',
    data: {
      blocks: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  }
}

function textContentEvent(text: string): SessionEvent {
  return {
    sessionId: 'test',
    runId: 'run-1',
    seq: ++seqCounter,
    timestamp: Date.now(),
    type: 'content',
    data: { blocks: [{ type: 'text', text }] },
  }
}

function toolPair(
  name: string,
  input: Record<string, unknown>,
): [SessionEvent, SessionEvent] {
  const content = toolContentEvent(name, input)
  const toolId = (
    (content.data as { blocks: { id: string }[] }).blocks[0] as { id: string }
  ).id
  return [content, resultEvent(toolId)]
}

// ---- classifyTool ----

describe('classifyTool', () => {
  it('classifies Read as collapsible read', () => {
    const c = classifyTool('Read', { file_path: '/src/foo.ts' })
    expect(c.category).toBe('read')
    expect(c.isCollapsible).toBe(true)
    expect(c.isStructural).toBe(false)
    expect(c.detail).toBe('/src/foo.ts')
    expect(c.summary.present).toBe('Reading file')
    expect(c.summary.past).toBe('Read file')
  })

  it('classifies Grep as collapsible search', () => {
    const c = classifyTool('Grep', { pattern: 'TODO' })
    expect(c.category).toBe('search')
    expect(c.isCollapsible).toBe(true)
    expect(c.detail).toBe('TODO')
  })

  it('classifies Write as non-collapsible write', () => {
    const c = classifyTool('Write', { file_path: '/src/new.ts', content: '...' })
    expect(c.category).toBe('write')
    expect(c.isCollapsible).toBe(false)
    expect(c.detail).toBe('/src/new.ts')
  })

  it('classifies Bash as non-collapsible execute', () => {
    const c = classifyTool('Bash', { command: 'npm test' })
    expect(c.category).toBe('execute')
    expect(c.isCollapsible).toBe(false)
    expect(c.detail).toBe('npm test')
  })

  it('truncates long Bash commands', () => {
    const c = classifyTool('Bash', { command: 'a'.repeat(100) })
    expect(c.detail!.length).toBeLessThanOrEqual(60)
    expect(c.detail!.endsWith('…')).toBe(true)
  })

  it('classifies Agent as structural', () => {
    const c = classifyTool('Agent', {
      description: 'Find tests',
      subagent_type: 'Explore',
    })
    expect(c.category).toBe('agent')
    expect(c.isStructural).toBe(true)
    expect(c.isCollapsible).toBe(false)
    expect(c.detail).toBe('Find tests')
  })

  it('falls back to subagent_type when Agent has no description', () => {
    const c = classifyTool('Agent', { subagent_type: 'Explore' })
    expect(c.detail).toBe('Explore')
  })

  it('classifies MCP tools with server name', () => {
    const c = classifyTool('mcp__slack__send_message', {})
    expect(c.category).toBe('integration')
    expect(c.mcpServer).toBe('slack')
    expect(c.isCollapsible).toBe(false)
    expect(c.summary.present).toContain('slack')
  })

  it('handles deeply nested MCP names', () => {
    const c = classifyTool('mcp__chrome_devtools__take_screenshot', {})
    expect(c.mcpServer).toBe('chrome_devtools')
  })

  it('classifies unknown tools as non-collapsible meta', () => {
    const c = classifyTool('BrandNewTool', {})
    expect(c.category).toBe('meta')
    expect(c.isCollapsible).toBe(false)
    expect(c.isStructural).toBe(false)
    expect(c.summary.present).toBe('Using BrandNewTool')
  })

  it('handles missing or malformed input gracefully', () => {
    expect(classifyTool('Read').detail).toBeUndefined()
    expect(classifyTool('Read', null).detail).toBeUndefined()
    expect(classifyTool('Read', 'not-an-object').detail).toBeUndefined()
    expect(classifyTool('Read', []).detail).toBeUndefined()
  })
})

// ---- groupEvents ----

describe('groupEvents', () => {
  beforeEach(() => {
    seqCounter = 0
  })

  it('returns empty array for empty input', () => {
    expect(groupEvents([])).toEqual([])
  })

  it('does not collapse a single collapsible tool call', () => {
    const events = toolPair('Read', { file_path: 'a.ts' })
    const grouped = groupEvents(events)
    expect(grouped).toHaveLength(2)
    expect(grouped.every((g) => !isCollapsedGroup(g))).toBe(true)
  })

  it('collapses consecutive collapsible tool calls', () => {
    const events = [
      ...toolPair('Read', { file_path: 'a.ts' }),
      ...toolPair('Read', { file_path: 'b.ts' }),
      ...toolPair('Grep', { pattern: 'foo' }),
    ]
    const grouped = groupEvents(events)
    expect(grouped).toHaveLength(1)
    expect(isCollapsedGroup(grouped[0])).toBe(true)

    const group = grouped[0] as CollapsedGroup
    expect(group.counts.read).toBe(2)
    expect(group.counts.search).toBe(1)
    expect(group.summary).toBe('Read 2 files, searched 1 pattern')
    expect(group.events).toHaveLength(6)
    expect(group.paths).toContain('a.ts')
    expect(group.paths).toContain('b.ts')
    expect(group.paths).toContain('foo')
  })

  it('breaks group at non-collapsible event', () => {
    const events = [
      ...toolPair('Read', { file_path: 'a.ts' }),
      ...toolPair('Read', { file_path: 'b.ts' }),
      ...toolPair('Bash', { command: 'npm test' }),
      ...toolPair('Read', { file_path: 'c.ts' }),
    ]
    const grouped = groupEvents(events)
    // [CollapsedGroup(2 reads), Bash content, Bash result, Read content, Read result]
    expect(grouped).toHaveLength(5)
    expect(isCollapsedGroup(grouped[0])).toBe(true)
    expect((grouped[0] as CollapsedGroup).counts.read).toBe(2)
    // Trailing single read is NOT collapsed
    expect(isCollapsedGroup(grouped[3])).toBe(false)
    expect(isCollapsedGroup(grouped[4])).toBe(false)
  })

  it('passes through non-collapsible events unchanged', () => {
    const events = [
      ...toolPair('Bash', { command: 'echo hi' }),
      ...toolPair('Write', { file_path: 'x.ts', content: '...' }),
    ]
    const grouped = groupEvents(events)
    expect(grouped).toHaveLength(4)
    expect(grouped.every((g) => !isCollapsedGroup(g))).toBe(true)
  })

  it('handles text-only content events without grouping', () => {
    const events = [textContentEvent('Hello'), textContentEvent('World')]
    const grouped = groupEvents(events)
    expect(grouped).toHaveLength(2)
    expect(grouped.every((g) => !isCollapsedGroup(g))).toBe(true)
  })

  it('text event breaks a pending group', () => {
    const events = [
      ...toolPair('Read', { file_path: 'a.ts' }),
      ...toolPair('Read', { file_path: 'b.ts' }),
      textContentEvent('Here is what I found:'),
      ...toolPair('Read', { file_path: 'c.ts' }),
    ]
    const grouped = groupEvents(events)
    // [CollapsedGroup(2 reads), text, Read content, Read result]
    expect(grouped).toHaveLength(4)
    expect(isCollapsedGroup(grouped[0])).toBe(true)
    expect(isCollapsedGroup(grouped[1])).toBe(false)
  })

  it('counts LS as list, not read', () => {
    const events = [
      ...toolPair('Read', { file_path: 'a.ts' }),
      ...toolPair('LS', { path: '/src' }),
    ]
    const grouped = groupEvents(events)
    expect(grouped).toHaveLength(1)

    const group = grouped[0] as CollapsedGroup
    expect(group.counts.read).toBe(1)
    expect(group.counts.list).toBe(1)
    expect(group.summary).toBe('Read 1 file, listed 1 directory')
  })

  it('deduplicates paths', () => {
    const events = [
      ...toolPair('Read', { file_path: 'a.ts' }),
      ...toolPair('Read', { file_path: 'a.ts' }),
      ...toolPair('Read', { file_path: 'b.ts' }),
    ]
    const grouped = groupEvents(events)
    const group = grouped[0] as CollapsedGroup
    expect(group.paths).toHaveLength(2)
    expect(group.paths).toContain('a.ts')
    expect(group.paths).toContain('b.ts')
    // Count is by invocation, not unique paths
    expect(group.counts.read).toBe(3)
  })

  it('handles mixed read and search groups', () => {
    const events = [
      ...toolPair('Read', { file_path: 'a.ts' }),
      ...toolPair('Grep', { pattern: 'TODO' }),
      ...toolPair('Glob', { pattern: '**/*.ts' }),
      ...toolPair('WebSearch', { query: 'vitest setup' }),
      ...toolPair('Read', { file_path: 'b.ts' }),
    ]
    const grouped = groupEvents(events)
    expect(grouped).toHaveLength(1)

    const group = grouped[0] as CollapsedGroup
    expect(group.counts.read).toBe(3) // Read + Glob + Read
    expect(group.counts.search).toBe(2) // Grep + WebSearch
    expect(group.summary).toBe('Read 3 files, searched 2 patterns')
  })

  it('preserves event order in collapsed group', () => {
    const events = [
      ...toolPair('Read', { file_path: 'first.ts' }),
      ...toolPair('Grep', { pattern: 'second' }),
    ]
    const grouped = groupEvents(events)
    const group = grouped[0] as CollapsedGroup
    // First event should be the Read content event
    expect(group.events[0].seq).toBeLessThan(group.events[2].seq)
  })

  it('search-only group starts with capital S', () => {
    const events = [
      ...toolPair('Grep', { pattern: 'foo' }),
      ...toolPair('Grep', { pattern: 'bar' }),
    ]
    const grouped = groupEvents(events)
    const group = grouped[0] as CollapsedGroup
    expect(group.summary).toBe('Searched 2 patterns')
    expect(group.summary[0]).toBe('S') // Capitalized
  })
})
