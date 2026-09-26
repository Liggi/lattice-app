import type { SessionEvent, ContentBlock, ContentData, InputSentData, ToolUseBlock, TaskStartedData, TaskUpdatedData, TaskNotificationData, TurnEndData, ApiUsage, LostTask, ResultData } from './events.js'

// ---- Status ----

export type Status = 'idle' | 'starting' | 'streaming' | 'stopping'

export function deriveStatus(events: readonly SessionEvent[]): Status {
  for (let i = events.length - 1; i >= 0; i--) {
    switch (events[i].type) {
      case 'run:end':
      case 'run:error':
      case 'turn:end':
        return 'idle'
      case 'stop:requested':
        return 'stopping'
      case 'content':
      case 'result':
        // Subagent output is not the foreground turn. An Agent/Workflow launched
        // with run_in_background returns its tool_result immediately, so the main
        // thread can reach turn:end while the subagent keeps writing content and
        // result events into this same log. Counting those as foreground activity
        // pins the session to 'streaming' for the whole life of the background
        // agent, which is what the session status endpoint maps to 'ongoing' and
        // the sidebar renders as "Working" — while the agent is in fact waiting
        // on the user. Skipping them lands the walk on the real turn:end, and
        // `derivePendingWork` (orchestrator) then reports the subagent, so the
        // session reads "Waiting on" instead.
        //
        // A foreground subagent still reads 'streaming': skipping its events
        // lands the walk on the main thread's own content event, the one holding
        // the Agent tool_use block.
        //
        // Legacy events predate parentToolUseId and are absent from this check,
        // so they keep the old behaviour rather than gaining a new wrong one.
        if ((events[i].data as { parentToolUseId?: string | null } | undefined)?.parentToolUseId != null) continue
        return 'streaming'
      case 'input:sent':
        // During a fresh spawn, input:sent is recorded before the CLI boots
        // (it's the prompt being passed to the process, not actual user input
        // during an active session). Check whether run:ready has been seen
        // since the last run:start — if not, the CLI hasn't booted and we're
        // still in the starting/spawning phase.
        for (let j = i - 1; j >= 0; j--) {
          if (events[j].type === 'run:ready') return 'streaming'
          if (events[j].type === 'run:start') return 'starting'
        }
        return 'streaming'
      case 'run:ready':
        // During a fresh spawn, run:ready means "CLI just booted" — but if
        // input:sent was already recorded (the prompt), the CLI is about to
        // process it. Return streaming so there's no idle flash between
        // spawning and the first content event.
        for (let j = i - 1; j >= 0; j--) {
          if (events[j].type === 'input:sent') return 'streaming'
          if (events[j].type === 'turn:end' || events[j].type === 'run:end') return 'idle'
          if (events[j].type === 'run:start') return 'idle'
        }
        return 'idle'
      case 'run:start':
        return 'starting'
      case 'context:compaction':
        // Compaction lifecycle is informational. Keep walking so it cannot
        // accidentally start or finish an agent turn.
        continue
    }
  }
  return 'idle'
}

// ---- Activity ----

export type Activity =
  | { type: 'thinking' }
  | { type: 'tool'; name: string; input?: unknown }
  | null

// ---- Process liveness ----

/**
 * Derives whether the CLI process is alive from the event log.
 *
 * This is distinct from `deriveStatus` which tracks what the process is *doing*.
 * A process can be idle (between turns) but still alive in keep-alive mode.
 * `deriveStatus` returns 'idle' for both `turn:end` (alive) and `run:end` (dead).
 * This function distinguishes the two.
 */
export function deriveProcessAlive(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    switch (events[i].type) {
      case 'run:end':
      case 'run:error':
        return false
      case 'run:start':
      case 'run:ready':
      case 'content':
      case 'result':
      case 'input:sent':
      case 'turn:end':
      case 'stop:requested':
      case 'task:started':
      case 'task:updated':
      case 'task:notification':
      case 'context:compaction':
        return true
    }
  }
  return false
}

