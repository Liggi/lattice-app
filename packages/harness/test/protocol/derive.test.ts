import { describe, it, expect, beforeEach } from 'vitest'
import { deriveStatus, deriveActivity, deriveProcessAlive, deriveUsage, deriveBackgroundTasks, hasRunningBackgroundTasks, deriveScheduledWakeup, derivePlanOutcomes } from '../../src/protocol/derive.js'
import { makeEvent, makeContentEvent, resetSeq } from '../helpers/events.js'
import type { EventType } from '../../src/protocol/events.js'

beforeEach(() => resetSeq())

describe('deriveStatus', () => {
  it('returns idle for empty events', () => {
    expect(deriveStatus([])).toBe('idle')
  })

  it('returns starting after run:start', () => {
    expect(deriveStatus([makeEvent('run:start')])).toBe('starting')
  })

  it('returns idle after run:ready with no input:sent (interactive mode)', () => {
    const events = [makeEvent('run:start'), makeEvent('run:ready')]
    expect(deriveStatus(events)).toBe('idle')
  })

  it('returns streaming after run:ready when input:sent precedes it', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('input:sent', { text: 'hello' }),
      makeEvent('run:ready'),
    ]
    expect(deriveStatus(events)).toBe('streaming')
  })

  it('returns streaming after content', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'hello' }]),
    ]
    expect(deriveStatus(events)).toBe('streaming')
  })

  it('returns streaming after result', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeEvent('result', { blocks: [] }),
    ]
    expect(deriveStatus(events)).toBe('streaming')
  })

  it('returns streaming after input:sent', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeEvent('input:sent', { text: 'hi' }),
    ]
    expect(deriveStatus(events)).toBe('streaming')
  })

  it('returns stopping after stop:requested', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'hello' }]),
      makeEvent('stop:requested'),
    ]
    expect(deriveStatus(events)).toBe('stopping')
  })

  it('returns idle after run:end', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'hello' }]),
      makeEvent('run:end', { code: 0, reason: 'completed' }),
    ]
    expect(deriveStatus(events)).toBe('idle')
  })

  it('returns idle after run:error', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:error', { message: 'spawn failed' }),
    ]
    expect(deriveStatus(events)).toBe('idle')
  })

  it('returns idle after turn:end', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'hello' }]),
      makeEvent('turn:end', { usage: {} }),
    ]
    expect(deriveStatus(events)).toBe('idle')
  })

  it('stays idle when a background subagent keeps streaming after turn:end', () => {
    // A backgrounded Agent returns its tool_result immediately, so the main
    // thread reaches turn:end while the subagent writes into the same log.
    // Those events must not read as a live foreground turn.
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'tool_use', id: 'toolu_bg', name: 'Agent' }]),
      makeEvent('result', { blocks: [{ type: 'tool_result', tool_use_id: 'toolu_bg' }] }),
      makeEvent('turn:end', { usage: {} }),
      makeEvent('content', {
        blocks: [{ type: 'text', text: 'subagent working' }],
        parentToolUseId: 'toolu_bg',
      }),
      makeEvent('result', {
        blocks: [{ type: 'tool_result', tool_use_id: 'toolu_inner' }],
        parentToolUseId: 'toolu_bg',
      }),
    ]
    expect(deriveStatus(events)).toBe('idle')
  })

  it('returns streaming while a foreground subagent runs', () => {
    // Skipping the child events lands the walk on the main thread's own content
    // event — the one carrying the Agent tool_use — which is still streaming.
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'tool_use', id: 'toolu_fg', name: 'Agent' }]),
      makeEvent('content', {
        blocks: [{ type: 'text', text: 'subagent working' }],
        parentToolUseId: 'toolu_fg',
      }),
    ]
    expect(deriveStatus(events)).toBe('streaming')
  })

  it('returns streaming once the main thread resumes after a background subagent', () => {
    const events = [
      makeEvent('turn:end', { usage: {} }),
      makeEvent('content', {
        blocks: [{ type: 'text', text: 'subagent working' }],
        parentToolUseId: 'toolu_bg',
      }),
      makeContentEvent([{ type: 'text', text: 'woken by the finished agent' }]),
    ]
    expect(deriveStatus(events)).toBe('streaming')
  })

  it('keeps legacy untagged subagent events reading as streaming', () => {
    // Events recorded before the CLI tagged parentToolUseId cannot be attributed,
    // so they keep the old behaviour rather than gaining a new wrong one.
    const events = [
      makeEvent('turn:end', { usage: {} }),
      makeContentEvent([{ type: 'text', text: 'untagged' }]),
    ]
    expect(deriveStatus(events)).toBe('streaming')
  })

  it.each(['started', 'completed', 'failed'] as const)(
    'treats context compaction %s as informational while idle',
    (phase) => {
      const events = [
        makeEvent('run:start'),
        makeEvent('run:ready'),
        makeEvent('turn:end'),
        makeEvent('context:compaction', { phase }),
      ]
      expect(deriveStatus(events)).toBe('idle')
    },
  )

  it('does not let context compaction lifecycle finish a streaming turn', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'hello' }]),
      makeEvent('context:compaction', { phase: 'completed', result: 'success' }),
    ]
    expect(deriveStatus(events)).toBe('streaming')
  })

  // Event order recorded from a Claude session on a llama.cpp endpoint with a
  // 40,960-token window (lattice-app 0.6.2, CLI 2.1.287, 6 Oct 2026): Claude
  // compacted after the Read result, logged the boundary as a turn:end, then
  // made the request it was about to make. The session read idle for that whole
  // request.
  describe('an automatic compaction inside a turn', () => {
    const toolThenAutoCompaction = () => [
      makeEvent('run:start'),
      makeEvent('input:sent', { text: 'Read notes.txt' }),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      makeEvent('result', { blocks: [] }),
      makeEvent('context:compaction', { phase: 'started' }),
      makeEvent('context:compaction', { phase: 'completed', result: 'success' }),
      makeEvent('turn:end', { compact: true, trigger: 'auto', preTokens: 22102, postTokens: 968 }),
    ]

    it('reads streaming while the turn carries on after it', () => {
      expect(deriveStatus(toolThenAutoCompaction())).toBe('streaming')
    })

    // Recorded the same day with a 58,000-token window: the compaction ran
    // before the second message's first request, and the answer came 50s later.
    it('reads streaming when Claude compacts before answering a new message', () => {
      const events = [
        makeEvent('turn:end'),
        makeEvent('input:sent', { text: 'And now?' }),
        makeEvent('run:ready'),
        makeEvent('context:compaction', { phase: 'started' }),
        makeEvent('context:compaction', { phase: 'started' }),
        makeEvent('context:compaction', { phase: 'completed', result: 'success' }),
        makeEvent('turn:end', { compact: true, trigger: 'auto' }),
      ]
      expect(deriveStatus(events)).toBe('streaming')
    })

    it('reads idle once the turn ends', () => {
      const events = [
        ...toolThenAutoCompaction(),
        makeContentEvent([{ type: 'text', text: 'PELICAN' }]),
        makeEvent('turn:end'),
      ]
      expect(deriveStatus(events)).toBe('idle')
    })

    it('reads idle after a manual /compact', () => {
      const events = [
        makeEvent('turn:end'),
        makeEvent('input:sent', { text: '/compact', source: 'command' }),
        makeEvent('context:compaction', { phase: 'completed', result: 'success' }),
        makeEvent('turn:end', { compact: true, trigger: 'manual' }),
      ]
      expect(deriveStatus(events)).toBe('idle')
    })
  })

  // Event order recorded from a Claude session sent a message mid-compaction
  // (conv-PK-0ehg9u-G3 seq 68-82, 27 Sep 2026): the message is held until the
  // compaction ends, then answered as a turn with no input:sent of its own.
  describe('a message held through a compaction', () => {
    const compactionWithHeldMessage = () => [
      makeEvent('run:ready'),
      makeEvent('turn:end'),
      makeEvent('input:sent', { text: '/compact', source: 'command' }),
      makeEvent('context:compaction', { phase: 'started' }),
      makeEvent('input:sent', { text: 'What colour is the sea?' }),
      makeEvent('context:compaction', { phase: 'completed', result: 'success' }),
      makeEvent('run:ready'),
      makeEvent('turn:end', { compact: true }),
      makeEvent('input:read' as EventType, { ids: ['a'] }),
      makeEvent('input:incorporated' as EventType, { where: 'next-turn' }),
      makeEvent('turn:end'),
    ]

    it('reads streaming once the compaction turn ends and the message starts', () => {
      expect(deriveStatus(compactionWithHeldMessage())).toBe('streaming')
      expect(deriveStatus([...compactionWithHeldMessage(), makeEvent('run:ready')])).toBe('streaming')
    })

    it('reads streaming when the compaction boundary lands after the incorporation', () => {
      // Recorded the other way round in conv-PK-0ehg9u-G3 seq 96-101.
      const events = [
        makeEvent('turn:end'),
        makeEvent('input:sent', { text: '/compact', source: 'command' }),
        makeEvent('context:compaction', { phase: 'started' }),
        makeEvent('input:sent', { text: 'What colour is the sea?' }),
        makeEvent('context:compaction', { phase: 'completed', result: 'success' }),
        makeEvent('input:read' as EventType, { ids: ['a'] }),
        makeEvent('input:incorporated' as EventType, { where: 'next-turn' }),
        makeEvent('run:ready'),
        makeEvent('turn:end', { compact: true }),
        makeEvent('turn:end'),
        makeEvent('run:ready'),
      ]
      expect(deriveStatus(events)).toBe('streaming')
    })

    it('reads idle once the answer ends', () => {
      const events = [
        ...compactionWithHeldMessage(),
        makeEvent('run:ready'),
        makeContentEvent([{ type: 'text', text: 'Blue.' }]),
        makeEvent('turn:end'),
      ]
      expect(deriveStatus(events)).toBe('idle')
    })

    it('reads idle when the turn after it ends on an error', () => {
      const events = [
        makeEvent('turn:end'),
        makeEvent('input:incorporated' as EventType, { where: 'next-turn' }),
        makeEvent('turn:end', { error: { message: 'Overloaded', reason: 'api_error' } }),
      ]
      expect(deriveStatus(events)).toBe('idle')
    })

    it('does not treat a mid-turn incorporation as a new turn', () => {
      const events = [
        makeEvent('turn:end'),
        makeEvent('input:incorporated' as EventType, { where: 'mid-turn' }),
      ]
      expect(deriveStatus(events)).toBe('idle')
    })
  })

  it('returns starting for a new run after previous ended', () => {
    const events = [
      makeEvent('run:start', {}, { runId: 'r1' }),
      makeEvent('run:ready', {}, { runId: 'r1' }),
      makeEvent('turn:end', {}, { runId: 'r1' }),
      makeEvent('run:start', {}, { runId: 'r2' }),
    ]
    expect(deriveStatus(events)).toBe('starting')
  })

  it('returns idle after stop:requested followed by run:end', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeEvent('stop:requested'),
      makeEvent('run:end', { code: 0, reason: 'stopped' }),
    ]
    expect(deriveStatus(events)).toBe('idle')
  })

  it('handles a full lifecycle: start → stream → end → restart with prompt', () => {
    const events = [
      makeEvent('run:start', {}, { runId: 'r1' }),
      makeEvent('input:sent', { text: 'hello' }, { runId: 'r1' }),
      makeEvent('run:ready', {}, { runId: 'r1' }),
      makeContentEvent([{ type: 'text', text: 'hi' }]),
      makeEvent('turn:end', {}, { runId: 'r1' }),
      makeEvent('run:end', { code: 0, reason: 'completed' }, { runId: 'r1' }),
      makeEvent('run:start', {}, { runId: 'r2' }),
      makeEvent('input:sent', { text: 'follow up' }, { runId: 'r2' }),
      makeEvent('run:ready', {}, { runId: 'r2' }),
    ]
    expect(deriveStatus(events)).toBe('streaming')
  })

  it('handles restart without prompt: idle after run:ready', () => {
    const events = [
      makeEvent('run:start', {}, { runId: 'r1' }),
      makeEvent('run:ready', {}, { runId: 'r1' }),
      makeContentEvent([{ type: 'text', text: 'hi' }]),
      makeEvent('turn:end', {}, { runId: 'r1' }),
      makeEvent('run:end', { code: 0, reason: 'completed' }, { runId: 'r1' }),
      makeEvent('run:start', {}, { runId: 'r2' }),
      makeEvent('run:ready', {}, { runId: 'r2' }),
    ]
    expect(deriveStatus(events)).toBe('idle')
  })

  // Background task events are informational — they should not change status
  it('task:started does not change status (remains streaming)', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
    ]
    expect(deriveStatus(events)).toBe('streaming')
  })

  it('task:updated does not change idle status after turn:end', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'launched' }]),
      makeEvent('turn:end'),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'completed' } }),
    ]
    expect(deriveStatus(events)).toBe('idle')
  })

  it('task:notification does not change idle status', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'launched' }]),
      makeEvent('turn:end'),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'completed' } }),
      makeEvent('task:notification', { taskId: 'bg1' }),
    ]
    expect(deriveStatus(events)).toBe('idle')
  })

  it('full background task lifecycle: streaming → idle → wake-up → streaming', () => {
    const events = [
      // Turn 1: launch background task, end turn
      makeEvent('run:start', {}, { runId: 'r1' }),
      makeEvent('input:sent', { text: 'run in background' }, { runId: 'r1' }),
      makeEvent('run:ready', {}, { runId: 'r1' }),
      makeContentEvent([{ type: 'tool_use', id: 't1', name: 'Bash', input: { run_in_background: true } }]),
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('result', { blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'Output is being written to: /tmp/bg.output' }] }),
      makeContentEvent([{ type: 'text', text: "I'll check when it's done" }]),
      makeEvent('turn:end'),
    ]
    expect(deriveStatus(events)).toBe('idle')

    // Task completes, notification fires
    events.push(makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'completed' } }))
    events.push(makeEvent('task:notification', { taskId: 'bg1' }))
    expect(deriveStatus(events)).toBe('idle')

    // CLI wakes up (second system:init → run:ready)
    events.push(makeEvent('run:ready', { resumeId: 'abc-123' }))
    // run:ready after turn:end with no input:sent → idle (interactive wake-up)
    // But the CLI immediately starts processing, so content follows
    events.push(makeContentEvent([{ type: 'text', text: 'Task finished, let me check' }]))
    expect(deriveStatus(events)).toBe('streaming')
  })
})

