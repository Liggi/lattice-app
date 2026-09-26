import type { ContentBlock, ResultBlock } from '../protocol/events.js'

export interface NormalizedEvent {
  type: string
  data: unknown
}

/**
 * System subtypes the CLI emits that the harness deliberately does not turn
 * into harness events. Listed explicitly so callers can tell "we decided to
 * drop this" apart from "we did not recognise this" and keep unknown-event
 * warnings meaningful.
 *
 * `thinking_tokens` is a per-delta estimate of extended-thinking token usage,
 * emitted every couple of tokens while the model thinks — thousands per turn.
 * Nothing in the protocol consumes it, and admitting it to the event log would
 * swamp storage and SSE with counter updates.
 *
 * `hook_started` / `hook_response` announce the CLI running the user's own
 * hooks; `task_progress` is the Task tool's in-flight progress note. All
 * three are informational chatter with no protocol mapping — a busy agentic
 * session emitted dozens a day, each logged as an unknown-event WARN.
 *
 * `commands_changed` re-announces the full slash-command list (every skill
 * with its whole description — ~15KB) whenever skills reload mid-session.
 * Nothing in the protocol consumes it, and one event dumped the entire list
 * into the server log as a single WARN line.
 */
const IGNORED_SYSTEM_SUBTYPES = new Set<string>([
  'thinking_tokens',
  'hook_started',
  'hook_response',
  'task_progress',
  'commands_changed',
])

/**
 * Top-level (non-system) CLI event types deliberately not normalized.
 * `rate_limit_event` reports quota status on every turn; nothing in the
 * protocol consumes it. `control_response` acknowledges a stdin control
 * request such as an interrupt, whose effect arrives as ordinary events.
 */
const IGNORED_EVENT_TYPES = new Set<string>([
  'rate_limit_event',
  'control_response',
])

/**
 * True when normalizeClaude returned null on purpose rather than because the
 * event was unrecognised. Lets callers stay loud about genuinely unknown
 * events while staying quiet about known-benign ones.
 */
export function isIgnoredClaudeEvent(raw: unknown): boolean {
  if (raw == null || typeof raw !== 'object') return false
  const msg = raw as Record<string, unknown>
  if (typeof msg.type === 'string' && IGNORED_EVENT_TYPES.has(msg.type)) return true
  if (msg.type !== 'system') return false
  return typeof msg.subtype === 'string' && IGNORED_SYSTEM_SUBTYPES.has(msg.subtype)
}

/**
 * Normalizes a raw Claude CLI stream-json event into a harness event.
 * Returns null for events that should be ignored (unknown types, non-init system events).
 */