// ---- Token usage ----

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  /** Cumulative session cost in USD (from CLI result event). */
  costUsd?: number
  /** Total prompt tokens from the most recent API call — the actual context window size. */
  contextTokens?: number
}

/**
 * Derives token usage from the event log.
 *
 * - Per-turn totals (inputTokens, outputTokens, etc.) come from the last
 *   `turn:end` event — these are summed across all agentic iterations
 *   within that turn.
 * - `contextTokens` comes from the newest authoritative context measurement:
 *   either a compact boundary's postTokens or the last content event carrying
 *   apiUsage. A later model call naturally supersedes a prior compact result.
 */
export function deriveUsage(events: readonly SessionEvent[]): TurnUsage | null {
  let turnUsage: TurnUsage | null = null
  let contextTokens: number | undefined

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]

    // Per-turn totals from turn:end
    if (!turnUsage && e.type === 'turn:end') {
      const data = e.data as TurnEndData
      if (data.usage) {
        turnUsage = {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
          cacheCreationInputTokens: data.usage.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: data.usage.cache_read_input_tokens ?? 0,
          costUsd: data.costUsd,
        }
      }
    }

    // A successful compaction boundary is the newest authoritative context
    // size until another provider call reports apiUsage. Without this, the UI
    // keeps showing the pre-compact count immediately after compaction.
    if (contextTokens === undefined && e.type === 'turn:end') {
      const data = e.data as TurnEndData
      if (data.compact && typeof data.postTokens === 'number') {
        contextTokens = data.postTokens
      }
    }

    // Context window size from the last content event with apiUsage
    if (contextTokens === undefined && e.type === 'content') {
      const data = e.data as ContentData
      if (data.apiUsage) {
        contextTokens =
          (data.apiUsage.input_tokens ?? 0) +
          (data.apiUsage.cache_creation_input_tokens ?? 0) +
          (data.apiUsage.cache_read_input_tokens ?? 0)
      }
    }

    if (turnUsage && contextTokens !== undefined) break
  }

  if (turnUsage) {
    turnUsage.contextTokens = contextTokens
    return turnUsage
  }

  // No turn:end yet (mid-turn) — return context tokens if available
  if (contextTokens !== undefined) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens,
    }
  }

  return null
}

// ---- Background tasks ----

export interface BackgroundTask {
  taskId: string
  toolUseId: string
  description?: string
  taskType: string
  status: 'running' | 'completed'
}

/**
 * Derives the set of background tasks from the event log.
 * Returns a map of taskId → BackgroundTask with current status.
 */
export function deriveBackgroundTasks(events: readonly SessionEvent[]): Map<string, BackgroundTask> {
  const tasks = new Map<string, BackgroundTask>()
  for (const e of events) {
    // Process boundaries invalidate all running tasks. run:end/run:error mean
    // the process died. run:start means a NEW process spawned — if the previous
    // process died without a terminal event (server killed mid-run), its tasks
    // are untrackable: the channel that would deliver task:updated died with it.
    if (e.type === 'run:end' || e.type === 'run:error' || e.type === 'run:start') {
      tasks.clear()
      continue
    }
    if (e.type === 'task:started') {
      const d = e.data as TaskStartedData
      // Only track bash background tasks — agent tasks (local_agent) have their
      // own lifecycle and rendering via TaskTool.
      if (d.taskType !== 'local_bash') continue
      tasks.set(d.taskId, {
        taskId: d.taskId,
        toolUseId: d.toolUseId,
        description: d.description,
        taskType: d.taskType,
        status: 'running',
      })
    } else if (e.type === 'task:updated') {
      const d = e.data as TaskUpdatedData
      const task = tasks.get(d.taskId)
      if (!task) continue
      // Any terminal status means the task is done. Only 'running' keeps it alive.
      // This covers 'completed', 'failed', 'error', 'cancelled', etc.
      if (d.patch.status !== 'running') {
        task.status = 'completed'
      }
    } else if (e.type === 'task:notification') {
      // task_notification also signals completion
      const d = e.data as TaskNotificationData
      const task = tasks.get(d.taskId)
      if (task) task.status = 'completed'
    }
  }
  return tasks
}

