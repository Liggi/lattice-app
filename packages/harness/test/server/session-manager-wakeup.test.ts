import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import {
  INIT_EVENT,
  TEXT_ASSISTANT,
  RESULT_SUCCESS,
  SCHEDULE_WAKEUP_ASSISTANT,
  SCHEDULE_WAKEUP_RESULT,
} from '../helpers/fixtures.js'

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

/**
 * Helper: run a session through a full ScheduleWakeup turn.
 * Returns the fake process for further interaction.
 *
 * After this, the session is idle with a pending wakeup timer (120s).
 */
async function runWakeupTurn() {
  await manager.start('s1', { prompt: 'run the build' })
  const fake = adapter.latest

  fake.emitLine(JSON.stringify(INIT_EVENT))
  fake.emitLine(JSON.stringify(SCHEDULE_WAKEUP_ASSISTANT))
  fake.emitLine(JSON.stringify(SCHEDULE_WAKEUP_RESULT))
  fake.emitLine(JSON.stringify(RESULT_SUCCESS))
  await vi.advanceTimersByTimeAsync(0)

  expect(manager.getStatus('s1')).toBe('idle')
  return fake
}

describe('SessionManager — ScheduleWakeup detection', () => {
  it('detects ScheduleWakeup tool_use and sets a timer', async () => {
    await runWakeupTurn()

    const diag = manager.inspect('s1')!
    expect(diag.scheduledWakeup).not.toBeNull()
    expect(diag.scheduledWakeup!.delaySecs).toBe(120)
    expect(diag.scheduledWakeup!.reason).toBe('Checking build progress')
    expect(diag.scheduledWakeup!.prompt).toBe('Check the build output at /tmp/build.log')
  })

  it('ignores non-ScheduleWakeup tool calls', async () => {
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))
    // A normal Read tool call — not ScheduleWakeup
    fake.emitLine(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_read', type: 'message', role: 'assistant', model: 'claude-opus-4-20250514',
        content: [{
          type: 'tool_use', id: 'toolu_read_001', name: 'Read',
          input: { file_path: '/tmp/test.txt' },
        }],
        stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 },
      },
      parent_tool_use_id: null, session_id: 'abc-123',
    }))
    await vi.advanceTimersByTimeAsync(0)

    const diag = manager.inspect('s1')!
    expect(diag.scheduledWakeup).toBeNull()
  })
})

describe('SessionManager — ScheduleWakeup timer fires', () => {
  it('sends the wakeup prompt to stdin after the delay', async () => {
    const fake = await runWakeupTurn()

    // Advance past the 120s delay
    await vi.advanceTimersByTimeAsync(120_000)

    expect(fake.stdinWrites).toEqual([
      'Check the build output at /tmp/build.log\n',
    ])
  })

  it('appends input:sent event with source=scheduled_wakeup', async () => {
    await runWakeupTurn()
    await vi.advanceTimersByTimeAsync(120_000)

    const events = manager.getLog('s1')!.all()
    const wakeupInput = events.filter(
      e => e.type === 'input:sent'
        && (e.data as { source?: string }).source === 'scheduled_wakeup',
    )
    expect(wakeupInput).toHaveLength(1)
    expect((wakeupInput[0].data as { text: string }).text).toBe(
      'Check the build output at /tmp/build.log',
    )
  })

  it('transitions status to streaming after wakeup fires and CLI responds', async () => {
    const fake = await runWakeupTurn()
    await vi.advanceTimersByTimeAsync(120_000)

    // Status should now be streaming (input:sent after run:ready)
    expect(manager.getStatus('s1')).toBe('streaming')

    // CLI responds to the wakeup prompt
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.getStatus('s1')).toBe('idle')
  })

  it('clears the scheduled wakeup after firing', async () => {
    await runWakeupTurn()

    expect(manager.inspect('s1')!.scheduledWakeup).not.toBeNull()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(manager.inspect('s1')!.scheduledWakeup).toBeNull()
  })

  it('does not fire before the delay', async () => {
    const fake = await runWakeupTurn()

    // Advance just short of the delay
    await vi.advanceTimersByTimeAsync(119_000)
    expect(fake.stdinWrites).toEqual([])
    expect(manager.inspect('s1')!.scheduledWakeup).not.toBeNull()
  })
})