describe('deriveActivity', () => {
  it('returns null for empty events', () => {
    expect(deriveActivity([])).toBeNull()
  })

  it('returns null when not streaming', () => {
    expect(deriveActivity([makeEvent('run:start')])).toBeNull()
  })

  it('returns thinking when last content block is thinking', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'thinking', thinking: '...' }]),
    ]
    expect(deriveActivity(events)).toEqual({ type: 'thinking' })
  })

  it('returns tool when last content block is tool_use', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/foo' } },
      ]),
    ]
    expect(deriveActivity(events)).toEqual({
      type: 'tool',
      name: 'read_file',
      input: { path: '/foo' },
    })
  })

  it('returns null when last content block is text', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'hello' }]),
    ]
    expect(deriveActivity(events)).toBeNull()
  })

  it('still shows tool activity after result event (turn not ended yet)', () => {
    // A result event (tool_result) does not end the turn — the CLI may
    // continue with more content. Activity remains until turn:end.
    const events = [
      makeEvent('run:start'),
      makeEvent('input:sent', { text: 'hello' }),
      makeEvent('run:ready'),
      makeContentEvent([
        { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      ]),
      makeEvent('result', {
        blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
      }),
    ]
    expect(deriveActivity(events)).toEqual({
      type: 'tool',
      name: 'read_file',
      input: {},
    })
  })

  it('returns null after tool result followed by turn:end', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('input:sent', { text: 'hello' }),
      makeEvent('run:ready'),
      makeContentEvent([
        { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      ]),
      makeEvent('result', {
        blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
      }),
      makeEvent('turn:end', { usage: {} }),
    ]
    expect(deriveActivity(events)).toBeNull()
  })

  it('returns null after turn:end', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'thinking', thinking: '...' }]),
      makeEvent('turn:end', { usage: {} }),
    ]
    expect(deriveActivity(events)).toBeNull()
  })

  it('tracks activity through multiple content events', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'thinking', thinking: '...' }]),
      makeContentEvent([{ type: 'text', text: 'I will use a tool' }]),
      makeContentEvent([
        { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
      ]),
    ]
    expect(deriveActivity(events)).toEqual({
      type: 'tool',
      name: 'bash',
      input: { cmd: 'ls' },
    })
  })

  it('returns null when idle even if previous content had activity', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'thinking', thinking: '...' }]),
      makeEvent('turn:end', { usage: {} }),
      makeEvent('run:end', { code: 0, reason: 'completed' }),
    ]
    expect(deriveActivity(events)).toBeNull()
  })
})

