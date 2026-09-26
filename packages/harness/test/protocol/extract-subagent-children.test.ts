import { describe, it, expect, beforeEach } from 'vitest'
import { extractSubagentChildren } from '../../src/protocol/classify/extract-subagent-children.js'
import type { SessionEvent } from '../../src/protocol/events.js'

// ---- Helpers ----

let seq = 0

function reset() {
  seq = 0
}

function ev(type: SessionEvent['type'], data: unknown = {}, meta?: SessionEvent['meta']): SessionEvent {
  return { sessionId: 's1', runId: 'r1', seq: ++seq, timestamp: Date.now(), type, data, meta }
}

function agentToolUse(id: string, description: string, messageId = `msg-${seq + 1}`, parentToolUseId: string | null = null): SessionEvent {
  return ev('content', {
    blocks: [{ type: 'tool_use', id, name: 'Agent', input: { description, subagent_type: 'Explore' } }],
    messageId,
    parentToolUseId,
  }, { rawType: 'assistant' })
}

function toolUse(name: string, id: string, parentToolUseId: string | null = null, messageId = `msg-${seq + 1}`): SessionEvent {
  return ev('content', {
    blocks: [{ type: 'tool_use', id, name, input: {} }],
    messageId,
    parentToolUseId,
  }, { rawType: 'assistant' })
}

function toolResult(toolUseId: string, parentToolUseId: string | null = null): SessionEvent {
  return ev('result', {
    blocks: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    parentToolUseId,
  }, { rawType: 'user' })
}

function textBlock(text: string, parentToolUseId: string | null = null, messageId = `msg-${seq + 1}`): SessionEvent {
  return ev('content', {
    blocks: [{ type: 'text', text }],
    messageId,
    parentToolUseId,
  }, { rawType: 'assistant' })
}

function inputSent(text = 'user message'): SessionEvent {
  return ev('input:sent', { text })
}

function turnEnd(): SessionEvent {
  return ev('turn:end', {})
}

function runEnd(): SessionEvent {
  return ev('run:end', {})
}

function runStart(): SessionEvent {
  return ev('run:start', {})
}

// ---- Tests ----

