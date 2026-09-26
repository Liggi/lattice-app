import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS, SYSTEM_NON_INIT, THINKING_TOKENS } from '../helpers/fixtures.js'

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

describe('SessionManager — spawn failure', () => {
  it('appends run:start then run:error on spawn failure', async () => {
    adapter.spawnError = new Error('spawn ENOENT: claude')

    await expect(manager.start('s1', { prompt: 'hello' })).rejects.toThrow('spawn ENOENT: claude')

    const events = manager.getLog('s1')!.all()
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('run:start')
    expect(events[1].type).toBe('run:error')
    expect((events[1].data as { message: string }).message).toBe('spawn ENOENT: claude')
    expect((events[1].data as { code: string }).code).toBe('SPAWN_FAILED')
  })

  it('status returns to idle after spawn failure', async () => {
    adapter.spawnError = new Error('spawn ENOENT: claude')
    await manager.start('s1', { prompt: 'hello' }).catch(() => {})
    expect(manager.getStatus('s1')).toBe('idle')
  })

  it('allows retry after spawn failure', async () => {
    adapter.spawnError = new Error('spawn ENOENT: claude')
    await manager.start('s1', { prompt: 'hello' }).catch(() => {})

    adapter.spawnError = null
    const runId = await manager.start('s1', { prompt: 'retry' })
    expect(runId).toBeTruthy()
    expect(manager.getStatus('s1')).toBe('starting')
  })
})

describe('SessionManager — process crash', () => {
  it('records run:end with reason process_exit on non-zero exit', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    fake.exit(137, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()
    const endEvent = events.find((e) => e.type === 'run:end')!
    expect(endEvent.data).toEqual({ code: 137, signal: 'SIGKILL', reason: 'process_exit' })
  })

  it('status returns to idle after crash', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    fake.exit(1)
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.getStatus('s1')).toBe('idle')
  })
})

describe('SessionManager — onEvent callback', () => {
  it('fires on every event', async () => {
    const received: string[] = []
    manager = new SessionManager(adapter, {
      onEvent: (event) => received.push(event.type),
    })

    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    expect(received).toEqual(['run:start', 'input:sent', 'run:ready', 'content', 'turn:end'])
  })

  it('fires for run:end on process exit', async () => {
    const received: string[] = []
    manager = new SessionManager(adapter, {
      onEvent: (event) => received.push(event.type),
    })

    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(received).toContain('run:end')
  })
})

describe('SessionManager — inspect', () => {
  it('returns null for unknown session', () => {
    expect(manager.inspect('nonexistent')).toBeNull()
  })

  it('returns diagnostic snapshot for active session', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    const diag = manager.inspect('s1')!
    expect(diag.status).toBe('streaming')
    expect(diag.processAlive).toBe(true)
    expect(diag.eventCount).toBe(4) // run:start, input:sent, run:ready, content
    expect(diag.lastEventType).toBe('content')
    expect(diag.runId).toBeTruthy()
    expect(diag.resumeId).toBe('abc-123')
    expect(diag.subscriberCount).toBe(0)
    expect(diag.lastEventAt).toBeTypeOf('number')
  })

  it('shows idle status after process exit', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    const diag = manager.inspect('s1')!
    expect(diag.status).toBe('idle')
    expect(diag.processAlive).toBe(false)
  })
})

describe('SessionManager — destroy', () => {
  it('removes session from the map', async () => {
    await manager.start('s1', { prompt: 'hello' })
    expect(manager.hasSession('s1')).toBe(true)

    manager.destroy('s1')
    expect(manager.hasSession('s1')).toBe(false)
    expect(manager.getLog('s1')).toBeNull()
    expect(manager.getStatus('s1')).toBe('idle')
  })

  it('force-kills active process on destroy', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    manager.destroy('s1')
    expect(fake.signals).toContain('SIGKILL')
  })

  it('is a no-op for unknown session', () => {
    manager.destroy('nonexistent') // should not throw
  })

  it('is safe when process already exited', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    manager.destroy('s1') // should not throw
    expect(manager.hasSession('s1')).toBe(false)
  })
})

describe('SessionManager — logger integration', () => {
  it('logs key events through provided logger', async () => {
    const logs: { level: string; msg: string }[] = []
    const logger = {
      debug: (msg: string) => logs.push({ level: 'debug', msg }),
      info: (msg: string) => logs.push({ level: 'info', msg }),
      warn: (msg: string) => logs.push({ level: 'warn', msg }),
      error: (msg: string) => logs.push({ level: 'error', msg }),
    }
    manager = new SessionManager(adapter, { logger })

    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    const infoMsgs = logs.filter((l) => l.level === 'info').map((l) => l.msg)
    expect(infoMsgs).toContain('Starting session')
    expect(infoMsgs).toContain('Process spawned')
  })

  it('does not warn on thinking_tokens, but still warns on unknown events', async () => {
    const logs: { level: string; msg: string }[] = []
    const logger = {
      debug: (msg: string) => logs.push({ level: 'debug', msg }),
      info: (msg: string) => logs.push({ level: 'info', msg }),
      warn: (msg: string) => logs.push({ level: 'warn', msg }),
      error: (msg: string) => logs.push({ level: 'error', msg }),
    }
    manager = new SessionManager(adapter, { logger })

    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(THINKING_TOKENS))
    fake.emitLine(JSON.stringify(THINKING_TOKENS))
    await vi.advanceTimersByTimeAsync(0)

    expect(logs.filter((l) => l.msg === 'Normalizer skipped event')).toHaveLength(0)
    expect(logs.filter((l) => l.msg === 'Normalizer ignored known event')).toHaveLength(2)

    fake.emitLine(JSON.stringify(SYSTEM_NON_INIT))
    await vi.advanceTimersByTimeAsync(0)

    expect(logs.filter((l) => l.msg === 'Normalizer skipped event')).toHaveLength(1)
  })
})
