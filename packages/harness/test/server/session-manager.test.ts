import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS, TASK_STARTED } from '../helpers/fixtures.js'
import { hasRunningBackgroundTasks } from '../../src/protocol/derive.js'
import type { SpawnConfig } from '../../src/server/process-adapter.js'

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

describe('SessionManager — start', () => {
  it('spawns a process and returns a runId', async () => {
    const runId = await manager.start('s1', { prompt: 'hello' })
    expect(runId).toBeTruthy()
    expect(adapter.spawned).toHaveLength(1)
  })

  it('appends run:start event on start', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const log = manager.getLog('s1')!
    const events = log.all()
    expect(events[0].type).toBe('run:start')
    expect(events[0].data).toEqual({ config: { prompt: 'hello' } })
  })

  it('status is starting immediately after start (CLI has not booted yet)', async () => {
    await manager.start('s1', { prompt: 'hello' })
    expect(manager.getStatus('s1')).toBe('starting')
  })

  it('status transitions to streaming after run:ready', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    // Let the async piping process
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('streaming')
  })

  it('status transitions to streaming after content', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('streaming')
  })

  it('status transitions to idle after turn:end (result event)', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('idle')
  })

  it('throws when starting a session with an active process', async () => {
    await manager.start('s1', { prompt: 'hello' })
    await expect(manager.start('s1', { prompt: 'again' })).rejects.toThrow(
      'Session already has an active process',
    )
  })

  it('creates the session on first start', () => {
    expect(manager.hasSession('s1')).toBe(false)
  })

  it('records events in the log', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()
    const types = events.map((e) => e.type)
    expect(types).toEqual(['run:start', 'input:sent', 'run:ready', 'content', 'turn:end'])
  })

  it('stores resumeId from init event', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    const log = manager.getLog('s1')!
    const readyEvent = log.all().find((e) => e.type === 'run:ready')
    expect((readyEvent!.data as { resumeId: string }).resumeId).toBe('abc-123')
  })
})

describe('SessionManager — process exit', () => {
  it('appends run:end with reason completed on clean exit', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()
    const endEvent = events.find((e) => e.type === 'run:end')!
    expect(endEvent.data).toEqual({ code: 0, signal: undefined, reason: 'completed' })
    expect(manager.getStatus('s1')).toBe('idle')
  })

  it('appends run:end with reason process_exit on non-zero exit', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    fake.exit(1)
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()
    const endEvent = events.find((e) => e.type === 'run:end')!
    expect((endEvent.data as { reason: string }).reason).toBe('process_exit')
  })
})

describe('SessionManager — stop', () => {
  it('sends SIGINT immediately', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.stop('s1')
    expect(fake.signals).toEqual(['SIGINT'])
    expect(manager.getStatus('s1')).toBe('stopping')
  })

  it('appends stop:requested event', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.stop('s1')

    const events = manager.getLog('s1')!.all()
    expect(events.some((e) => e.type === 'stop:requested')).toBe(true)
  })

  it('escalates to SIGTERM after 3s if process ignores SIGINT', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.stop('s1')
    expect(fake.signals).toEqual(['SIGINT'])

    await vi.advanceTimersByTimeAsync(3000)
    expect(fake.signals).toEqual(['SIGINT', 'SIGTERM'])
  })

  it('escalates to SIGKILL after 5s if process ignores SIGTERM', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.stop('s1')
    await vi.advanceTimersByTimeAsync(3000) // SIGTERM
    await vi.advanceTimersByTimeAsync(2000) // SIGKILL
    expect(fake.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL'])
  })

  it('does not escalate if process exits after SIGINT', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.stop('s1')
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(3000) // SIGTERM timer fires but process is dead
    expect(fake.signals).toEqual(['SIGINT'])
  })

  it('records run:end with reason stopped after stop + exit', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.stop('s1')
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()
    const endEvent = events.find((e) => e.type === 'run:end')!
    expect((endEvent.data as { reason: string }).reason).toBe('stopped')
  })

  it('is a no-op when no process is running', async () => {
    await manager.stop('nonexistent')
    // Should not throw
  })

  it('is a no-op when already stopping', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.stop('s1')
    await manager.stop('s1') // second stop is no-op

    const events = manager.getLog('s1')!.all()
    const stopEvents = events.filter((e) => e.type === 'stop:requested')
    expect(stopEvents).toHaveLength(1) // only one stop:requested
  })
})

