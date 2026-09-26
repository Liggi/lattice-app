import type { SessionEvent, EventType } from '../../src/protocol/events.js'

let seqCounter = 0

export function resetSeq() {
  seqCounter = 0
}

export function makeEvent(
  type: EventType,
  data: unknown = {},
  overrides: Partial<SessionEvent> = {},
): SessionEvent {
  return {
    sessionId: 's1',
    runId: 'r1',
    seq: ++seqCounter,
    timestamp: Date.now(),
    type,
    data,
    ...overrides,
  }
}

export function makeContentEvent(blocks: unknown[]) {
  return makeEvent('content', { blocks })
}
