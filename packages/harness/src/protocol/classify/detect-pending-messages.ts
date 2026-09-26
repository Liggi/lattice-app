import type { SessionEvent } from '../events.js'

/** An injected message that hasn't been consumed yet. */
export interface PendingMessage {
  /** The input:sent event. */
  inputEvent: SessionEvent
  /** The text of the injected message. */
  text: string
}

/** An injected message that was consumed by a thinking/content/turn:end event. */
export interface ConsumedMessage {
  /** The input:sent event. */
  inputEvent: SessionEvent
  /** The event that consumed this message (thinking block, or turn:end fallback). */
  consumedByEvent: SessionEvent
}

export interface PendingMessageDetection {
  /** Messages injected mid-turn that haven't been consumed yet. */
  pending: PendingMessage[]
  /** Messages injected mid-turn that have been consumed. */
  consumed: ConsumedMessage[]
}

/** Event types that indicate we're inside a turn (active work). */
const ACTIVE_TURN_TYPES = new Set(['content', 'result'])

/** Event types that reset the turn boundary (not mid-turn anymore). */
const BOUNDARY_TYPES = new Set(['turn:end', 'run:end', 'run:ready', 'run:start', 'stop:requested'])

/** Data shape for content events. */
interface ContentData {
  blocks?: Array<{ type: string; thinking?: string; text?: string }>
}

/**
 * Detects mid-turn message injections and tracks their consumption.
 *
 * A mid-turn injection is an `input:sent` event that occurs while a turn is
 * active (i.e., we've seen `content` or `result` events since the last turn
 * boundary).
 *
 * Consumption is detected by:
 * 1. A `thinking` content block (primary signal — Claude re-thinks after seeing injection)
 * 2. A `text` content block (Claude responds directly without thinking)
 * 3. A `turn:end` event (fallback — catches edge cases with no text/thinking response)
 *
 * The consuming event is the right placement point — the injected message
 * should render immediately before it in the conversation flow.
 */
export function detectPendingMessages(events: readonly SessionEvent[]): PendingMessageDetection {
  const pending: PendingMessage[] = []
  const consumed: ConsumedMessage[] = []

  // Track whether we're inside a turn (have seen content/result since last boundary)
  let insideTurn = false
  // Pending injections waiting for consumption
  let pendingInjections: PendingMessage[] = []

  for (const event of events) {
    // Check for consumption signals first (before updating turn state)
    if (pendingInjections.length > 0) {
      let isConsumption = false

      if (event.type === 'content') {
        const data = event.data as ContentData
        const hasThinking = (data.blocks ?? []).some(b => b.type === 'thinking')
        const hasText = (data.blocks ?? []).some(b => b.type === 'text')
        if (hasThinking || hasText) {
          isConsumption = true
        }
      }

      if (event.type === 'turn:end') {
        isConsumption = true
      }

      if (isConsumption) {
        for (const injection of pendingInjections) {
          consumed.push({
            inputEvent: injection.inputEvent,
            consumedByEvent: event,
          })
        }
        pendingInjections = []
      }
    }

    // Detect mid-turn input:sent
    if (event.type === 'input:sent') {
      const data = event.data as { text?: string; source?: string }
      // Internal provider controls (for example the compact action) are logged
      // for diagnostics but are not user messages and must never surface as a
      // floating or consumed mid-turn injection.
      if (data.source === 'command') continue
      if (insideTurn) {
        if (data.text) {
          pendingInjections.push({
            inputEvent: event,
            text: data.text,
          })
        }
      }
      // input:sent doesn't change turn state — we're still inside if we were
      continue
    }

    // Update turn state
    if (BOUNDARY_TYPES.has(event.type)) {
      insideTurn = false
    } else if (ACTIVE_TURN_TYPES.has(event.type)) {
      insideTurn = true
    }
  }

  // Any remaining injections that weren't consumed are still pending
  pending.push(...pendingInjections)

  return { pending, consumed }
}
