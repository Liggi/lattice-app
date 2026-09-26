import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { deriveStatus, deriveActivity } from '../../src/protocol/derive.js'
import type { SessionEvent, EventType } from '../../src/protocol/events.js'
import { EVENT_TYPES } from '../../src/protocol/events.js'

function arbitraryEvent(): fc.Arbitrary<SessionEvent> {
  return fc.record({
    sessionId: fc.constant('s1'),
    runId: fc.constant('r1'),
    seq: fc.nat(),
    timestamp: fc.nat(),
    type: fc.constantFrom(...EVENT_TYPES),
    data: fc.constant({}),
  })
}

function eventOfType(type: EventType, data: unknown = {}): SessionEvent {
  return {
    sessionId: 's1',
    runId: 'r1',
    seq: 0,
    timestamp: 0,
    type,
    data,
  }
}

describe('deriveStatus — property-based', () => {
  it('always returns one of four valid statuses', () => {
    fc.assert(
      fc.property(fc.array(arbitraryEvent()), (events) => {
        const status = deriveStatus(events)
        expect(['idle', 'starting', 'streaming', 'stopping']).toContain(status)
      }),
    )
  })

  it('stop:requested as last event always produces stopping', () => {
    fc.assert(
      fc.property(fc.array(arbitraryEvent()), (before) => {
        const events = [...before, eventOfType('stop:requested')]
        expect(deriveStatus(events)).toBe('stopping')
      }),
    )
  })

  it('run:end as last event always produces idle', () => {
    fc.assert(
      fc.property(fc.array(arbitraryEvent()), (before) => {
        const events = [...before, eventOfType('run:end', { code: 0, reason: 'completed' })]
        expect(deriveStatus(events)).toBe('idle')
      }),
    )
  })

  it('run:error as last event always produces idle', () => {
    fc.assert(
      fc.property(fc.array(arbitraryEvent()), (before) => {
        const events = [...before, eventOfType('run:error', { message: 'failed' })]
        expect(deriveStatus(events)).toBe('idle')
      }),
    )
  })

  it('turn:end as last event always produces idle', () => {
    fc.assert(
      fc.property(fc.array(arbitraryEvent()), (before) => {
        const events = [...before, eventOfType('turn:end')]
        expect(deriveStatus(events)).toBe('idle')
      }),
    )
  })

  it('run:start as last event always produces starting', () => {
    fc.assert(
      fc.property(fc.array(arbitraryEvent()), (before) => {
        const events = [...before, eventOfType('run:start')]
        expect(deriveStatus(events)).toBe('starting')
      }),
    )
  })

  it('run:ready as last event produces streaming or idle (depends on whether input:sent preceded it)', () => {
    fc.assert(
      fc.property(fc.array(arbitraryEvent()), (before) => {
        const events = [...before, eventOfType('run:ready')]
        const status = deriveStatus(events)
        expect(['streaming', 'idle']).toContain(status)
      }),
    )
  })

  it('content as last event always produces streaming', () => {
    fc.assert(
      fc.property(fc.array(arbitraryEvent()), (before) => {
        const events = [...before, eventOfType('content', { blocks: [] })]
        expect(deriveStatus(events)).toBe('streaming')
      }),
    )
  })

  it('input:sent as last event produces streaming or starting (depends on whether run:ready preceded it)', () => {
    fc.assert(
      fc.property(fc.array(arbitraryEvent()), (before) => {
        const events = [...before, eventOfType('input:sent', { text: 'hi' })]
        const status = deriveStatus(events)
        expect(['streaming', 'starting']).toContain(status)
      }),
    )
  })
})

describe('deriveActivity — property-based', () => {
  it('always returns a valid activity shape or null', () => {
    fc.assert(
      fc.property(fc.array(arbitraryEvent()), (events) => {
        const activity = deriveActivity(events)
        if (activity === null) return true
        if (activity.type === 'thinking') return true
        if (activity.type === 'tool' && typeof activity.name === 'string') return true
        return false
      }),
    )
  })

  it('returns null when status is not streaming', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryEvent()).filter(
          (events) => deriveStatus(events) !== 'streaming',
        ),
        (events) => {
          expect(deriveActivity(events)).toBeNull()
        },
      ),
    )
  })
})