describe('deriveProcessAlive', () => {
  it('returns false for empty events', () => {
    expect(deriveProcessAlive([])).toBe(false)
  })

  it('returns true after run:start', () => {
    expect(deriveProcessAlive([makeEvent('run:start')])).toBe(true)
  })

  it('returns true after run:ready', () => {
    const events = [makeEvent('run:start'), makeEvent('run:ready')]
    expect(deriveProcessAlive(events)).toBe(true)
  })

  it('returns true after content', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'hello' }]),
    ]
    expect(deriveProcessAlive(events)).toBe(true)
  })

  it('returns true after input:sent', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeEvent('input:sent', { text: 'hi' }),
    ]
    expect(deriveProcessAlive(events)).toBe(true)
  })

  it('returns true after turn:end (keep-alive)', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'hello' }]),
      makeEvent('turn:end', { usage: {} }),
    ]
    expect(deriveProcessAlive(events)).toBe(true)
  })

  it('returns true for a context compaction lifecycle event', () => {
    expect(deriveProcessAlive([
      makeEvent('context:compaction', { phase: 'started' }),
    ])).toBe(true)
  })

  it('returns true after stop:requested (process still alive)', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeEvent('stop:requested'),
    ]
    expect(deriveProcessAlive(events)).toBe(true)
  })

  it('returns false after run:end', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'hello' }]),
      makeEvent('turn:end', { usage: {} }),
      makeEvent('run:end', { code: 0, reason: 'completed' }),
    ]
    expect(deriveProcessAlive(events)).toBe(false)
  })

  it('returns false after run:error', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:error', { message: 'spawn failed' }),
    ]
    expect(deriveProcessAlive(events)).toBe(false)
  })

  it('tracks full lifecycle: alive → dead → alive again', () => {
    const events = [
      makeEvent('run:start', {}, { runId: 'r1' }),
      makeEvent('run:ready', {}, { runId: 'r1' }),
      makeContentEvent([{ type: 'text', text: 'hi' }]),
      makeEvent('turn:end', {}, { runId: 'r1' }),
    ]
    expect(deriveProcessAlive(events)).toBe(true)

    events.push(makeEvent('run:end', { code: 0, reason: 'completed' }, { runId: 'r1' }))
    expect(deriveProcessAlive(events)).toBe(false)

    events.push(makeEvent('run:start', {}, { runId: 'r2' }))
    expect(deriveProcessAlive(events)).toBe(true)
  })

  it('returns true after task:started', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
    ]
    expect(deriveProcessAlive(events)).toBe(true)
  })

  it('returns true after task:updated (task completed but process alive)', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'launched' }]),
      makeEvent('turn:end'),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'completed' } }),
    ]
    expect(deriveProcessAlive(events)).toBe(true)
  })

  it('returns true after task:notification', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'launched' }]),
      makeEvent('turn:end'),
      makeEvent('task:notification', { taskId: 'bg1' }),
    ]
    expect(deriveProcessAlive(events)).toBe(true)
  })
})

