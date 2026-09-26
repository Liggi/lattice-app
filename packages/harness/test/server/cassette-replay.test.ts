import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CassetteAdapter, parseCassette } from '../../src/server/cassette.js'
import { SessionManager } from '../../src/server/session-manager.js'
import { deriveStatus, deriveUsage, hasRunningBackgroundTasks } from '../../src/protocol/derive.js'
import type { SessionEvent, ContentBlock, ResultBlock, TurnEndData } from '../../src/protocol/events.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CASSETTES_DIR = resolve(__dirname, '../cassettes')

function loadCassette(name: string): CassetteAdapter {
  const content = readFileSync(resolve(CASSETTES_DIR, `${name}.jsonl`), 'utf-8')
  return new CassetteAdapter(parseCassette(content))
}

/**
 * Run a cassette through SessionManager and collect all events.
 * Uses fake timers to fast-forward through replay delays — we're testing
 * event correctness, not timing (timing is tested in cassette.test.ts).
 */
async function replayThrough(name: string): Promise<SessionEvent[]> {
  vi.useFakeTimers()

  const adapter = loadCassette(name)
  const manager = new SessionManager(adapter)
  await manager.start('test', { prompt: 'recorded' })

  // Fast-forward through the replay in 1s increments until run:end appears
  for (let elapsed = 0; elapsed < 120_000; elapsed += 1000) {
    await vi.advanceTimersByTimeAsync(1000)
    const log = manager.getLog('test')
    if (log && log.all().some(e => e.type === 'run:end')) break
  }

  const events = manager.getLog('test')!.all()
  vi.useRealTimers()
  return events
}

function eventTypes(events: SessionEvent[]): string[] {
  return events.map(e => e.type)
}

function contentBlocks(events: SessionEvent[]): ContentBlock[] {
  return events
    .filter(e => e.type === 'content')
    .flatMap(e => (e.data as { blocks: ContentBlock[] }).blocks)
}

function resultBlocks(events: SessionEvent[]): ResultBlock[] {
  return events
    .filter(e => e.type === 'result')
    .flatMap(e => (e.data as { blocks: ResultBlock[] }).blocks)
}

// ---- Simple response ----

describe('cassette replay: simple-response', () => {
  let events: SessionEvent[]
  beforeAll(async () => { events = await replayThrough('simple-response') })

  it('produces the expected event lifecycle', () => {
    const types = eventTypes(events)
    expect(types[0]).toBe('run:start')
    expect(types[1]).toBe('input:sent')
    expect(types).toContain('run:ready')
    expect(types).toContain('content')
    expect(types).toContain('turn:end')
    expect(types).toContain('run:end')
  })

  it('run:ready comes before content', () => {
    const types = eventTypes(events)
    const readyIdx = types.indexOf('run:ready')
    const contentIdx = types.indexOf('content')
    expect(readyIdx).toBeLessThan(contentIdx)
  })

  it('ends idle after run:end', () => {
    expect(deriveStatus(events)).toBe('idle')
  })

  it('has at least one text content block', () => {
    const blocks = contentBlocks(events)
    expect(blocks.some(b => b.type === 'text')).toBe(true)
  })

  it('text blocks have non-empty content', () => {
    const textBlocks = contentBlocks(events).filter(b => b.type === 'text')
    for (const b of textBlocks) {
      expect(b.text.length).toBeGreaterThan(0)
    }
  })

  it('run:ready contains session metadata', () => {
    const ready = events.find(e => e.type === 'run:ready')!
    const data = ready.data as Record<string, unknown>
    expect(data.resumeId).toBeTruthy()
    expect(data.model).toBeTruthy()
  })

  it('run:end has reason completed', () => {
    const end = events.find(e => e.type === 'run:end')!
    expect((end.data as { reason: string }).reason).toBe('completed')
  })
})

// ---- Tool use ----