/**
 * Background tasks still running in the current process: started since the
 * last process boundary, handed back to the turn, and not yet reported
 * finished. This is what is lost if that process goes away without a word.
 *
 * Claude reports a task for a foreground tool call too (a plain Bash, a
 * foreground Agent), whose tool_result arrives only when it finishes. One cut
 * off before its result is part of the cut-off turn, not a background task,
 * and listing it as one told the woken agent a command that had done its work
 * was lost (conv-4hOSFR87a94G, 2026-09-26: the Bash that restarted the server).
 * A background task's tool_result comes back as soon as it starts.
 */
export function deriveUnfinishedTasks(events: readonly SessionEvent[]): LostTask[] {
  const running = new Map<string, LostTask & { toolUseId: string }>()
  const returned = new Set<string>()
  for (const e of events) {
    if (e.type === 'run:end' || e.type === 'run:error' || e.type === 'run:start') {
      running.clear()
      returned.clear()
    } else if (e.type === 'result') {
      for (const block of (e.data as ResultData).blocks ?? []) {
        if (block.type === 'tool_result') returned.add(block.tool_use_id)
      }
    } else if (e.type === 'task:started') {
      const d = e.data as TaskStartedData
      running.set(d.taskId, {
        taskId: d.taskId,
        toolUseId: d.toolUseId,
        taskType: d.taskType,
        ...(d.description ? { description: d.description } : {}),
      })
    } else if (e.type === 'task:updated') {
      const d = e.data as TaskUpdatedData
      if (d.patch?.status !== 'running') running.delete(d.taskId)
    } else if (e.type === 'task:notification') {
      running.delete((e.data as TaskNotificationData).taskId)
    }
  }
  return [...running.values()]
    .filter((task) => returned.has(task.toolUseId))
    .map(({ toolUseId: _toolUseId, ...task }) => task)
}

export type BackgroundTaskState = 'running' | 'finished' | 'lost'

/**
 * What each background task's tool call came to, keyed by the toolUseId that
 * started it. A task still running when its process ends (a run boundary) is
 * lost: nothing is left to report its result.
 */
export function deriveBackgroundTaskStates(events: readonly SessionEvent[]): Record<string, BackgroundTaskState> {
  const states: Record<string, BackgroundTaskState> = {}
  const running = new Map<string, string>() // taskId → toolUseId
  for (const e of events) {
    if (e.type === 'run:end' || e.type === 'run:error' || e.type === 'run:start') {
      for (const toolUseId of running.values()) states[toolUseId] = 'lost'
      running.clear()
    } else if (e.type === 'task:started') {
      const d = e.data as TaskStartedData
      running.set(d.taskId, d.toolUseId)
      states[d.toolUseId] = 'running'
    } else if (e.type === 'task:updated' || e.type === 'task:notification') {
      const taskId = (e.data as TaskNotificationData).taskId
      if (e.type === 'task:updated' && (e.data as TaskUpdatedData).patch?.status === 'running') continue
      const toolUseId = running.get(taskId)
      if (toolUseId === undefined) continue
      states[toolUseId] = 'finished'
      running.delete(taskId)
    }
  }
  return states
}

/**
 * Returns true if any background task is still running.
 */
export function hasRunningBackgroundTasks(events: readonly SessionEvent[]): boolean {
  const tasks = deriveBackgroundTasks(events)
  for (const task of tasks.values()) {
    if (task.status === 'running') return true
  }
  return false
}

// ---- Scheduled wakeup ----

export interface DerivedScheduledWakeup {
  prompt: string
  reason: string
  delaySecs: number
  /** Epoch ms when the wakeup is expected to fire (turn:end timestamp + delay). */
  expectedAt: number
}

/**
 * Derives whether a scheduled wakeup is pending from the event log.
 * Returns the wakeup info if the session is idle after a turn that contained
 * a ScheduleWakeup tool call, or null otherwise.
 */