describe('deriveBackgroundTasks', () => {
  it('returns empty map for no events', () => {
    expect(deriveBackgroundTasks([]).size).toBe(0)
  })

  it('tracks a started task as running', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash', description: 'test' }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.size).toBe(1)
    expect(tasks.get('bg1')).toMatchObject({ taskId: 'bg1', toolUseId: 't1', status: 'running' })
  })

  it('marks task as completed after task:updated', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'completed' } }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.get('bg1')!.status).toBe('completed')
  })

  it('tracks multiple concurrent tasks independently', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:started', { taskId: 'bg2', toolUseId: 't2', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'completed' } }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.get('bg1')!.status).toBe('completed')
    expect(tasks.get('bg2')!.status).toBe('running')
  })

  it('ignores non-bash tasks (e.g. local_agent)', () => {
    const events = [
      makeEvent('task:started', { taskId: 'agent1', toolUseId: 't1', taskType: 'local_agent' }),
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't2', taskType: 'local_bash' }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.size).toBe(1)
    expect(tasks.has('agent1')).toBe(false)
    expect(tasks.has('bg1')).toBe(true)
  })

  it('clears all tasks on run:end (stale tasks from previous runs)', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('run:end', { code: 0, reason: 'completed' }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.size).toBe(0)
  })

  it('clears orphaned tasks on run:start (previous process died without run:end)', () => {
    // Server killed mid-run: task:started, then no run:end — the next resume
    // writes run:start directly. The orphaned task must not derive as running.
    const events = [
      makeEvent('task:started', { taskId: 'orphan1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('turn:end', {}),
      makeEvent('run:start'),
      makeEvent('run:ready', { resumeId: 'r2' }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.size).toBe(0)
    expect(hasRunningBackgroundTasks(events)).toBe(false)
  })

  it('clears all tasks on run:error', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('run:error', { message: 'crash' }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.size).toBe(0)
  })

  it('tracks new tasks after a run:end from previous run', () => {
    const events = [
      makeEvent('task:started', { taskId: 'old1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('run:end', { code: 0, reason: 'completed' }),
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeEvent('task:started', { taskId: 'new1', toolUseId: 't2', taskType: 'local_bash' }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.size).toBe(1)
    expect(tasks.has('old1')).toBe(false)
    expect(tasks.has('new1')).toBe(true)
  })

  it('marks task completed on task:notification', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:notification', { taskId: 'bg1' }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.get('bg1')!.status).toBe('completed')
  })

  // ---- Terminal status handling (the "failed Monitor" fix) ----

  it('marks task completed when task:updated has status "failed"', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'failed' } }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.get('bg1')!.status).toBe('completed')
  })

  it('marks task completed when task:updated has status "error"', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'error' } }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.get('bg1')!.status).toBe('completed')
  })

  it('marks task completed when task:updated has status "cancelled"', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'cancelled' } }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.get('bg1')!.status).toBe('completed')
  })

  it('keeps task running when task:updated has status "running"', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'running' } }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.get('bg1')!.status).toBe('running')
  })

  // ---- Edge cases ----

  it('ignores task:updated for unknown task IDs', () => {
    const events = [
      makeEvent('task:updated', { taskId: 'unknown', patch: { status: 'completed' } }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.size).toBe(0)
  })

  it('ignores task:notification for unknown task IDs', () => {
    const events = [
      makeEvent('task:notification', { taskId: 'unknown' }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.size).toBe(0)
  })

  it('handles duplicate task:started events (last wins)', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash', description: 'first' }),
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash', description: 'retry' }),
    ]
    const tasks = deriveBackgroundTasks(events)
    expect(tasks.size).toBe(1)
    expect(tasks.get('bg1')!.description).toBe('retry')
    expect(tasks.get('bg1')!.status).toBe('running')
  })

  it('preserves task description and metadata', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash', description: 'Build project' }),
    ]
    const tasks = deriveBackgroundTasks(events)
    const task = tasks.get('bg1')!
    expect(task.description).toBe('Build project')
    expect(task.toolUseId).toBe('t1')
    expect(task.taskType).toBe('local_bash')
  })

  // ---- Full lifecycle scenarios ----

  it('Monitor-style task: started → failed via task:updated → no longer running', () => {
    // Simulates a Monitor tool that launches a task which fails (e.g., tail -f on missing file)
    const events = [
      makeEvent('run:start'),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'tool_use', id: 't1', name: 'Monitor', input: { command: 'tail -f /tmp/missing.log' } }]),
      makeEvent('task:started', { taskId: 'mon1', toolUseId: 't1', taskType: 'local_bash', description: 'watch server logs' }),
      makeEvent('result', { blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'Monitor started (task mon1, timeout 30000ms)' }] }),
      makeContentEvent([{ type: 'text', text: "I'll watch the logs" }]),
      makeEvent('turn:end'),
      // Monitor task fails — task:updated arrives with status: 'failed'
      makeEvent('task:updated', { taskId: 'mon1', patch: { status: 'failed' } }),
    ]
    expect(hasRunningBackgroundTasks(events)).toBe(false)
  })

  it('Bash background task: full lifecycle with task:notification', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('input:sent', { text: 'run build' }),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm build', run_in_background: true } }]),
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash', description: 'pnpm build' }),
      makeEvent('result', { blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'Output is being written to: /tmp/bg.output' }] }),
      makeContentEvent([{ type: 'text', text: "Build is running in the background" }]),
      makeEvent('turn:end'),
    ]
    expect(hasRunningBackgroundTasks(events)).toBe(true)

    // Task completes
    events.push(makeEvent('task:notification', { taskId: 'bg1' }))
    expect(hasRunningBackgroundTasks(events)).toBe(false)
  })

  it('multiple tasks: one fails, one completes — no running tasks remain', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:started', { taskId: 'bg2', toolUseId: 't2', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'failed' } }),
      makeEvent('task:notification', { taskId: 'bg2' }),
    ]
    expect(hasRunningBackgroundTasks(events)).toBe(false)
  })

  it('run:end clears tasks even without explicit completion events', () => {
    // If the process exits, all tasks are dead regardless of their status
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:started', { taskId: 'bg2', toolUseId: 't2', taskType: 'local_bash' }),
      makeEvent('run:end', { code: 1, reason: 'crash' }),
    ]
    expect(hasRunningBackgroundTasks(events)).toBe(false)
    expect(deriveBackgroundTasks(events).size).toBe(0)
  })
})