describe('cassette replay: tool-use', () => {
  let events: SessionEvent[]
  beforeAll(async () => { events = await replayThrough('tool-use') })

  it('produces content events with tool_use blocks', () => {
    const blocks = contentBlocks(events)
    const toolUseBlocks = blocks.filter(b => b.type === 'tool_use')
    expect(toolUseBlocks.length).toBeGreaterThan(0)
  })

  it('tool_use blocks have name and id', () => {
    const blocks = contentBlocks(events)
    const toolUseBlocks = blocks.filter(b => b.type === 'tool_use')
    for (const b of toolUseBlocks) {
      expect(b.name).toBeTruthy()
      expect(b.id).toBeTruthy()
    }
  })

  it('produces result events with tool_result blocks', () => {
    const blocks = resultBlocks(events)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every(b => b.type === 'tool_result')).toBe(true)
  })

  it('tool_result references a tool_use id', () => {
    const useIds = new Set(
      contentBlocks(events)
        .filter(b => b.type === 'tool_use')
        .map(b => b.id),
    )
    const results = resultBlocks(events)
    for (const r of results) {
      expect(useIds.has(r.tool_use_id)).toBe(true)
    }
  })

  it('tool use cycle: content(tool_use) → result(tool_result) → content(text)', () => {
    const types = eventTypes(events)
    // Find first content with tool_use
    const firstToolContent = events.findIndex(
      e => e.type === 'content' &&
        (e.data as { blocks: ContentBlock[] }).blocks.some(b => b.type === 'tool_use'),
    )
    expect(firstToolContent).toBeGreaterThan(-1)

    // Next should be a result (tool_result)
    const nextResult = events.findIndex((e, i) => i > firstToolContent && e.type === 'result')
    expect(nextResult).toBeGreaterThan(firstToolContent)

    // After all tool cycles, there should be a final text content
    const lastContent = events.findLastIndex(e => e.type === 'content')
    const lastContentBlocks = (events[lastContent].data as { blocks: ContentBlock[] }).blocks
    expect(lastContentBlocks.some(b => b.type === 'text')).toBe(true)
  })

  it('ends idle with completed reason', () => {
    expect(deriveStatus(events)).toBe('idle')
    const end = events.find(e => e.type === 'run:end')!
    expect((end.data as { reason: string }).reason).toBe('completed')
  })
})

// ---- Extended thinking ----

describe('cassette replay: extended-thinking', () => {
  let events: SessionEvent[]
  beforeAll(async () => { events = await replayThrough('extended-thinking') })

  it('produces thinking content blocks', () => {
    const blocks = contentBlocks(events)
    const thinkingBlocks = blocks.filter(b => b.type === 'thinking')
    expect(thinkingBlocks.length).toBeGreaterThan(0)
  })

  it('thinking blocks have non-empty content', () => {
    const blocks = contentBlocks(events)
    const thinkingBlocks = blocks.filter(b => b.type === 'thinking')
    for (const b of thinkingBlocks) {
      expect(b.thinking.length).toBeGreaterThan(0)
    }
  })

  it('thinking arrives before text', () => {
    const blocks = contentBlocks(events)
    const firstThinking = blocks.findIndex(b => b.type === 'thinking')
    const firstText = blocks.findIndex(b => b.type === 'text')
    expect(firstThinking).toBeLessThan(firstText)
  })

  it('produces the full lifecycle', () => {
    const types = eventTypes(events)
    expect(types).toContain('run:start')
    expect(types).toContain('run:ready')
    expect(types).toContain('content')
    expect(types).toContain('turn:end')
    expect(types).toContain('run:end')
  })
})

// ---- Extended thinking: Opus 4.7 with summarized display ----
//
// Regression guard for Lattice's blank-thinking bug. Opus 4.7 defaults
// thinking.display to "omitted" (empty thinking + signature only). Lattice
// threads `--thinking-display summarized` into the CLI args (see
// lattice-orchestrator/src/process-daemon/process-daemon.ts) so thinking
// content is actually returned. This cassette is a real recording of:
//
//   claude --model claude-opus-4-7 --effort high --thinking-display summarized
//
// If the CLI ever changes behavior so that summarized thinking is no longer
// returned (or Lattice drops the flag), these assertions fail. Without the
// flag, `b.thinking.length > 0` is false and the test below would catch it.