describe('SessionManager — ScheduleWakeup cancellation', () => {
  it('cancels wakeup when user sends a message', async () => {
    const fake = await runWakeupTurn()

    // User sends a message before the wakeup fires
    await manager.send('s1', 'where are we?')
    expect(manager.inspect('s1')!.scheduledWakeup).toBeNull()

    // Advance past the original delay — wakeup should NOT fire
    await vi.advanceTimersByTimeAsync(120_000)
    // Only the user message should be in stdinWrites, not the wakeup prompt
    expect(fake.stdinWrites).toEqual(['where are we?\n'])
  })

  it('cancels wakeup on stop', async () => {
    const fake = await runWakeupTurn()

    await manager.stop('s1')
    expect(manager.inspect('s1')!.scheduledWakeup).toBeNull()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(fake.stdinWrites).toEqual([])
  })

  it('cancels wakeup on process exit', async () => {
    const fake = await runWakeupTurn()

    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.inspect('s1')!.scheduledWakeup).toBeNull()
  })

  it('cancels wakeup on destroy', async () => {
    await runWakeupTurn()

    manager.destroy('s1')
    // Session is gone — no diagnostics, but the timer shouldn't fire
    // (no error should be thrown either)
    await vi.advanceTimersByTimeAsync(120_000)
  })

  it('new ScheduleWakeup replaces the old one', async () => {
    const fake = await runWakeupTurn()

    // Advance 60s (halfway through first wakeup)
    await vi.advanceTimersByTimeAsync(60_000)

    // CLI wakes up from external trigger (e.g., background task) and
    // schedules a new wakeup with different parameters
    fake.emitLine(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_wakeup_2', type: 'message', role: 'assistant', model: 'claude-opus-4-20250514',
        content: [{
          type: 'tool_use', id: 'toolu_wakeup_002', name: 'ScheduleWakeup',
          input: { delaySeconds: 60, reason: 'Checking again', prompt: 'Check /tmp/build2.log' },
        }],
        stop_reason: 'tool_use', usage: { input_tokens: 200, output_tokens: 100 },
      },
      parent_tool_use_id: null, session_id: 'abc-123',
    }))
    fake.emitLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_wakeup_002', content: 'Next wakeup scheduled.' }],
      },
      session_id: 'abc-123',
    }))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    // Should have the new wakeup, not the old one
    const diag = manager.inspect('s1')!
    expect(diag.scheduledWakeup!.delaySecs).toBe(60)
    expect(diag.scheduledWakeup!.prompt).toBe('Check /tmp/build2.log')

    // The old wakeup's remaining 60s passes — should NOT fire old prompt
    await vi.advanceTimersByTimeAsync(60_000)
    // Only the new wakeup prompt should be sent
    expect(fake.stdinWrites).toEqual(['Check /tmp/build2.log\n'])
  })
})

describe('SessionManager — ScheduleWakeup safety', () => {
  it('skips wakeup if session is already streaming (CLI woke itself up)', async () => {
    const fake = await runWakeupTurn()

    // Simulate the CLI waking itself up (e.g., from a background task completion)
    // by emitting content events before the timer fires
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('streaming')

    // Now advance past the wakeup delay — should NOT send prompt (session is streaming)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fake.stdinWrites).toEqual([])
  })

  it('re-delivers wakeup when session returns to idle after firing non-idle', async () => {
    // Regression: if the wakeup timer fires while the session is busy
    // (streaming, mid-tool, etc.), the original code silently dropped the
    // wakeup and nulled session.scheduledWakeup. If the session then
    // returned to idle, the wake was lost forever — the /loop stalled
    // permanently. The fix defers delivery and flushes on idle transition.
    const fake = await runWakeupTurn()

    // CLI wakes itself up (e.g., background task tool_result) before the timer fires.
    // Session transitions to streaming.
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('streaming')

    // Wakeup timer fires while streaming → delivery deferred, not dropped.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fake.stdinWrites).toEqual([])
    // The wake is parked as pending (timer cleared but metadata preserved).
    expect(manager.inspect('s1')!.scheduledWakeup!.pending).toBe(true)

    // Session finishes the unrelated turn. RESULT_SUCCESS transitions status
    // to idle, which the flush hook detects and immediately delivers the
    // deferred wake — so status ends up at 'streaming' again, not 'idle'.
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    expect(fake.stdinWrites).toEqual([
      'Check the build output at /tmp/build.log\n',
    ])
    expect(manager.getStatus('s1')).toBe('streaming')
    // Wake delivered → no longer parked.
    expect(manager.inspect('s1')!.scheduledWakeup).toBeNull()
  })

  it('skips wakeup if process has exited without triggering handleExit cancel', async () => {
    // This tests the guard in the timer callback itself, separate from
    // the cancel in handleExit. Even if cancelWakeup somehow fails,
    // the timer checks process.alive before writing.
    const fake = await runWakeupTurn()

    // Simulate a scenario where the process dies after the timer was set
    // but the timer fires before handleExit runs
    // We test this by directly checking: if process.alive is false, no stdin write
    fake.alive = false

    await vi.advanceTimersByTimeAsync(120_000)
    expect(fake.stdinWrites).toEqual([])
  })
})

describe('SessionManager — ScheduleWakeup loop', () => {
  it('supports a full wakeup loop: schedule → fire → respond → schedule again', async () => {
    // Turn 1: initial work + schedule wakeup
    const fake = await runWakeupTurn()

    // Wakeup fires
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fake.stdinWrites).toEqual(['Check the build output at /tmp/build.log\n'])
    expect(manager.getStatus('s1')).toBe('streaming')

    // Turn 2: CLI checks the build, schedules another wakeup
    fake.emitLine(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_check', type: 'message', role: 'assistant', model: 'claude-opus-4-20250514',
        content: [
          { type: 'text', text: 'Build still running. Checking again in 60s.' },
          {
            type: 'tool_use', id: 'toolu_wakeup_loop', name: 'ScheduleWakeup',
            input: { delaySeconds: 60, reason: 'Re-checking build', prompt: 'Check /tmp/build.log again' },
          },
        ],
        stop_reason: 'tool_use', usage: { input_tokens: 200, output_tokens: 100 },
      },
      parent_tool_use_id: null, session_id: 'abc-123',
    }))
    fake.emitLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_wakeup_loop', content: 'Next wakeup scheduled.' }],
      },
      session_id: 'abc-123',
    }))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.getStatus('s1')).toBe('idle')
    expect(manager.inspect('s1')!.scheduledWakeup!.delaySecs).toBe(60)

    // Second wakeup fires
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.stdinWrites).toContain('Check /tmp/build.log again\n')
    expect(manager.getStatus('s1')).toBe('streaming')
  })
})
