import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS } from '../helpers/fixtures.js'

let adapter: FakeAdapter
let manager: SessionManager

beforeEach(() => {
  vi.useFakeTimers()
  adapter = new FakeAdapter()
  manager = new SessionManager(adapter)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionManager — start emits input:sent for prompt', () => {
  it('appends input:sent with the prompt text', async () => {
    await manager.start('s1', { prompt: 'hello world' })

    const events = manager.getLog('s1')!.all()
    const inputEvent = events.find((e) => e.type === 'input:sent')!
    expect(inputEvent).toBeDefined()
    expect(inputEvent.data).toEqual({ text: 'hello world' })
  })

  it('does not emit input:sent when prompt is empty', async () => {
    await manager.start('s1', { prompt: '' })

    const events = manager.getLog('s1')!.all()
    const inputEvents = events.filter((e) => e.type === 'input:sent')
    expect(inputEvents).toHaveLength(0)
  })
})

describe('SessionManager — send', () => {
  it('writes to stdin when streaming', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('streaming')

    await manager.send('s1', 'follow up')
    expect(fake.stdinWrites).toEqual(['follow up\n'])
  })

  it('appends input:sent event', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.send('s1', 'follow up')

    const events = manager.getLog('s1')!.all()
    const inputEvents = events.filter((e) => e.type === 'input:sent')
    // First input:sent is from start(), second is from send()
    expect(inputEvents).toHaveLength(2)
    expect(inputEvents[1].data).toEqual({ text: 'follow up' })
  })

  it('status remains streaming after input:sent', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.send('s1', 'follow up')
    expect(manager.getStatus('s1')).toBe('streaming')
  })

  it('throws when sending to unknown session', async () => {
    await expect(manager.send('nonexistent', 'hello')).rejects.toThrow('Unknown session')
  })

  it('throws when sending while starting', async () => {
    await manager.start('s1', { prompt: '' })
    // Status is 'starting' before init event arrives (no prompt → no input:sent)
    expect(manager.getStatus('s1')).toBe('starting')
    await expect(manager.send('s1', 'too early')).rejects.toThrow('Cannot send while starting')
  })

  it('throws when sending while stopping', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.stop('s1')
    expect(manager.getStatus('s1')).toBe('stopping')
    await expect(manager.send('s1', 'too late')).rejects.toThrow('Cannot send while stopping')
  })
})

describe('SessionManager — send spawns new run when process is dead', () => {
  it('spawns a new run with the input as prompt', async () => {
    // First run
    await manager.start('s1', { prompt: 'hello' })
    const fake1 = adapter.latest
    fake1.emitLine(JSON.stringify(INIT_EVENT))
    fake1.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake1.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake1.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('idle')
    expect(adapter.spawned).toHaveLength(1)

    // Send follow-up — should spawn new run (start() emits input:sent for the prompt)
    await manager.send('s1', 'follow up question')
    expect(adapter.spawned).toHaveLength(2)
    expect(manager.getStatus('s1')).toBe('starting')
  })

  it('passes resumeId in the new spawn config', async () => {
    const configs: unknown[] = []
    adapter.onSpawn = (config) => configs.push(config)

    await manager.start('s1', { prompt: 'hello', cwd: '/test' })
    const fake1 = adapter.latest
    fake1.emitLine(JSON.stringify(INIT_EVENT)) // has session_id: 'abc-123'
    fake1.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake1.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    await manager.send('s1', 'follow up')

    const lastConfig = configs[configs.length - 1] as Record<string, unknown>
    expect(lastConfig.prompt).toBe('follow up')
    expect(lastConfig.resume).toBe('abc-123')
    expect(lastConfig.cwd).toBe('/test')
  })
})

describe('SessionManager — onFollowUpSpawn callback', () => {
  it('fires when send() spawns a new process for a dead session', async () => {
    const calls: { sessionId: string; runId: string; processId?: string }[] = []
    const adapter = new FakeAdapter()
    const manager = new SessionManager(adapter, {
      onFollowUpSpawn: (info) => calls.push(info),
    })

    const { runId: initialRunId } = await manager.start('s1', { prompt: 'hello' })
    const fake1 = adapter.latest
    fake1.emitLine(JSON.stringify(INIT_EVENT))
    fake1.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake1.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(calls).toHaveLength(0) // not fired for initial spawn

    await manager.send('s1', 'follow up')

    expect(calls).toHaveLength(1)
    expect(calls[0].sessionId).toBe('s1')
    expect(calls[0].runId).not.toBe(initialRunId)
  })

  it('does not fire for stdin-write follow-ups against an alive process', async () => {
    const calls: { sessionId: string; runId: string; processId?: string }[] = []
    const adapter = new FakeAdapter()
    const manager = new SessionManager(adapter, {
      onFollowUpSpawn: (info) => calls.push(info),
    })

    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.send('s1', 'follow up')

    expect(calls).toHaveLength(0)
    expect(adapter.spawned).toHaveLength(1)
  })

  it('does not fire for the initial start() call', async () => {
    const calls: { sessionId: string; runId: string; processId?: string }[] = []
    const adapter = new FakeAdapter()
    const manager = new SessionManager(adapter, {
      onFollowUpSpawn: (info) => calls.push(info),
    })

    await manager.start('s1', { prompt: 'hello' })
    expect(calls).toHaveLength(0)
  })
})

describe('SessionManager — multi-run lifecycle', () => {
  it('accumulates events across multiple runs', async () => {
    // Run 1
    const { runId: runId1 } = await manager.start('s1', { prompt: 'first' })
    const fake1 = adapter.latest
    fake1.emitLine(JSON.stringify(INIT_EVENT))
    fake1.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake1.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake1.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    // Run 2
    const { runId: runId2 } = await manager.start('s1', { prompt: 'second' })
    const fake2 = adapter.latest
    fake2.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    expect(runId1).not.toBe(runId2)

    const events = manager.getLog('s1')!.all()
    // Run 1: run:start, input:sent, run:ready, content, turn:end, run:end
    // Run 2: run:start, input:sent, run:ready
    expect(events).toHaveLength(9)

    // Verify both runIds are present
    const runIds = [...new Set(events.map((e) => e.runId))]
    expect(runIds).toHaveLength(2)
    expect(runIds).toContain(runId1)
    expect(runIds).toContain(runId2)
  })

  it('allows starting a new run after the previous one ended', async () => {
    await manager.start('s1', { prompt: 'first' })
    const fake1 = adapter.latest
    fake1.emitLine(JSON.stringify(INIT_EVENT))
    fake1.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake1.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    // Should not throw
    await manager.start('s1', { prompt: 'second' })
    expect(manager.getStatus('s1')).toBe('starting')
  })

  it('correctly derives status in the second run', async () => {
    // Run 1 - complete
    await manager.start('s1', { prompt: 'first' })
    const fake1 = adapter.latest
    fake1.emitLine(JSON.stringify(INIT_EVENT))
    fake1.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake1.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('idle')

    // Run 2 - starting until CLI boots (run:ready arrives)
    await manager.start('s1', { prompt: 'second' })
    expect(manager.getStatus('s1')).toBe('starting')

    const fake2 = adapter.latest
    fake2.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('streaming')

    fake2.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('streaming')
  })
})