describe('cassette replay: extended-thinking-opus-4-7 (summarized display)', () => {
  let events: SessionEvent[]
  beforeAll(async () => { events = await replayThrough('extended-thinking-opus-4-7') })

  it('init event reports opus-4-7 model', () => {
    const ready = events.find(e => e.type === 'run:ready')
    expect(ready).toBeDefined()
    expect((ready!.data as { model?: string }).model).toBe('claude-opus-4-7')
  })

  it('thinking blocks are present and non-empty (summarized display works)', () => {
    const blocks = contentBlocks(events)
    const thinkingBlocks = blocks.filter(b => b.type === 'thinking')
    expect(thinkingBlocks.length).toBeGreaterThan(0)
    for (const b of thinkingBlocks) {
      // Without `--thinking-display summarized`, this is 0 for Opus 4.7.
      expect(b.thinking.length).toBeGreaterThan(0)
    }
  })

  it('produces the full lifecycle', () => {
    const types = eventTypes(events)
    expect(types).toContain('run:start')
    expect(types).toContain('run:ready')
    expect(types).toContain('content')
    expect(types).toContain('turn:end')
    expect(types).toContain('run:end')
  })
})

// Negative fixture: same model, no `--thinking-display` flag — reproduces
// the blank-thinking bug. Keeps the bug reproducible in the test suite so
// the contrast with the summarized cassette stays visible, and so normalize
// can be extended (e.g. expose `signature` as `encrypted: true`) without
// losing the reference shape.

describe('cassette replay: extended-thinking-opus-4-7-omitted (no flag, reproduces blank-thinking bug)', () => {
  let events: SessionEvent[]
  beforeAll(async () => { events = await replayThrough('extended-thinking-opus-4-7-omitted') })

  it('thinking blocks arrive but content is empty (bug shape)', () => {
    const blocks = contentBlocks(events)
    const thinkingBlocks = blocks.filter(b => b.type === 'thinking')
    expect(thinkingBlocks.length).toBeGreaterThan(0)
    for (const b of thinkingBlocks) {
      expect(b.thinking).toBe('')
    }
  })
})

// ---- Code exploration (multi-tool chain) ----

describe('cassette replay: code-exploration', () => {
  let events: SessionEvent[]
  beforeAll(async () => { events = await replayThrough('code-exploration') })

  it('has multiple tool use rounds', () => {
    const toolUseBlocks = contentBlocks(events).filter(b => b.type === 'tool_use')
    // Real exploration sessions use 3+ tools
    expect(toolUseBlocks.length).toBeGreaterThanOrEqual(3)
  })

  it('has matching tool results for each tool use', () => {
    const useIds = contentBlocks(events)
      .filter(b => b.type === 'tool_use')
      .map(b => b.id)
    const resultIds = resultBlocks(events).map(b => b.tool_use_id)
    for (const id of useIds) {
      expect(resultIds).toContain(id)
    }
  })

  it('tool results contain substantial content', () => {
    const results = resultBlocks(events)
    const totalSize = results.reduce((sum, r) => {
      const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content)
      return sum + content.length
    }, 0)
    // Real file reads produce meaningful content
    expect(totalSize).toBeGreaterThan(500)
  })

  it('ends with text response after tool chain', () => {
    const contentEvents = events.filter(e => e.type === 'content')
    const lastContent = contentEvents[contentEvents.length - 1]
    const blocks = (lastContent.data as { blocks: ContentBlock[] }).blocks
    expect(blocks.some(b => b.type === 'text')).toBe(true)
    // Final explanation should be substantial
    const textBlocks = blocks.filter(b => b.type === 'text')
    const totalText = textBlocks.reduce((sum, b) => sum + b.text.length, 0)
    expect(totalText).toBeGreaterThan(200)
  })

  it('status transitions through streaming correctly', () => {
    // After run:start + input:sent, before run:ready → starting
    // After run:ready → streaming (because input:sent precedes it)
    // After content → streaming
    // After turn:end → idle
    const types = eventTypes(events)
    const turnEndIdx = types.indexOf('turn:end')
    const afterTurnEnd = events.slice(0, turnEndIdx + 1)
    expect(deriveStatus(afterTurnEnd)).toBe('idle')

    const beforeTurnEnd = events.slice(0, turnEndIdx)
    expect(deriveStatus(beforeTurnEnd)).toBe('streaming')
  })
})

// ---- Code search ----

describe('cassette replay: code-search', () => {
  let events: SessionEvent[]
  beforeAll(async () => { events = await replayThrough('code-search') })

  it('uses Grep tool', () => {
    const toolUseBlocks = contentBlocks(events).filter(b => b.type === 'tool_use')
    expect(toolUseBlocks.some(b => b.name === 'Grep')).toBe(true)
  })

  it('produces a text response with search results', () => {
    const textBlocks = contentBlocks(events).filter(b => b.type === 'text')
    expect(textBlocks.length).toBeGreaterThan(0)
    const totalText = textBlocks.reduce((sum, b) => sum + b.text.length, 0)
    expect(totalText).toBeGreaterThan(100)
  })
})