describe('hasRunningBackgroundTasks', () => {
  it('returns false for no events', () => {
    expect(hasRunningBackgroundTasks([])).toBe(false)
  })

  it('returns true when a task is started but not completed', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
    ]
    expect(hasRunningBackgroundTasks(events)).toBe(true)
  })

  it('returns false when all tasks are completed', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'completed' } }),
    ]
    expect(hasRunningBackgroundTasks(events)).toBe(false)
  })

  it('returns false when task fails (any terminal status clears running)', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'failed' } }),
    ]
    expect(hasRunningBackgroundTasks(events)).toBe(false)
  })

  it('returns true when one of multiple tasks is still running', () => {
    const events = [
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:started', { taskId: 'bg2', toolUseId: 't2', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'completed' } }),
    ]
    expect(hasRunningBackgroundTasks(events)).toBe(true)
  })

  it('returns false when only agent tasks are running (not bash)', () => {
    const events = [
      makeEvent('task:started', { taskId: 'agent1', toolUseId: 't1', taskType: 'local_agent' }),
      makeEvent('task:started', { taskId: 'agent2', toolUseId: 't2', taskType: 'local_agent' }),
    ]
    expect(hasRunningBackgroundTasks(events)).toBe(false)
  })
})

describe('derivePlanOutcomes', () => {
  it('returns empty record for empty events', () => {
    expect(derivePlanOutcomes([])).toEqual({})
  })

  it('returns approved when ExitPlanMode is followed by input:sent with normal text', () => {
    const events = [
      makeContentEvent([{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: {} }]),
      makeEvent('input:sent', { text: 'looks good, go ahead' }),
    ]
    expect(derivePlanOutcomes(events)).toEqual({ 'plan-1': 'approved' })
  })

  it('returns rejected when input:sent contains "reject"', () => {
    const events = [
      makeContentEvent([{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: {} }]),
      makeEvent('input:sent', { text: 'I reject this plan' }),
    ]
    expect(derivePlanOutcomes(events)).toEqual({ 'plan-1': 'rejected' })
  })

  it('returns rejected when input:sent contains "revise"', () => {
    const events = [
      makeContentEvent([{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: {} }]),
      makeEvent('input:sent', { text: 'please revise step 3' }),
    ]
    expect(derivePlanOutcomes(events)).toEqual({ 'plan-1': 'rejected' })
  })

  it('omits plans with no subsequent input:sent (still pending)', () => {
    const events = [
      makeContentEvent([{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: {} }]),
    ]
    expect(derivePlanOutcomes(events)).toEqual({})
  })

  it('tracks multiple ExitPlanMode blocks independently', () => {
    const events = [
      makeContentEvent([{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: {} }]),
      makeEvent('input:sent', { text: 'approved' }),
      makeContentEvent([{ type: 'tool_use', id: 'plan-2', name: 'exit_plan_mode', input: {} }]),
      makeEvent('input:sent', { text: 'reject this one' }),
    ]
    expect(derivePlanOutcomes(events)).toEqual({
      'plan-1': 'approved',
      'plan-2': 'rejected',
    })
  })

  it('skips result events between ExitPlanMode and input:sent', () => {
    const events = [
      makeContentEvent([{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: {} }]),
      makeEvent('result', { blocks: [{ type: 'tool_result', tool_use_id: 'plan-1', content: 'ok' }] }),
      makeEvent('input:sent', { text: 'looks great' }),
    ]
    expect(derivePlanOutcomes(events)).toEqual({ 'plan-1': 'approved' })
  })

  it('skips task:* events between ExitPlanMode and input:sent', () => {
    const events = [
      makeContentEvent([{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: {} }]),
      makeEvent('result', { blocks: [{ type: 'tool_result', tool_use_id: 'plan-1', content: 'ok' }] }),
      makeEvent('task:started', { taskId: 'bg1', toolUseId: 't1', taskType: 'local_bash' }),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'completed' } }),
      makeEvent('task:notification', { taskId: 'bg1' }),
      makeEvent('input:sent', { text: 'revise the approach' }),
    ]
    expect(derivePlanOutcomes(events)).toEqual({ 'plan-1': 'rejected' })
  })

  it('handles exit_plan_mode (snake_case variant)', () => {
    const events = [
      makeContentEvent([{ type: 'tool_use', id: 'plan-1', name: 'exit_plan_mode', input: {} }]),
      makeEvent('input:sent', { text: 'yes' }),
    ]
    expect(derivePlanOutcomes(events)).toEqual({ 'plan-1': 'approved' })
  })
})

