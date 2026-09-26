import { describe, it, expect, beforeEach } from 'vitest'
import { detectPendingMessages } from '../../src/protocol/classify/detect-pending-messages.js'
import type { SessionEvent } from '../../src/protocol/events.js'

// ---- Helpers ----

let seq = 0

function reset() {
  seq = 0
}

function ev(type: SessionEvent['type'], data: unknown = {}, meta?: SessionEvent['meta']): SessionEvent {
  return { sessionId: 's1', runId: 'r1', seq: ++seq, timestamp: Date.now() + seq * 1000, type, data, meta }
}

function inputSent(text: string): SessionEvent {
  return ev('input:sent', { text })
}

function thinkingContent(text = 'Let me think about this...'): SessionEvent {
  return ev('content', { blocks: [{ type: 'thinking', thinking: text }] }, { rawType: 'assistant' })
}

function textContent(text = 'Here is my response.'): SessionEvent {
  return ev('content', { blocks: [{ type: 'text', text }] }, { rawType: 'assistant' })
}

function toolUse(name: string, id: string): SessionEvent {
  return ev('content', { blocks: [{ type: 'tool_use', id, name, input: {} }] }, { rawType: 'assistant' })
}

function toolResult(toolUseId: string): SessionEvent {
  return ev('result', { blocks: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }, { rawType: 'user' })
}

function turnEnd(): SessionEvent {
  return ev('turn:end', { usage: { input_tokens: 100, output_tokens: 50 }, duration: 5000 })
}

function runEnd(): SessionEvent {
  return ev('run:end', { code: 0, reason: 'completed' })
}

function runStart(): SessionEvent {
  return ev('run:start', { config: {} })
}

function runReady(): SessionEvent {
  return ev('run:ready', { resumeId: 'r1', model: 'claude-opus-4-20250514' })
}

// ---- Tests ----

