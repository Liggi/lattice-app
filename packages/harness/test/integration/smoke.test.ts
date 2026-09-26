/**
 * End-to-end integration smoke test.
 *
 * Exercises the full chain with NO mocking:
 *   Real child process (mock CLI) → SessionManager → EventLog → SSE handler → SSE client
 *
 * This is the confidence check that all layers compose correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { RealAdapter } from '../helpers/real-adapter.js'
import { createTestServer } from '../helpers/test-server.js'
import { SSEClient } from '../../src/client/sse-client.js'
import { deriveStatus, deriveActivity } from '../../src/protocol/derive.js'
import type { SessionEvent } from '../../src/protocol/events.js'

let manager: SessionManager
let baseUrl: string
let close: () => Promise<void>

beforeEach(async () => {
  const adapter = new RealAdapter()
  manager = new SessionManager(adapter)
  const server = await createTestServer(manager)
  baseUrl = server.baseUrl
  close = server.close
})

afterEach(async () => {
  await close()
})

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs)
    const interval = setInterval(() => {
      if (check()) {
        clearTimeout(timeout)
        clearInterval(interval)
        resolve()
      }
    }, 20)
  })
}

describe('End-to-end integration', () => {
  it('full session lifecycle: spawn → stream → idle', async () => {
    const runId = await manager.start('s1', { prompt: 'test prompt' })
    expect(runId).toBeTruthy()

    // Wait for events to flow through
    await waitFor(() => manager.getStatus('s1') === 'idle')

    // Verify event sequence
    const events = manager.getLog('s1')!.all()
    const types = events.map((e) => e.type)

    expect(types[0]).toBe('run:start')
    expect(types[1]).toBe('input:sent')
    expect(types[2]).toBe('run:ready')

    // Should have content events (thinking, tool_use text, tool_result, text)
    expect(types).toContain('content')
    expect(types).toContain('result')
    expect(types).toContain('turn:end')

    // Status should be idle after result
    expect(deriveStatus(events)).toBe('idle')
  })

  it('status transitions: starting → streaming → idle', async () => {
    const statuses: string[] = []

    // Poll status during the run
    await manager.start('s1', { prompt: 'test' })
    statuses.push(manager.getStatus('s1'))

    await waitFor(() => manager.getStatus('s1') === 'streaming', 3000)
    statuses.push(manager.getStatus('s1'))

    await waitFor(() => manager.getStatus('s1') === 'idle', 3000)
    statuses.push(manager.getStatus('s1'))

    expect(statuses).toContain('streaming')
    expect(statuses[statuses.length - 1]).toBe('idle')
  })

  it('activity derivation: thinking → tool → null', async () => {
    const activities: (string | null)[] = []

    await manager.start('s1', { prompt: 'test' })

    // Poll activity during the run
    const interval = setInterval(() => {
      const events = manager.getLog('s1')?.all() ?? []
      const activity = deriveActivity(events)
      const key = activity ? activity.type : null
      if (activities.length === 0 || activities[activities.length - 1] !== key) {
        activities.push(key)
      }
    }, 10)

    await waitFor(() => manager.getStatus('s1') === 'idle', 5000)

    // One final poll after idle to capture the null transition
    const finalEvents = manager.getLog('s1')!.all()
    const finalActivity = deriveActivity(finalEvents)
    const finalKey = finalActivity ? finalActivity.type : null
    if (activities[activities.length - 1] !== finalKey) {
      activities.push(finalKey)
    }
    clearInterval(interval)

    // Should have seen at least some activity transitions
    expect(activities).toContain('thinking')
    // Eventually null (idle)
    expect(activities[activities.length - 1]).toBeNull()
  })

  it('SSE client receives all events end-to-end', async () => {
    await manager.start('s1', { prompt: 'test' })

    const events: SessionEvent[] = []
    let lastSeq = 0

    const client = new SSEClient({
      url: `${baseUrl}/session/s1/events`,
      onEvent: (e) => {
        events.push(e)
        lastSeq = e.seq
      },
      onConnected: () => {},
      onDisconnected: () => {},
      onReset: () => {},
      onError: () => {},
      getLastSeq: () => lastSeq,
    })

    client.start()

    // Wait for the session to complete
    await waitFor(() => {
      const status = deriveStatus(events)
      return status === 'idle' && events.some((e) => e.type === 'turn:end')
    }, 5000)

    client.stop()

    // Verify SSE client received the same events as the server log
    const serverEvents = manager.getLog('s1')!.all()
    expect(events.length).toBe(serverEvents.length)

    // Sequences should match
    for (let i = 0; i < events.length; i++) {
      expect(events[i].seq).toBe(serverEvents[i].seq)
      expect(events[i].type).toBe(serverEvents[i].type)
    }
  })

  it('send follow-up triggers new content', async () => {
    await manager.start('s1', { prompt: 'initial' })

    // Wait for first turn to complete
    await waitFor(() => manager.getStatus('s1') === 'idle')

    // Send follow-up (process should still be alive, waiting on stdin)
    const log = manager.getLog('s1')!
    const eventCountBefore = log.length

    await manager.send('s1', 'follow up question')

    // Wait for new events from the follow-up
    await waitFor(() => log.length > eventCountBefore + 1, 3000)

    // Should have input:sent + new content events
    const newEvents = log.all().slice(eventCountBefore)
    const types = newEvents.map((e) => e.type)
    expect(types).toContain('input:sent')
    expect(types).toContain('content')
  })

  it('stop kills the process', async () => {
    await manager.start('s1', { prompt: 'test' })
    await waitFor(() => manager.getStatus('s1') === 'streaming')

    await manager.stop('s1')
    expect(manager.getStatus('s1')).toBe('stopping')

    // Process should eventually exit
    await waitFor(() => manager.getStatus('s1') === 'idle', 10000)

    const events = manager.getLog('s1')!.all()
    expect(events.some((e) => e.type === 'stop:requested')).toBe(true)
    expect(events.some((e) => e.type === 'run:end')).toBe(true)
  })

  it('event sequence numbers are monotonic', async () => {
    await manager.start('s1', { prompt: 'test' })
    await waitFor(() => manager.getStatus('s1') === 'idle')

    const events = manager.getLog('s1')!.all()
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq)
    }
  })

  it('resumeId is captured from init event', async () => {
    await manager.start('s1', { prompt: 'test' })
    await waitFor(() => manager.getLog('s1')!.all().some((e) => e.type === 'run:ready'))

    const events = manager.getLog('s1')!.all()
    const readyEvent = events.find((e) => e.type === 'run:ready')!
    const data = readyEvent.data as { resumeId: string }
    expect(data.resumeId).toMatch(/^mock-session-/)
  })
})
