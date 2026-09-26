import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import {
  INIT_EVENT,
  TEXT_ASSISTANT,
  RESULT_SUCCESS,
  MONITOR_ASSISTANT,
  MONITOR_TASK_STARTED,
  MONITOR_RESULT,
  TASK_STARTED,
} from '../helpers/fixtures.js'
import { hasRunningBackgroundTasks } from '../../src/protocol/derive.js'

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

describe('SessionManager — Monitor tool (no synthetic completion)', () => {
  it('does NOT emit synthetic task:updated(completed) for Monitor', async () => {
    await manager.start('s1', { prompt: 'watch the build' })
    const fake = adapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(MONITOR_ASSISTANT))
    fake.emitLine(JSON.stringify(MONITOR_TASK_STARTED))
    fake.emitLine(JSON.stringify(MONITOR_RESULT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()

    // There should be NO synthetic task:updated for the monitor task
    const taskUpdated = events.find(
      e => e.type === 'task:updated'
        && (e.data as { taskId: string }).taskId === 'monitor-task-001',
    )
    expect(taskUpdated).toBeUndefined()
  })

  it('Monitor task stays running in hasRunningBackgroundTasks', async () => {
    await manager.start('s1', { prompt: 'watch the build' })
    const fake = adapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(MONITOR_ASSISTANT))
    fake.emitLine(JSON.stringify(MONITOR_TASK_STARTED))
    fake.emitLine(JSON.stringify(MONITOR_RESULT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()
    expect(hasRunningBackgroundTasks(events)).toBe(true)
  })

  it('Monitor task clears when CLI sends real task:updated', async () => {
    await manager.start('s1', { prompt: 'watch the build' })
    const fake = adapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(MONITOR_ASSISTANT))
    fake.emitLine(JSON.stringify(MONITOR_TASK_STARTED))
    fake.emitLine(JSON.stringify(MONITOR_RESULT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    // Monitor is still running
    expect(hasRunningBackgroundTasks(manager.getLog('s1')!.all())).toBe(true)

    // CLI sends real completion when the monitored command finishes
    fake.emitLine(JSON.stringify({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'monitor-task-001',
      patch: { status: 'completed', end_time: Date.now() },
      session_id: 'abc-123',
    }))
    await vi.advanceTimersByTimeAsync(0)

    expect(hasRunningBackgroundTasks(manager.getLog('s1')!.all())).toBe(false)
  })

  it('Monitor task clears when CLI sends task:notification', async () => {
    await manager.start('s1', { prompt: 'watch the build' })
    const fake = adapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(MONITOR_ASSISTANT))
    fake.emitLine(JSON.stringify(MONITOR_TASK_STARTED))
    fake.emitLine(JSON.stringify(MONITOR_RESULT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    expect(hasRunningBackgroundTasks(manager.getLog('s1')!.all())).toBe(true)

    // CLI sends notification when monitor fires
    fake.emitLine(JSON.stringify({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'monitor-task-001',
      session_id: 'abc-123',
    }))
    await vi.advanceTimersByTimeAsync(0)

    expect(hasRunningBackgroundTasks(manager.getLog('s1')!.all())).toBe(false)
  })

  it('Monitor task clears on process exit', async () => {
    await manager.start('s1', { prompt: 'watch the build' })
    const fake = adapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(MONITOR_ASSISTANT))
    fake.emitLine(JSON.stringify(MONITOR_TASK_STARTED))
    fake.emitLine(JSON.stringify(MONITOR_RESULT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    expect(hasRunningBackgroundTasks(manager.getLog('s1')!.all())).toBe(true)

    // Process exits — run:end clears all tasks in deriveBackgroundTasks
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(hasRunningBackgroundTasks(manager.getLog('s1')!.all())).toBe(false)
  })
})

describe('SessionManager — auto-backgrounding still works for regular Bash', () => {
  // Regression guard: ensure we didn't break auto-backgrounding for normal commands

  const AUTO_BG_TOOL_USE = {
    type: 'assistant',
    message: {
      id: 'msg_autobg', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
      content: [{
        type: 'tool_use', id: 'toolu_autobg_001', name: 'Bash',
        input: { command: 'pnpm test -- --run' },
      }],
      stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 },
    },
    parent_tool_use_id: null, session_id: 'abc-123',
  }

  const AUTO_BG_TASK_STARTED = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'autobg-regression-001',
    tool_use_id: 'toolu_autobg_001',
    description: 'pnpm test -- --run',
    task_type: 'local_bash',
    session_id: 'abc-123',
  }

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

  it('still emits synthetic completion for auto-backgrounded Bash commands', async () => {
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
    const taskUpdated = events.find(
      e => e.type === 'task:updated'
        && (e.data as { taskId: string }).taskId === 'autobg-regression-001',
    )
    expect(taskUpdated).toBeDefined()
    expect((taskUpdated!.data as { patch: { status: string } }).patch.status).toBe('completed')
    expect(hasRunningBackgroundTasks(events)).toBe(false)
  })
})

describe('SessionManager — Monitor alongside regular background tasks', () => {
  it('Monitor stays running while auto-backgrounded Bash completes', async () => {
    await manager.start('s1', { prompt: 'build and watch' })
    const fake = adapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))

    // Claude calls both Monitor and a Bash command
    fake.emitLine(JSON.stringify(MONITOR_ASSISTANT))
    fake.emitLine(JSON.stringify(MONITOR_TASK_STARTED))
    fake.emitLine(JSON.stringify(MONITOR_RESULT))

    // Auto-backgrounded Bash task
    fake.emitLine(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_bash', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
        content: [{ type: 'tool_use', id: 'toolu_bash_concurrent', name: 'Bash', input: { command: 'echo done' } }],
        stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 },
      },
      parent_tool_use_id: null, session_id: 'abc-123',
    }))
    fake.emitLine(JSON.stringify({
      ...TASK_STARTED,
      task_id: 'bash-concurrent-001',
      tool_use_id: 'toolu_bash_concurrent',
      description: 'echo done',
    }))
    fake.emitLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_bash_concurrent', content: 'done' }],
      },
      session_id: 'abc-123',
    }))

    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()

    // Bash task should be synthetically completed
    const bashUpdated = events.find(
      e => e.type === 'task:updated'
        && (e.data as { taskId: string }).taskId === 'bash-concurrent-001',
    )
    expect(bashUpdated).toBeDefined()

    // Monitor should still be running
    const monitorUpdated = events.find(
      e => e.type === 'task:updated'
        && (e.data as { taskId: string }).taskId === 'monitor-task-001',
    )
    expect(monitorUpdated).toBeUndefined()

    // Overall: still has running background tasks (from Monitor)
    expect(hasRunningBackgroundTasks(events)).toBe(true)
  })
})