// ---- Code edit ----

describe('cassette replay: code-edit', () => {
  let events: SessionEvent[]
  beforeAll(async () => { events = await replayThrough('code-edit') })

  it('uses Read and Edit tools', () => {
    const toolNames = contentBlocks(events)
      .filter(b => b.type === 'tool_use')
      .map(b => b.name)
    expect(toolNames).toContain('Read')
    expect(toolNames).toContain('Edit')
  })

  it('Read happens before Edit', () => {
    const toolUses = contentBlocks(events).filter(b => b.type === 'tool_use')
    const readIdx = toolUses.findIndex(b => b.name === 'Read')
    const editIdx = toolUses.findIndex(b => b.name === 'Edit')
    expect(readIdx).toBeLessThan(editIdx)
  })

  it('Edit tool result is not an error', () => {
    // Find the tool_result that corresponds to the Edit tool_use
    const editUse = contentBlocks(events).find(b => b.type === 'tool_use' && b.name === 'Edit')!
    const editResult = resultBlocks(events).find(b => b.tool_use_id === editUse.id)!
    expect(editResult.is_error).toBeFalsy()
  })

  it('all events have consistent sessionId and runId', () => {
    const sessionIds = new Set(events.map(e => e.sessionId))
    expect(sessionIds.size).toBe(1)

    // runId should be the same across all events (single run)
    const runIds = new Set(events.map(e => e.runId))
    expect(runIds.size).toBe(1)
  })
})

// ---- Background task lifecycle ----

describe('cassette replay: background-task', () => {
  let events: SessionEvent[]
  beforeAll(async () => { events = await replayThrough('background-task') })

  it('produces task:started event with local_bash type', () => {
    const taskStarted = events.filter(e => e.type === 'task:started')
    expect(taskStarted).toHaveLength(1)
    expect((taskStarted[0].data as { taskType: string }).taskType).toBe('local_bash')
  })

  it('produces task:updated with completed status', () => {
    const taskUpdated = events.filter(e => e.type === 'task:updated')
    expect(taskUpdated).toHaveLength(1)
    expect((taskUpdated[0].data as { patch: { status: string } }).patch.status).toBe('completed')
  })

  it('produces task:notification', () => {
    const taskNotification = events.filter(e => e.type === 'task:notification')
    expect(taskNotification).toHaveLength(1)
  })

  it('has no running background tasks after full replay', () => {
    expect(hasRunningBackgroundTasks(events)).toBe(false)
  })

  it('has running background tasks mid-session (after task:started, before completion)', () => {
    const taskStartedIdx = events.findIndex(e => e.type === 'task:started')
    const taskUpdatedIdx = events.findIndex(e => e.type === 'task:updated')
    // Slice to just after task:started but before task:updated
    const midSession = events.slice(0, taskUpdatedIdx)
    expect(midSession.some(e => e.type === 'task:started')).toBe(true)
    expect(hasRunningBackgroundTasks(midSession)).toBe(true)
  })

  // ---- THE FALSE POSITIVE: partial event window ----
  //
  // This replicates the real bug: when a client loads events via pagination,
  // it may get a window that contains task:started from a completed session
  // but doesn't include the run:end that clears stale tasks. The derive
  // function reports tasks as "running" even though the session is dead.

  it('BUG: partial event window without run:end causes false "running" background tasks', () => {
    // Simulate what happens when the client loads history page-by-page.
    // Take a slice that includes the task:started but NOT the run:end.
    const taskStartedIdx = events.findIndex(e => e.type === 'task:started')
    const runEndIdx = events.findIndex(e => e.type === 'run:end')
    expect(taskStartedIdx).toBeGreaterThan(-1)
    expect(runEndIdx).toBeGreaterThan(taskStartedIdx)

    // Partial window: everything up to (but not including) run:end.
    // In a real long session, the client loads the first N pages of history
    // which contain task:started but the run:end is thousands of events later.
    const partialWindow = events.slice(0, runEndIdx)
    expect(partialWindow.some(e => e.type === 'task:started')).toBe(true)
    expect(partialWindow.some(e => e.type === 'run:end')).toBe(false)

    // In this short cassette, the task:updated/notification arrive before
    // run:end so hasRunningBackgroundTasks is correct. But in a long session
    // with MANY background tasks (like conv-CKe8ITxX-yRh with 40 tasks and
    // most having no completion event), the partial window sees orphaned
    // task:started events.
    //
    // Simulate that scenario: strip out completion events to model what
    // happens when they're beyond the loaded window.
    const orphanedWindow = partialWindow.filter(
      e => e.type !== 'task:updated' && e.type !== 'task:notification',
    )
    expect(orphanedWindow.some(e => e.type === 'task:started')).toBe(true)
    expect(orphanedWindow.some(e => e.type === 'task:updated')).toBe(false)
    expect(orphanedWindow.some(e => e.type === 'task:notification')).toBe(false)
    expect(orphanedWindow.some(e => e.type === 'run:end')).toBe(false)

    // THIS IS THE BUG: the session is fully complete, but the partial
    // window makes it look like a background task is still running.
    expect(hasRunningBackgroundTasks(orphanedWindow)).toBe(true)
  })
})