describe('extractSubagentChildren', () => {
  beforeEach(reset)

  describe('serial agent (single agent per turn)', () => {
    it('nests child events inside the agent', () => {
      const events = [
        agentToolUse('agent-1', 'Find files'),
        toolUse('Bash', 'bash-1', 'agent-1'),
        toolResult('bash-1', 'agent-1'),
        toolUse('Read', 'read-1', 'agent-1'),
        toolResult('read-1', 'agent-1'),
        toolResult('agent-1'),
      ]

      const { topLevel, childrenByToolUseId } = extractSubagentChildren(events)

      expect(topLevel).toHaveLength(2) // agent tool_use + agent tool_result
      expect(childrenByToolUseId['agent-1']).toHaveLength(4) // bash + result + read + result
    })

    it('routes events after agent close to top level', () => {
      const events = [
        agentToolUse('agent-1', 'Find files'),
        toolUse('Bash', 'bash-1', 'agent-1'),
        toolResult('bash-1', 'agent-1'),
        toolResult('agent-1'),
        textBlock('Here is what I found'),
        toolUse('Edit', 'edit-1'),
        toolResult('edit-1'),
      ]

      const { topLevel, childrenByToolUseId } = extractSubagentChildren(events)

      expect(childrenByToolUseId['agent-1']).toHaveLength(2)
      // agent open + agent close + text + edit + edit result = 5
      expect(topLevel).toHaveLength(5)
    })
  })

  describe('parallel agents (multiple agents in same message)', () => {
    it('attributes child events to the correct parent agent', () => {
      const sharedMsgId = 'msg-parent'
      const events = [
        agentToolUse('agent-A', 'Search repo A', sharedMsgId),
        // A's children (parentToolUseId = 'agent-A')
        toolUse('Bash', 'bash-a1', 'agent-A', 'msg-a1'),
        toolResult('bash-a1', 'agent-A'),
        toolUse('Read', 'read-a1', 'agent-A', 'msg-a2'),
        toolResult('read-a1', 'agent-A'),
        // B opens in same parent message
        agentToolUse('agent-B', 'Search repo B', sharedMsgId),
        // B's children (parentToolUseId = 'agent-B')
        toolUse('Grep', 'grep-b1', 'agent-B', 'msg-b1'),
        toolResult('grep-b1', 'agent-B'),
        toolUse('Read', 'read-b1', 'agent-B', 'msg-b2'),
        toolResult('read-b1', 'agent-B'),
        // Both close
        toolResult('agent-B'),
        toolResult('agent-A'),
      ]

      const { topLevel, childrenByToolUseId } = extractSubagentChildren(events)

      // Both agents should have their own children, not be flattened
      expect(childrenByToolUseId['agent-A']).toBeDefined()
      expect(childrenByToolUseId['agent-B']).toBeDefined()
      expect(childrenByToolUseId['agent-A']!).toHaveLength(4) // bash + result + read + result
      expect(childrenByToolUseId['agent-B']!).toHaveLength(4) // grep + result + read + result
    })

    it('handles interleaved parallel agent events', () => {
      const sharedMsgId = 'msg-parent'
      const events = [
        agentToolUse('agent-A', 'Search repo A', sharedMsgId),
        agentToolUse('agent-B', 'Search repo B', sharedMsgId),
        // Interleaved children — parentToolUseId tells us which is which
        toolUse('Bash', 'bash-1', 'agent-A', 'msg-x1'),
        toolResult('bash-1', 'agent-A'),
        toolUse('Read', 'read-1', 'agent-B', 'msg-x2'),
        toolResult('read-1', 'agent-B'),
        toolUse('Grep', 'grep-1', 'agent-A', 'msg-x3'),
        toolResult('grep-1', 'agent-A'),
        toolResult('agent-B'),
        toolResult('agent-A'),
      ]

      const { topLevel, childrenByToolUseId } = extractSubagentChildren(events)

      expect(childrenByToolUseId['agent-A']).toHaveLength(4) // bash + result + grep + result
      expect(childrenByToolUseId['agent-B']).toHaveLength(2) // read + result
    })
  })

  describe('abandoned agent (no tool_result)', () => {
    it('does not swallow subsequent turns into the agent', () => {
      const events = [
        agentToolUse('agent-1', 'Long running task'),
        toolUse('Bash', 'bash-1', 'agent-1'),
        toolResult('bash-1', 'agent-1'),
        // Agent never gets a tool_result — run ends
        // Subsequent events have parentToolUseId: null (top-level)
        runEnd(),
        runStart(),
        inputSent('what happened?'),
        textBlock('The agent was interrupted'),
        toolUse('Read', 'read-1'),
        toolResult('read-1'),
      ]

      const { topLevel, childrenByToolUseId } = extractSubagentChildren(events)

      // Agent's children: bash + result = 2
      expect(childrenByToolUseId['agent-1']).toHaveLength(2)

      // The events after run:end should be at top level, not inside the agent
      const topLevelTypes = topLevel.map(e => e.type)
      expect(topLevelTypes).toContain('input:sent')
      // The text block and read/result after the interruption should be top-level
      const topContentCount = topLevel.filter(e => e.type === 'content').length
      // agent open (1) + text (1) + read (1) = 3 content events at top level
      expect(topContentCount).toBeGreaterThanOrEqual(3)
    })

    it('does not swallow user messages sent after agent abandonment', () => {
      const events = [
        textBlock('Let me search for that'),
        agentToolUse('agent-1', 'Find the code'),
        toolUse('Grep', 'grep-1', 'agent-1'),
        toolResult('grep-1', 'agent-1'),
        turnEnd(),
        inputSent('actually, try a different approach'),
        textBlock('OK, let me try something else'),
        toolUse('Bash', 'bash-1'),
        toolResult('bash-1'),
        turnEnd(),
      ]

      const { topLevel, childrenByToolUseId } = extractSubagentChildren(events)

      // The user message and subsequent work should be at top level
      const topLevelInputs = topLevel.filter(e => e.type === 'input:sent')
      expect(topLevelInputs).toHaveLength(1)

      // The Bash after the user message should NOT be in the agent's children
      const agentChildren = childrenByToolUseId['agent-1'] || []
      const agentChildNames = agentChildren
        .filter(e => e.type === 'content')
        .flatMap(e => ((e.data as any).blocks || []).map((b: any) => b.name))
        .filter(Boolean)
      expect(agentChildNames).not.toContain('Bash')
    })
  })
})