describe('SessionManager — mid-session model switch', () => {
  /** Drive a session to idle: start, emit init + result. */
  async function startIdleSession(args: string[] = ['--model=claude-fable-5']) {
    await manager.start('s1', { prompt: 'hello', args })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    return fake
  }

  it('respawns a dead-process follow-up with the new --model arg and resume', async () => {
    const fake = await startIdleSession()
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    const configs: SpawnConfig[] = []
    adapter.onSpawn = (config) => configs.push(config)
    await manager.send('s1', 'switch it', { model: 'claude-opus-5' })

    expect(configs).toHaveLength(1)
    expect(configs[0].args).toEqual(['--model=claude-opus-5'])
    expect(configs[0].resume).toBe('abc-123')
    expect(configs[0].extra?.model).toBe('claude-opus-5')
    expect(configs[0].prompt).toBe('switch it')
  })

  it('retires a live idle keep-alive process and respawns when the model changes', async () => {
    const fake = await startIdleSession()
    expect(fake.alive).toBe(true)

    const configs: SpawnConfig[] = []
    adapter.onSpawn = (config) => configs.push(config)

    const sendPromise = manager.send('s1', 'now on opus', { model: 'claude-opus-5' })
    await vi.advanceTimersByTimeAsync(0)
    // start() retires the idle keep-alive process before respawning
    expect(fake.signals).toContain('SIGTERM')
    fake.exit(0)
    await sendPromise

    expect(adapter.spawned).toHaveLength(2)
    expect(configs[0].args).toEqual(['--model=claude-opus-5'])
    expect(configs[0].resume).toBe('abc-123')
  })

  it('writes to stdin when the requested model matches the running config', async () => {
    const fake = await startIdleSession()

    await manager.send('s1', 'same model', { model: 'claude-fable-5' })

    expect(adapter.spawned).toHaveLength(1)
    expect(fake.stdinWrites).toHaveLength(1)
    expect(fake.stdinWrites[0]).toContain('same model')
  })

  it('does not respawn mid-turn — a streaming send goes to stdin even with a new model', async () => {
    await manager.start('s1', { prompt: 'hello', args: ['--model=claude-fable-5'] })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.send('s1', 'steer', { model: 'claude-opus-5' })

    expect(adapter.spawned).toHaveLength(1)
    expect(fake.stdinWrites).toHaveLength(1)
  })
})

describe('SessionManager — getStatus', () => {
  it('returns idle for unknown session', () => {
    expect(manager.getStatus('nonexistent')).toBe('idle')
  })
})

describe('SessionManager — getLog', () => {
  it('returns null for unknown session', () => {
    expect(manager.getLog('nonexistent')).toBeNull()
  })
})

describe('SessionManager — background tasks', () => {
  // The CLI sometimes auto-backgrounds foreground Bash commands that exceed
  // a timeout. It emits task_started but the tool_result has inline output
  // (no "Output is being written to:" path). Without a fix, these tasks
  // stay registered as "running" forever because no task_updated/notification
  // ever arrives from the CLI.

  const AUTO_BG_TOOL_USE = {
    type: 'assistant',
    message: {
      id: 'msg_autobg',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{
        type: 'tool_use',
        id: 'toolu_autobg_001',
        name: 'Bash',
        input: { command: 'pnpm test -- --run' },
      }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    parent_tool_use_id: null,
    session_id: 'abc-123',
  }

  const AUTO_BG_TASK_STARTED = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'autobg-001',
    tool_use_id: 'toolu_autobg_001',
    description: 'pnpm test -- --run',
    task_type: 'local_bash',
    session_id: 'abc-123',
  }

  // Inline result — no "Output is being written to:" path
  const AUTO_BG_RESULT = {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_autobg_001',
        content: '✓ 42 tests passed\n\nTest Files  1 passed (1)\nTests  42 passed (42)',
      }],
    },
    session_id: 'abc-123',
  }

  it('emits synthetic task:updated(completed) for auto-backgrounded tasks with inline results', async () => {
    await manager.start('s1', { prompt: 'run tests' })
    const fake = adapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(AUTO_BG_TOOL_USE))
    fake.emitLine(JSON.stringify(AUTO_BG_TASK_STARTED))
    fake.emitLine(JSON.stringify(AUTO_BG_RESULT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()
    // Should have a task:updated(completed) synthesized by the harness
    const taskUpdated = events.find(
      e => e.type === 'task:updated' && (e.data as { taskId: string }).taskId === 'autobg-001',
    )
    expect(taskUpdated).toBeDefined()
    expect((taskUpdated!.data as { patch: { status: string } }).patch.status).toBe('completed')
  })

  it('auto-backgrounded tasks do not leave hasRunningBackgroundTasks true', async () => {
    await manager.start('s1', { prompt: 'run tests' })
    const fake = adapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(AUTO_BG_TOOL_USE))
    fake.emitLine(JSON.stringify(AUTO_BG_TASK_STARTED))
    fake.emitLine(JSON.stringify(AUTO_BG_RESULT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()
    expect(hasRunningBackgroundTasks(events)).toBe(false)
  })

  it('explicit run_in_background tasks with output path start a tailer (not synthetic completion)', async () => {
    await manager.start('s1', { prompt: 'build' })
    const fake = adapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_bg', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
        content: [{ type: 'tool_use', id: 'toolu_bg_001', name: 'Bash', input: { command: 'pnpm build', run_in_background: true } }],
        stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 },
      },
      parent_tool_use_id: null, session_id: 'abc-123',
    }))
    fake.emitLine(JSON.stringify(TASK_STARTED))
    // Result WITH output path — this is a real background task
    fake.emitLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: TASK_STARTED.tool_use_id,
          content: 'Output is being written to: /tmp/bg-build.output',
        }],
      },
      session_id: 'abc-123',
    }))
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()
    // Should NOT have a synthetic task:updated — the task is genuinely running
    const taskUpdated = events.find(
      e => e.type === 'task:updated' && (e.data as { taskId: string }).taskId === TASK_STARTED.task_id,
    )
    expect(taskUpdated).toBeUndefined()
    // Task should still be running
    expect(hasRunningBackgroundTasks(events)).toBe(true)
  })
})