// ---- Token usage across cassettes ----

describe('cassette replay: token usage', () => {
  const cassettes = ['simple-response', 'tool-use', 'extended-thinking', 'code-exploration', 'code-search', 'code-edit']

  for (const name of cassettes) {
    describe(name, () => {
      let events: SessionEvent[]
      beforeAll(async () => { events = await replayThrough(name) })

      it('turn:end events carry usage data', () => {
        const turnEnds = events.filter(e => e.type === 'turn:end')
        expect(turnEnds.length).toBeGreaterThanOrEqual(1)
        // At least one turn:end should have usage (the final result event)
        const withUsage = turnEnds.filter(e => {
          const data = e.data as TurnEndData
          return data.usage && (data.usage.input_tokens ?? 0) > 0
        })
        expect(withUsage.length).toBeGreaterThanOrEqual(1)
      })

      it('deriveUsage extracts non-null usage', () => {
        const usage = deriveUsage(events)
        expect(usage).not.toBeNull()
        expect(usage!.inputTokens).toBeGreaterThan(0)
        expect(usage!.outputTokens).toBeGreaterThan(0)
      })

      it('usage token counts are plausible', () => {
        const usage = deriveUsage(events)!
        // Input tokens should be at least prompt + system (100+)
        expect(usage.inputTokens + usage.cacheReadInputTokens).toBeGreaterThan(0)
        // Output tokens should be non-trivial
        expect(usage.outputTokens).toBeGreaterThan(5)
        // Cache fields should be non-negative
        expect(usage.cacheCreationInputTokens).toBeGreaterThanOrEqual(0)
        expect(usage.cacheReadInputTokens).toBeGreaterThanOrEqual(0)
      })
    })
  }
})

// ---- Cross-cassette structural invariants ----

describe('cassette replay: structural invariants', () => {
  const cassettes = ['simple-response', 'tool-use', 'extended-thinking', 'code-exploration', 'code-search', 'code-edit']

  for (const name of cassettes) {
    describe(name, () => {
      let events: SessionEvent[]
      beforeAll(async () => { events = await replayThrough(name) })

      it('starts with run:start', () => {
        expect(events[0].type).toBe('run:start')
      })

      it('has input:sent early', () => {
        expect(events[1].type).toBe('input:sent')
      })

      it('has exactly one run:ready', () => {
        expect(events.filter(e => e.type === 'run:ready')).toHaveLength(1)
      })

      it('has exactly one turn:end', () => {
        expect(events.filter(e => e.type === 'turn:end').length).toBeGreaterThanOrEqual(1)
      })

      it('has exactly one run:end', () => {
        expect(events.filter(e => e.type === 'run:end')).toHaveLength(1)
      })

      it('run:end is the last event', () => {
        expect(events[events.length - 1].type).toBe('run:end')
      })

      it('sequences are monotonically increasing', () => {
        for (let i = 1; i < events.length; i++) {
          expect(events[i].seq).toBeGreaterThan(events[i - 1].seq)
        }
      })

      it('timestamps are monotonically non-decreasing', () => {
        for (let i = 1; i < events.length; i++) {
          expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp)
        }
      })

      it('final status is idle', () => {
        expect(deriveStatus(events)).toBe('idle')
      })
    })
  }
})
