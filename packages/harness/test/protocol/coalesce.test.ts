/**
 * The run-scope contract, proven from live Lattice logs on 2026-08-28:
 *
 * - Fragments of one message straddling turn:end must MERGE (a background
 *   subagent kept streaming past the orchestrator's turn:end —
 *   conv-S0zUefXUqGYf seqs 6413/6414 → turn:end 6417 → 6460; turn-scoped
 *   maps split them into two messages sharing an id).
 * - A respawned run reusing a message id must NOT merge (unscoped maps made
 *   the respawn's reply vanish into the first run's message — four
 *   respawn/restart behavioral specs failed).
 */

import { describe, it, expect } from 'vitest'
import { createRunScopedCoalescer } from '../../src/protocol/coalesce.js'

interface TestMsg {
  id: string
  text: string
}

function harness() {
  const out: TestMsg[] = []
  const coalescer = createRunScopedCoalescer<TestMsg>({
    keyOf: (m) => m.id,
    merge: (existing, incoming) => {
      existing.text += incoming.text
    },
    append: (m) => out.push(m),
  })
  return { out, coalescer }
}

describe('createRunScopedCoalescer', () => {
  it('merges fragments of one message across a turn boundary', () => {
    const { out, coalescer } = harness()
    coalescer.onEvent({ type: 'run:start' }, null)
    coalescer.onEvent({ type: 'content' }, { id: 'msg_A', text: 'Export complete and ' })
    coalescer.onEvent({ type: 'turn:end' }, null)
    coalescer.onEvent({ type: 'content' }, { id: 'msg_A', text: 'verified.' })

    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('Export complete and verified.')
  })

  it('keeps distinct messages separate', () => {
    const { out, coalescer } = harness()
    coalescer.onEvent({ type: 'content' }, { id: 'msg_A', text: 'first' })
    coalescer.onEvent({ type: 'content' }, { id: 'msg_B', text: 'second' })

    expect(out.map((m) => m.text)).toEqual(['first', 'second'])
  })

  it('does not merge a respawned run reusing the previous run\'s id', () => {
    const { out, coalescer } = harness()
    coalescer.onEvent({ type: 'run:start' }, null)
    coalescer.onEvent({ type: 'content' }, { id: 'msg_A', text: 'first run' })
    coalescer.onEvent({ type: 'turn:end' }, null)
    coalescer.onEvent({ type: 'run:end' }, null)
    coalescer.onEvent({ type: 'run:start' }, null)
    coalescer.onEvent({ type: 'content' }, { id: 'msg_A', text: 'second run' })

    expect(out.map((m) => m.text)).toEqual(['first run', 'second run'])
  })

  it('mutates the emitted message in place so callers see merged content', () => {
    const { out, coalescer } = harness()
    const first = { id: 'msg_A', text: 'a' }
    coalescer.onEvent({ type: 'content' }, first)
    coalescer.onEvent({ type: 'content' }, { id: 'msg_A', text: 'b' })

    expect(out[0]).toBe(first)
    expect(first.text).toBe('ab')
  })
})