describe('detectPendingMessages', () => {
  beforeEach(reset)

  describe('idle send (not mid-turn)', () => {
    it('does not flag input:sent at the start of a conversation', () => {
      const events = [
        inputSent('hello'),
        thinkingContent(),
        textContent('Hi there!'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(0)
    })

    it('does not flag input:sent after turn:end (normal follow-up)', () => {
      const events = [
        inputSent('first message'),
        thinkingContent(),
        textContent('Response 1'),
        turnEnd(),
        inputSent('second message'),
        thinkingContent(),
        textContent('Response 2'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(0)
    })

    it('does not flag input:sent after run:end', () => {
      const events = [
        inputSent('first message'),
        thinkingContent(),
        turnEnd(),
        runEnd(),
        runStart(),
        inputSent('new session message'),
        runReady(),
        thinkingContent(),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(0)
    })
  })

  describe('mid-turn injection → immediate thinking', () => {
    it('detects injection followed immediately by thinking block', () => {
      const events = [
        inputSent('search for API routes'),
        thinkingContent('Planning search...'),
        toolUse('Grep', 'grep-1'),
        toolResult('grep-1'),
        // Mid-turn injection:
        inputSent('actually, try the other approach'),
        // Consumption: immediate thinking
        thinkingContent('The user wants a different approach...'),
        textContent('OK, switching to a different approach.'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0) // consumed, so not pending
      expect(consumed).toHaveLength(1)
      expect(consumed[0].inputEvent.seq).toBe(5) // the input:sent
      expect(consumed[0].consumedByEvent.seq).toBe(6) // the thinking block
    })
  })

  describe('mid-turn injection → queued then thinking', () => {
    it('detects injection with in-flight tool calls before consumption', () => {
      const events = [
        inputSent('search for API routes'),
        thinkingContent('Planning search...'),
        toolUse('Grep', 'grep-1'),
        toolUse('Read', 'read-1'),
        // Mid-turn injection while tools are in flight:
        inputSent('actually, try the other approach'),
        // In-flight tool results continue:
        toolResult('grep-1'),
        toolResult('read-1'),
        // Consumption: thinking after tool results
        thinkingContent('The user wants a different approach...'),
        textContent('Switching approaches.'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(1)
      expect(consumed[0].inputEvent.seq).toBe(5) // input:sent
      expect(consumed[0].consumedByEvent.seq).toBe(8) // thinking block
    })

    it('handles long chains of in-flight events before consumption', () => {
      const events = [
        inputSent('search'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        toolUse('Read', 'r1'),
        toolUse('Glob', 'gl1'),
        // Mid-turn injection:
        inputSent('stop, different approach'),
        // Many in-flight results:
        toolResult('g1'),
        toolResult('r1'),
        toolResult('gl1'),
        // More tool calls from the already-in-flight response:
        toolUse('Read', 'r2'),
        toolResult('r2'),
        // Finally, consumption:
        thinkingContent('User wants different approach...'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(1)
      expect(consumed[0].inputEvent.seq).toBe(6) // input:sent
      expect(consumed[0].consumedByEvent.seq).toBe(12) // thinking block
    })
  })

  describe('mid-turn injection → text content consumption', () => {
    it('consumes on text content when no thinking block appears', () => {
      const events = [
        inputSent('search for files'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        toolResult('g1'),
        // Mid-turn injection:
        inputSent('also check the tests'),
        // Model responds via text without thinking:
        textContent('Good question — let me check the tests too.'),
        toolUse('Grep', 'g2'),
        toolResult('g2'),
        textContent('Found the test files.'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(1)
      expect(consumed[0].inputEvent.seq).toBe(5)
      // Consumed by the first text content block, not turn:end
      expect(consumed[0].consumedByEvent.seq).toBe(6)
    })

    it('consumes on text content after in-flight tool results', () => {
      const events = [
        inputSent('search for files'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        toolUse('Read', 'r1'),
        // Mid-turn injection while tools are in flight:
        inputSent('try a different approach'),
        // In-flight tool results continue (not consumption):
        toolResult('g1'),
        toolResult('r1'),
        // Claude responds with text only — no thinking:
        textContent('OK, switching approaches.'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(1)
      expect(consumed[0].inputEvent.seq).toBe(5) // input:sent
      expect(consumed[0].consumedByEvent.seq).toBe(8) // text content, not turn:end (seq 9)
    })
  })

  describe('mid-turn injection → turn:end fallback', () => {
    it('uses turn:end as fallback when response has only tool calls (no text or thinking)', () => {
      const events = [
        inputSent('search for files'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        toolResult('g1'),
        // Mid-turn injection:
        inputSent('also check the tests'),
        // Claude responds with only tool calls — no text or thinking:
        toolUse('Grep', 'g2'),
        toolResult('g2'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(1)
      expect(consumed[0].inputEvent.seq).toBe(5)
      // No text or thinking → fall back to turn:end
      expect(consumed[0].consumedByEvent.seq).toBe(8)
    })
  })

  describe('mid-turn injection → run boundary', () => {
    it('persists across run:end/run:start boundaries', () => {
      const events = [
        inputSent('search for files'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        // Mid-turn injection:
        inputSent('never mind, different task'),
        // Run ends (current turn wrapping up):
        runEnd(),
        runStart(),
        inputSent('never mind, different task'), // re-sent on new run
        runReady(),
        thinkingContent('Starting the different task...'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      // The original mid-turn injection should be consumed
      expect(consumed).toHaveLength(1)
      expect(consumed[0].inputEvent.seq).toBe(4) // original mid-turn input:sent
      expect(consumed[0].consumedByEvent.seq).toBe(9) // thinking in new run
    })
  })

  describe('multiple injections', () => {
    it('handles two rapid injections consumed by one thinking', () => {
      const events = [
        inputSent('search for files'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        // Two rapid mid-turn injections:
        inputSent('also check config'),
        inputSent('and the README'),
        // Tool result from in-flight:
        toolResult('g1'),
        // Single thinking consumes both:
        thinkingContent('User wants config and README too...'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(2)
      // Both consumed by the same thinking block
      expect(consumed[0].consumedByEvent.seq).toBe(7)
      expect(consumed[1].consumedByEvent.seq).toBe(7)
    })

    it('handles injections in separate turns', () => {
      const events = [
        // Turn 1
        inputSent('search for files'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        inputSent('try the other approach'), // mid-turn injection
        toolResult('g1'),
        thinkingContent('Switching approach...'), // consumption
        turnEnd(),
        // Turn 2
        inputSent('now check the tests'),
        thinkingContent(),
        toolUse('Read', 'r1'),
        inputSent('also the integration tests'), // mid-turn injection
        toolResult('r1'),
        thinkingContent('Checking integration tests...'), // consumption
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(2)
      expect(consumed[0].inputEvent.seq).toBe(4)
      expect(consumed[0].consumedByEvent.seq).toBe(6)
      expect(consumed[1].inputEvent.seq).toBe(11)
      expect(consumed[1].consumedByEvent.seq).toBe(13)
    })
  })

  describe('pending state (no consumption yet)', () => {
    it('returns pending when stream is still active after injection', () => {
      const events = [
        inputSent('search for files'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        // Mid-turn injection:
        inputSent('try the other approach'),
        // Stream continues but no thinking yet:
        toolResult('g1'),
        toolUse('Read', 'r1'),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(consumed).toHaveLength(0)
      expect(pending).toHaveLength(1)
      expect(pending[0].inputEvent.seq).toBe(4)
      expect(pending[0].text).toBe('try the other approach')
    })

    it('returns multiple pending when multiple injections with no consumption', () => {
      const events = [
        inputSent('search'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        inputSent('first injection'),
        inputSent('second injection'),
        toolResult('g1'),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(consumed).toHaveLength(0)
      expect(pending).toHaveLength(2)
      expect(pending[0].text).toBe('first injection')
      expect(pending[1].text).toBe('second injection')
    })
  })

  describe('edge cases', () => {
    it('handles empty event stream', () => {
      const { pending, consumed } = detectPendingMessages([])

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(0)
    })

    it('handles stream with only input:sent', () => {
      const events = [inputSent('hello')]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(0)
    })

    it('does not flag input:sent after stop:requested', () => {
      const events = [
        inputSent('search'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        ev('stop:requested', {}),
        inputSent('new message after stop'),
        thinkingContent(),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(0)
    })

    it('second input:sent after first input:sent counts as mid-turn', () => {
      // First input:sent is normal (start of conversation)
      // If a second input:sent comes while first is being processed,
      // the previous event is input:sent — that's not content/result,
      // BUT it should still be detected as mid-turn if we're inside
      // a turn (i.e., there's been content/result since last turn boundary)
      const events = [
        inputSent('search'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        inputSent('injection 1'),
        inputSent('injection 2'), // prev is input:sent, but we're mid-turn
        toolResult('g1'),
        thinkingContent('Handling both injections...'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(consumed).toHaveLength(2)
    })

    it('never treats command-source input as a user injection', () => {
      const events = [
        inputSent('search'),
        thinkingContent(),
        toolUse('Grep', 'g1'),
        ev('input:sent', { text: '/compact', source: 'command' }),
        thinkingContent('Compacting...'),
        turnEnd(),
      ]

      const { pending, consumed } = detectPendingMessages(events)

      expect(pending).toHaveLength(0)
      expect(consumed).toHaveLength(0)
    })
  })
})