export function normalizeClaude(raw: unknown): NormalizedEvent | null {
  if (raw == null || typeof raw !== 'object') return null

  const msg = raw as Record<string, unknown>

  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        return {
          type: 'run:ready',
          data: {
            resumeId: msg.session_id as string,
            model: msg.model as string | undefined,
            tools: msg.tools as unknown[] | undefined,
            cwd: msg.cwd as string | undefined,
            mcpServers: msg.mcp_servers as unknown[] | undefined,
            permissionMode: msg.permissionMode as string | undefined,
          },
        }
      }
      if (msg.subtype === 'status') {
        if (msg.status === 'compacting') {
          return {
            type: 'context:compaction',
            data: { phase: 'started' },
          }
        }

        if (typeof msg.compact_result === 'string') {
          const result = msg.compact_result
          if (result === 'success') {
            return {
              type: 'context:compaction',
              data: { phase: 'completed', result },
            }
          }

          const error = compactFailureMessage(msg)
          return {
            type: 'context:compaction',
            data: {
              phase: 'failed',
              result,
              ...(error ? { error } : {}),
            },
          }
        }
      }
      if (msg.subtype === 'compact_boundary') {
        const metadata = compactMetadata(msg)
        const preTokens = numberField(metadata, 'pre_tokens', 'preTokens')
        const postTokens = numberField(metadata, 'post_tokens', 'postTokens')
        const durationMs = numberField(metadata, 'duration_ms', 'durationMs')
        const costUsd =
          numberField(metadata, 'cost_usd', 'costUsd', 'total_cost_usd') ??
          numberField(msg, 'cost_usd', 'costUsd', 'total_cost_usd')
        return {
          type: 'turn:end',
          data: {
            compact: true,
            ...(metadata.trigger !== undefined ? { trigger: metadata.trigger } : {}),
            ...(preTokens !== undefined ? { preTokens } : {}),
            ...(postTokens !== undefined ? { postTokens } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
          },
        }
      }
      if (msg.subtype === 'task_started') {
        return {
          type: 'task:started',
          data: {
            taskId: msg.task_id as string,
            toolUseId: msg.tool_use_id as string,
            description: msg.description as string | undefined,
            taskType: msg.task_type as string,
          },
        }
      }
      if (msg.subtype === 'task_updated') {
        return {
          type: 'task:updated',
          data: {
            taskId: msg.task_id as string,
            patch: msg.patch as { status: string; end_time?: number },
          },
        }
      }
      if (msg.subtype === 'task_notification') {
        return {
          type: 'task:notification',
          data: {
            taskId: msg.task_id as string,
          },
        }
      }
      return null
    }

    case 'assistant': {
      const message = msg.message as Record<string, unknown> | undefined
      if (!message) return null
      const content = message.content as unknown[] | undefined
      if (!content) return null
      const usage = message.usage as Record<string, unknown> | undefined
      return {
        type: 'content',
        data: {
          blocks: normalizeContentBlocks(content),
          messageId: message.id as string | undefined,
          parentToolUseId: (msg.parent_tool_use_id as string) ?? null,
          ...(typeof message.model === 'string' ? { model: message.model } : {}),
          ...(usage ? {
            apiUsage: {
              input_tokens: (usage.input_tokens as number) ?? 0,
              output_tokens: (usage.output_tokens as number) ?? 0,
              cache_creation_input_tokens: (usage.cache_creation_input_tokens as number) ?? 0,
              cache_read_input_tokens: (usage.cache_read_input_tokens as number) ?? 0,
            },
          } : {}),
        },
      }
    }

    case 'user': {
      const message = msg.message as Record<string, unknown> | undefined
      if (!message) return null
      const content = message.content as unknown[] | undefined
      if (!content) return null
      return {
        type: 'result',
        data: {
          blocks: normalizeResultBlocks(content),
          parentToolUseId: (msg.parent_tool_use_id as string) ?? null,
        },
      }
    }

    case 'result': {
      return {
        type: 'turn:end',
        data: {
          usage: msg.usage as Record<string, unknown> | undefined,
          duration: msg.duration_ms as number | undefined,
          costUsd: msg.total_cost_usd as number | undefined,
          ...(msg.is_error === true ? { error: turnError(msg) } : {}),
        },
      }
    }

    default:
      return null
  }
}

function turnError(msg: Record<string, unknown>): { message: string; reason?: string } {
  const message = typeof msg.result === 'string' && msg.result.trim() !== ''
    ? msg.result
    : typeof msg.subtype === 'string' ? msg.subtype : 'error'
  const reason = typeof msg.terminal_reason === 'string' ? msg.terminal_reason : undefined
  return reason ? { message, reason } : { message }
}

function compactMetadata(msg: Record<string, unknown>): Record<string, unknown> {
  const value = msg.compact_metadata ?? msg.compactMetadata
  return value != null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
}

function numberField(
  value: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'number') return value[key]
  }
  return undefined
}

function compactFailureMessage(msg: Record<string, unknown>): string | undefined {
  for (const candidate of [msg.compact_error, msg.error, msg.message]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
    if (candidate != null && typeof candidate === 'object') {
      const message = (candidate as Record<string, unknown>).message
      if (typeof message === 'string' && message.length > 0) return message
    }
  }
  return undefined
}

function normalizeContentBlocks(blocks: unknown[]): ContentBlock[] {
  const result: ContentBlock[] = []
  for (const block of blocks) {
    if (block == null || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    switch (b.type) {
      case 'text':
        result.push({ type: 'text', text: b.text as string })
        break
      case 'thinking':
        result.push({ type: 'thinking', thinking: b.thinking as string })
        break
      case 'tool_use':
        result.push({
          type: 'tool_use',
          id: b.id as string,
          name: b.name as string,
          input: b.input,
        })
        break
      // Unknown block types are silently dropped
    }
  }
  return result
}

function normalizeResultBlocks(blocks: unknown[]): ResultBlock[] {
  const result: ResultBlock[] = []
  for (const block of blocks) {
    if (block == null || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'tool_result') {
      result.push({
        type: 'tool_result',
        tool_use_id: b.tool_use_id as string,
        content: b.content as string | unknown[],
        ...(b.is_error ? { is_error: true } : {}),
      })
    }
  }
  return result
}