export function deriveScheduledWakeup(events: readonly SessionEvent[]): DerivedScheduledWakeup | null {
  // Phase 1: confirm the session is idle after a turn by finding the most
  // recent turn:end as the last significant event (ignoring background task events).
  let turnEndIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type
    if (t === 'task:updated' || t === 'task:notification' || t === 'task:started') continue
    if (t === 'turn:end') { turnEndIdx = i; break }
    return null
  }
  if (turnEndIdx < 0) return null

  const turnEndTimestamp = events[turnEndIdx].timestamp

  // Phase 2: scan backward through this turn for a ScheduleWakeup tool_use.
  for (let i = turnEndIdx - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'turn:end' || e.type === 'input:sent' || e.type === 'run:start'
      || e.type === 'run:ready' || e.type === 'run:end' || e.type === 'run:error') break

    if (e.type !== 'content') continue
    const data = e.data as ContentData
    if (!data.blocks) continue
    for (const block of data.blocks) {
      if (block.type !== 'tool_use') continue
      const toolUse = block as ToolUseBlock
      if (toolUse.name !== 'ScheduleWakeup') continue
      const input = toolUse.input as { delaySeconds?: number; prompt?: string; reason?: string }
      if (!input.delaySeconds || !input.prompt) continue
      return {
        prompt: input.prompt,
        reason: input.reason ?? '',
        delaySecs: input.delaySeconds,
        expectedAt: turnEndTimestamp + input.delaySeconds * 1000,
      }
    }
  }

  return null
}

// ---- Plan outcomes ----

/**
 * Derives historical plan outcomes for each ExitPlanMode tool_use_id by scanning
 * the event log. Returns a map so each plan card gets its own outcome.
 *
 * Logic: for each `content` event containing an ExitPlanMode tool_use block,
 * find the next `input:sent` event (skipping `result` and `task:*` events).
 * If the input text contains "reject" or "revise", the outcome is 'rejected';
 * otherwise 'approved'. Plans with no subsequent input:sent are omitted (still pending).
 */
export function derivePlanOutcomes(events: readonly SessionEvent[]): Record<string, 'approved' | 'rejected'> {
  const outcomes: Record<string, 'approved' | 'rejected'> = {}

  // Collect ExitPlanMode tool_use ids with their event index
  const exitPlanIds: Array<{ toolUseId: string; index: number }> = []

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.type !== 'content') continue
    const blocks = (e.data as ContentData).blocks
    if (!blocks) continue
    for (const block of blocks) {
      if (
        block.type === 'tool_use' &&
        ((block as ToolUseBlock).name === 'ExitPlanMode' || (block as ToolUseBlock).name === 'exit_plan_mode')
      ) {
        exitPlanIds.push({ toolUseId: (block as ToolUseBlock).id, index: i })
      }
    }
  }

  // For each ExitPlanMode, find the next input:sent event (skip result and task:* events)
  for (const { toolUseId, index } of exitPlanIds) {
    for (let j = index + 1; j < events.length; j++) {
      const e = events[j]
      // Skip result and task events — they aren't user input
      if (e.type === 'result' || e.type.startsWith('task:')) continue
      // Only input:sent counts as user input
      if (e.type !== 'input:sent') continue

      const text = (e.data as InputSentData).text ?? ''
      const lower = text.toLowerCase()
      outcomes[toolUseId] = (lower.includes('reject') || lower.includes('revise'))
        ? 'rejected'
        : 'approved'
      break
    }
  }

  return outcomes
}

// ---- Activity ----

export function deriveActivity(events: readonly SessionEvent[]): Activity {
  const status = deriveStatus(events)
  if (status !== 'streaming') return null

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'content') {
      const blocks = (e.data as { blocks?: ContentBlock[] }).blocks
      if (!blocks || blocks.length === 0) continue
      const lastBlock = blocks[blocks.length - 1]
      if (lastBlock.type === 'thinking') return { type: 'thinking' }
      if (lastBlock.type === 'tool_use')
        return { type: 'tool', name: lastBlock.name, input: lastBlock.input }
    }
    if (e.type === 'turn:end') return null
  }
  return null
}