describe('deriveUsage', () => {
  it('returns null for empty events', () => {
    expect(deriveUsage([])).toBeNull()
  })

  it('returns null when no turn:end has usage', () => {
    const events = [
      makeEvent('run:start'),
      makeContentEvent([{ type: 'text', text: 'hi' }]),
    ]
    expect(deriveUsage(events)).toBeNull()
  })

  it('extracts usage from turn:end event', () => {
    const events = [
      makeEvent('run:start'),
      makeContentEvent([{ type: 'text', text: 'hi' }]),
      makeEvent('turn:end', {
        usage: { input_tokens: 250, output_tokens: 180, cache_creation_input_tokens: 0, cache_read_input_tokens: 20626 },
        duration: 4236,
        costUsd: 0.29,
      }),
    ]
    expect(deriveUsage(events)).toEqual({
      inputTokens: 250,
      outputTokens: 180,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 20626,
      costUsd: 0.29,
    })
  })

  it('returns the most recent turn usage in a multi-turn session', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('input:sent', { text: 'first' }),
      makeEvent('run:ready'),
      makeContentEvent([{ type: 'text', text: 'response 1' }]),
      makeEvent('turn:end', {
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 },
        costUsd: 0.05,
      }),
      makeEvent('input:sent', { text: 'second' }),
      makeContentEvent([{ type: 'text', text: 'response 2' }]),
      makeEvent('turn:end', {
        usage: { input_tokens: 300, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 },
        costUsd: 0.15,
      }),
    ]
    expect(deriveUsage(events)).toEqual({
      inputTokens: 300,
      outputTokens: 120,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 5000,
      costUsd: 0.15,
    })
  })

  it('skips compact_boundary turn:end events (no usage)', () => {
    const events = [
      makeEvent('run:start'),
      makeContentEvent([{ type: 'text', text: 'hi' }]),
      makeEvent('turn:end', {
        usage: { input_tokens: 250, output_tokens: 180 },
        costUsd: 0.10,
      }),
      // Compact boundary has no usage
      makeEvent('turn:end', { compact: true, trigger: 'manual' }),
    ]
    const usage = deriveUsage(events)
    expect(usage).not.toBeNull()
    expect(usage!.inputTokens).toBe(250)
    expect(usage!.outputTokens).toBe(180)
  })

  it('uses compact postTokens until a later content event reports context usage', () => {
    const before = makeEvent('content', {
      blocks: [{ type: 'text', text: 'before compact' }],
      apiUsage: {
        input_tokens: 300,
        output_tokens: 20,
        cache_creation_input_tokens: 20_000,
        cache_read_input_tokens: 140_000,
      },
    })
    const boundary = makeEvent('turn:end', {
      compact: true,
      trigger: 'manual',
      preTokens: 160_300,
      postTokens: 14_949,
    })

    expect(deriveUsage([before, boundary])?.contextTokens).toBe(14_949)

    const after = makeEvent('content', {
      blocks: [{ type: 'text', text: 'after compact' }],
      apiUsage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 15_000,
        cache_read_input_tokens: 1_000,
      },
    })
    expect(deriveUsage([before, boundary, after])?.contextTokens).toBe(16_010)
  })

  it('defaults missing cache fields to 0', () => {
    const events = [
      makeEvent('turn:end', {
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ]
    const usage = deriveUsage(events)!
    expect(usage.cacheCreationInputTokens).toBe(0)
    expect(usage.cacheReadInputTokens).toBe(0)
    expect(usage.costUsd).toBeUndefined()
  })

  it('derives contextTokens from the last content event with apiUsage', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('content', {
        blocks: [{ type: 'text', text: 'first iteration' }],
        apiUsage: { input_tokens: 3, output_tokens: 50, cache_creation_input_tokens: 25000, cache_read_input_tokens: 0 },
      }),
      makeEvent('content', {
        blocks: [{ type: 'text', text: 'second iteration' }],
        apiUsage: { input_tokens: 1, output_tokens: 80, cache_creation_input_tokens: 2000, cache_read_input_tokens: 36000 },
      }),
      makeEvent('turn:end', {
        usage: { input_tokens: 4, output_tokens: 130, cache_creation_input_tokens: 27000, cache_read_input_tokens: 36000 },
        costUsd: 0.10,
      }),
    ]
    const usage = deriveUsage(events)!
    // contextTokens should be from the LAST content event's apiUsage (the actual context window size)
    // = 1 + 2000 + 36000 = 38001
    expect(usage.contextTokens).toBe(38001)
    // turn:end totals should still be the per-turn sums
    expect(usage.inputTokens).toBe(4)
    expect(usage.outputTokens).toBe(130)
    expect(usage.costUsd).toBe(0.10)
  })

  it('contextTokens is undefined when no content events have apiUsage', () => {
    const events = [
      makeEvent('run:start'),
      makeContentEvent([{ type: 'text', text: 'hi' }]),
      makeEvent('turn:end', {
        usage: { input_tokens: 250, output_tokens: 180 },
        costUsd: 0.10,
      }),
    ]
    const usage = deriveUsage(events)!
    expect(usage.contextTokens).toBeUndefined()
    // Falls back to old behavior — per-turn totals still work
    expect(usage.inputTokens).toBe(250)
  })

  it('returns contextTokens mid-turn before turn:end arrives', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('content', {
        blocks: [{ type: 'text', text: 'thinking...' }],
        apiUsage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 42000 },
      }),
    ]
    const usage = deriveUsage(events)!
    // No turn:end yet, but contextTokens available from content event
    expect(usage.contextTokens).toBe(42005)
    // Per-turn fields default to 0
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
  })

  it('contextTokens uses the last content event across multiple turns', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('content', {
        blocks: [{ type: 'text', text: 'turn 1 response' }],
        apiUsage: { input_tokens: 3, output_tokens: 200, cache_creation_input_tokens: 25000, cache_read_input_tokens: 0 },
      }),
      makeEvent('turn:end', {
        usage: { input_tokens: 3, output_tokens: 200, cache_creation_input_tokens: 25000, cache_read_input_tokens: 0 },
        costUsd: 0.05,
      }),
      makeEvent('input:sent', { text: 'follow up' }),
      makeEvent('content', {
        blocks: [{ type: 'text', text: 'turn 2 response' }],
        apiUsage: { input_tokens: 1, output_tokens: 150, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000 },
      }),
      makeEvent('turn:end', {
        usage: { input_tokens: 1, output_tokens: 150, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000 },
        costUsd: 0.12,
      }),
    ]
    const usage = deriveUsage(events)!
    // contextTokens from turn 2's content: 1 + 3000 + 40000 = 43001
    expect(usage.contextTokens).toBe(43001)
    // turn:end from turn 2
    expect(usage.costUsd).toBe(0.12)
  })
})

