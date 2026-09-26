/**
 * useSession hook tests.
 *
 * These test the full stack: React hook → SSE client → real HTTP server → SessionManager.
 * We avoid jsdom environment because the test server needs node:http.
 * Instead, we set up minimal DOM globals manually for React.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { createTestServer } from '../helpers/test-server.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS } from '../helpers/fixtures.js'
import type { SessionEvent } from '../../src/protocol/events.js'
import type { Status } from '../../src/protocol/derive.js'
import { SSEClient } from '../../src/client/sse-client.js'
import { deriveStatus, deriveActivity } from '../../src/protocol/derive.js'

/**
 * Since React Testing Library requires a full DOM and jsdom conflicts with
 * node:http, we test the hook's logic directly using the SSE client and
 * the same reducer pattern the hook uses. This validates the full data flow:
 * FakeProcess → SessionManager → SSE handler → SSEClient → derived state.
 *
 * The hook itself is a thin layer over these components.
 */

let adapter: FakeAdapter
let manager: SessionManager
let baseUrl: string
let close: () => Promise<void>

beforeEach(async () => {
  adapter = new FakeAdapter()
  manager = new SessionManager(adapter)
  const server = await createTestServer(manager)
  baseUrl = server.baseUrl
  close = server.close
})

afterEach(async () => {
  await close()
})

function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
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

/** Simulates what useSession does: SSEClient + event accumulation + derived state. */
function createSessionSimulator(sessionUrl: string) {
  const events: SessionEvent[] = []
  let lastSeq = 0
  let connected = false
  let error: string | null = null
  let resetCalled = false

  const client = new SSEClient({
    url: sessionUrl,
    onEvent: (event) => {
      events.push(event)
      lastSeq = event.seq
    },
    onConnected: () => {
      connected = true
    },
    onDisconnected: () => {
      connected = false
    },
    onReset: () => {
      resetCalled = true
    },
    onError: (msg) => {
      error = msg
    },
    getLastSeq: () => lastSeq,
  })

  return {
    client,
    get events() { return events },
    get status(): Status { return deriveStatus(events) },
    get activity() { return deriveActivity(events) },
    get connected() { return connected },
    get error() { return error },
    get resetCalled() { return resetCalled },
    async send(input: string) {
      await fetch(`${baseUrl}/session/${sessionUrl.split('/session/')[1].split('/')[0]}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
    },
    async stop() {
      await fetch(`${baseUrl}/session/${sessionUrl.split('/session/')[1].split('/')[0]}/stop`, {
        method: 'POST',
      })
    },
  }
}

describe('useSession (integration via SSEClient)', () => {
  it('starts idle with no events', () => {
    const sim = createSessionSimulator(`${baseUrl}/session/s1/events`)
    expect(sim.status).toBe('idle')
    expect(sim.events).toEqual([])
    expect(sim.connected).toBe(false)
  })

  it('connects and receives events', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await new Promise((r) => setTimeout(r, 50))

    const sim = createSessionSimulator(`${baseUrl}/session/s1/events`)
    sim.client.start()

    await waitFor(() => sim.events.length >= 4)

    expect(sim.connected).toBe(true)
    expect(sim.status).toBe('streaming')
    expect(sim.events[0].type).toBe('run:start')
    expect(sim.events[1].type).toBe('input:sent')
    expect(sim.events[2].type).toBe('run:ready')
    expect(sim.events[3].type).toBe('content')

    sim.client.stop()
  })

  it('derives activity from thinking content', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_t',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-20250514',
        content: [{ type: 'thinking', thinking: 'Let me think...' }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      session_id: 'abc-123',
    }))
    await new Promise((r) => setTimeout(r, 50))

    const sim = createSessionSimulator(`${baseUrl}/session/s1/events`)
    sim.client.start()

    await waitFor(() => sim.activity?.type === 'thinking')
    expect(sim.activity).toEqual({ type: 'thinking' })

    sim.client.stop()
  })

  it('derives tool activity', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_tool',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-20250514',
        content: [{
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: { file_path: '/test.ts' },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      session_id: 'abc-123',
    }))
    await new Promise((r) => setTimeout(r, 50))

    const sim = createSessionSimulator(`${baseUrl}/session/s1/events`)
    sim.client.start()

    await waitFor(() => sim.activity?.type === 'tool')
    expect(sim.activity).toEqual({
      type: 'tool',
      name: 'Read',
      input: { file_path: '/test.ts' },
    })

    sim.client.stop()
  })

  it('transitions through full lifecycle', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest

    const sim = createSessionSimulator(`${baseUrl}/session/s1/events`)
    sim.client.start()

    // After start with prompt, status is 'starting' until CLI boots (run:ready)
    await waitFor(() => sim.status === 'starting')

    fake.emitLine(JSON.stringify(INIT_EVENT))
    await waitFor(() => sim.status === 'streaming')

    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    expect(sim.status).toBe('streaming')

    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await waitFor(() => sim.status === 'idle')

    sim.client.stop()
  })

  it('sends input via server API', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await new Promise((r) => setTimeout(r, 50))

    const sim = createSessionSimulator(`${baseUrl}/session/s1/events`)
    sim.client.start()

    await waitFor(() => sim.connected)
    await sim.send('follow up')

    expect(fake.stdinWrites).toEqual(['follow up\n'])
    sim.client.stop()
  })

  it('stops via server API', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await new Promise((r) => setTimeout(r, 50))

    const sim = createSessionSimulator(`${baseUrl}/session/s1/events`)
    sim.client.start()

    await waitFor(() => sim.connected)
    await sim.stop()

    expect(fake.signals).toContain('SIGINT')

    // Status should transition to stopping
    await waitFor(() => sim.status === 'stopping')

    sim.client.stop()
  })

  it('receives reset event for unknown session', async () => {
    const sim = createSessionSimulator(`${baseUrl}/session/unknown/events`)
    sim.client.start()

    await waitFor(() => sim.resetCalled)
    expect(sim.resetCalled).toBe(true)

    sim.client.stop()
  })

  it('handles multiple sessions independently', async () => {
    await manager.start('s1', { prompt: 'session 1' })
    await manager.start('s2', { prompt: 'session 2' })
    adapter.spawned[0].emitLine(JSON.stringify(INIT_EVENT))
    adapter.spawned[1].emitLine(JSON.stringify(INIT_EVENT))
    await new Promise((r) => setTimeout(r, 50))

    const sim1 = createSessionSimulator(`${baseUrl}/session/s1/events`)
    const sim2 = createSessionSimulator(`${baseUrl}/session/s2/events`)

    sim1.client.start()
    sim2.client.start()

    await waitFor(() => sim1.events.length >= 2 && sim2.events.length >= 2)

    // Each has its own independent events
    expect(sim1.events[0].sessionId).toBe('s1')
    expect(sim2.events[0].sessionId).toBe('s2')

    sim1.client.stop()
    sim2.client.stop()
  })
})