describe('deriveScheduledWakeup', () => {
  const scheduleWakeupContent = (overrides?: Partial<{ delaySeconds: number; prompt: string; reason: string }>) =>
    makeContentEvent([
      { type: 'text', text: "I'll check back soon." },
      {
        type: 'tool_use',
        id: 'toolu_wakeup',
        name: 'ScheduleWakeup',
        input: {
          delaySeconds: overrides?.delaySeconds ?? 120,
          prompt: overrides?.prompt ?? 'Check the build',
          reason: overrides?.reason ?? 'Checking build progress',
        },
      },
    ])

  it('returns wakeup info when idle after a ScheduleWakeup turn', () => {
    const events = [
      makeEvent('run:start'),
      makeEvent('input:sent', { text: 'run the build' }),
      makeEvent('run:ready', { resumeId: 'abc' }),
      scheduleWakeupContent(),
      makeEvent('result', { blocks: [{ type: 'tool_result', tool_use_id: 'toolu_wakeup', content: 'Wakeup scheduled.' }] }),
      makeEvent('turn:end'),
    ]
    const wakeup = deriveScheduledWakeup(events)
    expect(wakeup).not.toBeNull()
    expect(wakeup!.delaySecs).toBe(120)
    expect(wakeup!.prompt).toBe('Check the build')
    expect(wakeup!.reason).toBe('Checking build progress')
  })

  it('computes expectedAt from turn:end timestamp + delay', () => {
    const turnEndTs = 1700000000000
    const events = [
      makeEvent('run:ready', { resumeId: 'abc' }),
      scheduleWakeupContent(),
      makeEvent('turn:end', {}, { timestamp: turnEndTs }),
    ]
    const wakeup = deriveScheduledWakeup(events)!
    expect(wakeup.expectedAt).toBe(turnEndTs + 120 * 1000)
  })

  it('returns null when session is not idle (streaming)', () => {
    const events = [
      makeEvent('run:ready', { resumeId: 'abc' }),
      scheduleWakeupContent(),
      // No turn:end — still streaming
    ]
    expect(deriveScheduledWakeup(events)).toBeNull()
  })

  it('returns null when session resumed after ScheduleWakeup (user sent message)', () => {
    const events = [
      makeEvent('run:ready', { resumeId: 'abc' }),
      scheduleWakeupContent(),
      makeEvent('turn:end'),
      makeEvent('input:sent', { text: 'where are we?' }),
    ]
    expect(deriveScheduledWakeup(events)).toBeNull()
  })

  it('returns null when turn did not contain ScheduleWakeup', () => {
    const events = [
      makeEvent('run:ready', { resumeId: 'abc' }),
      makeContentEvent([{ type: 'text', text: 'Hello!' }]),
      makeEvent('turn:end'),
    ]
    expect(deriveScheduledWakeup(events)).toBeNull()
  })

  it('returns null for empty events', () => {
    expect(deriveScheduledWakeup([])).toBeNull()
  })

  it('ignores background task events after turn:end', () => {
    const events = [
      makeEvent('run:ready', { resumeId: 'abc' }),
      scheduleWakeupContent(),
      makeEvent('turn:end'),
      makeEvent('task:updated', { taskId: 'bg1', patch: { status: 'running' } }),
    ]
    const wakeup = deriveScheduledWakeup(events)
    expect(wakeup).not.toBeNull()
    expect(wakeup!.delaySecs).toBe(120)
  })

  it('returns null after process exit', () => {
    const events = [
      makeEvent('run:ready', { resumeId: 'abc' }),
      scheduleWakeupContent(),
      makeEvent('turn:end'),
      makeEvent('run:end', { code: 0, reason: 'completed' }),
    ]
    expect(deriveScheduledWakeup(events)).toBeNull()
  })
})
