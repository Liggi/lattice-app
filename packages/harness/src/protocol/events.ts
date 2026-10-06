// ---- Content block types ----

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | unknown[]
  is_error?: boolean
}

export interface Base64Source {
  type: 'base64'
  media_type: string
  data: string
}

export interface ImageBlock {
  type: 'image'
  source: Base64Source
}

export interface DocumentBlock {
  type: 'document'
  source: Base64Source
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock
export type ResultBlock = ToolResultBlock

/** Blocks a user's input can carry alongside (or instead of) typed text —
 *  pasted images, attached documents, inlined file contents. Structural on
 *  purpose: the harness depends on no provider SDK, and these mirror the
 *  content-block shape adapters already write to the CLI's stdin. */
export type AttachmentBlock = ImageBlock | DocumentBlock | TextBlock

/** Key under which callers put attachment blocks in the `extra` bag threaded
 *  through `SessionManager.send(sessionId, input, extra)` and `SpawnConfig.extra`.
 *  Adapters read it to build the provider message; SessionManager copies it onto
 *  the `input:sent` event so UIs can render what the user attached. */
export const ATTACHMENTS_EXTRA_KEY = 'attachments'

function isBase64Source(value: unknown): value is Base64Source {
  if (typeof value !== 'object' || value === null) return false
  const source = value as Record<string, unknown>
  return (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string' &&
    source.data.length > 0
  )
}

/**
 * Read well-formed attachment blocks out of an `extra` bag.
 *
 * Structural, not exhaustive: the harness validates only enough to keep
 * malformed input off the event log. Consumers that care about which media
 * types their provider accepts validate that themselves — the SessionManager
 * has no opinion on it.
 */
export function attachmentBlocksFromExtra(
  extra: Record<string, unknown> | undefined,
): AttachmentBlock[] {
  const raw = extra?.[ATTACHMENTS_EXTRA_KEY]
  if (!Array.isArray(raw)) return []

  const blocks: AttachmentBlock[] = []
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const block = candidate as Record<string, unknown>

    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) {
        blocks.push({ type: 'text', text: block.text })
      }
      continue
    }

    if ((block.type === 'image' || block.type === 'document') && isBase64Source(block.source)) {
      blocks.push({ type: block.type, source: block.source })
    }
  }
  return blocks
}

/** A stretch of an input's text that the user pasted, so a UI can show it
 *  closed instead of inline. Counted back from the end of the text: whatever a
 *  server puts in front of the user's words (a preamble, restored context)
 *  leaves it pointing at the same characters. Display only; the provider gets
 *  the text unchanged. */
export interface PastedSpan {
  /** How many characters before the end of the text the paste begins. */
  fromEnd: number
  length: number
}

/** Key under which callers put `PastedSpan[]` in the `extra` bag, alongside
 *  `ATTACHMENTS_EXTRA_KEY`. SessionManager copies it onto `input:sent`. */
export const PASTES_EXTRA_KEY = 'pastes'

/**
 * Validate pasted spans against the text they describe. Missing is no spans;
 * anything present must be in order, inside the text and not overlapping, or
 * it is an error rather than a span quietly pointing at the wrong words.
 */
export function parsePastedSpans(
  value: unknown,
  textLength: number,
): { ok: true; spans: PastedSpan[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, spans: [] }
  if (!Array.isArray(value)) return { ok: false, error: 'pastes must be an array' }
  const spans: PastedSpan[] = []
  let previousFromEnd = Infinity
  for (let i = 0; i < value.length; i++) {
    const raw = value[i] as Record<string, unknown> | null
    const fromEnd = raw?.fromEnd
    const length = raw?.length
    if (!Number.isInteger(fromEnd) || !Number.isInteger(length) || (length as number) <= 0) {
      return { ok: false, error: `pastes[${i}] must have whole-number fromEnd and a positive length` }
    }
    const span = { fromEnd: fromEnd as number, length: length as number }
    if (span.fromEnd > textLength || span.length > span.fromEnd) {
      return { ok: false, error: `pastes[${i}] runs outside the ${textLength}-character text` }
    }
    if (span.fromEnd > previousFromEnd) {
      return { ok: false, error: `pastes[${i}] is out of order or overlaps the one before it` }
    }
    previousFromEnd = span.fromEnd - span.length
    spans.push(span)
  }
  return { ok: true, spans }
}

/** Pasted spans out of an `extra` bag; callers validate them first (`parsePastedSpans`). */
export function pastedSpansFromExtra(extra: Record<string, unknown> | undefined): PastedSpan[] {
  const raw = extra?.[PASTES_EXTRA_KEY]
  return Array.isArray(raw) ? (raw as PastedSpan[]) : []
}

// ---- Event payloads ----

export interface RunStartData {
  config: Record<string, unknown>
}

export interface RunReadyData {
  resumeId: string
  model?: string
  tools?: unknown[]
  cwd?: string
  mcpServers?: unknown[]
  permissionMode?: string
}

export type RunEndReason =
  | 'completed'
  | 'stopped'
  | 'interrupted'
  | 'error'
  | 'process_exit'
  | 'idle_timeout'
  | 'server_restart'
  /** The process went away without saying so (its daemon stopped, or it
   *  belonged to a server that has since restarted); tasks it was running
   *  are listed in `lostTasks`. */
  | 'process_lost'

export interface RunEndData {
  reason: RunEndReason
  code?: number | null
  signal?: string | null
  /** Tasks still running when the process was lost; their results will not arrive. */
  lostTasks?: LostTask[]
}

export interface LostTask {
  taskId: string
  taskType: string
  description?: string
}

export interface RunErrorData {
  message: string
  code?: string
  signal?: string
}

export interface ApiUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface ContentData {
  blocks: ContentBlock[]
  /** Per-API-call token usage from the Claude assistant message. */
  apiUsage?: ApiUsage
  /** Model that actually served this assistant message — may differ from the
   *  run:ready model when the provider falls back (e.g. Fable → Opus). */
  model?: string
}

export interface ResultData {
  blocks: ResultBlock[]
}

export interface TurnError {
  /** The provider's own text for the failure, as it showed it in the thread. */
  message: string
  /** The provider's machine reason when it gives one, such as Claude's `api_error`. */
  reason?: string
}

export interface TurnEndData {
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  duration?: number
  costUsd?: number
  /** The provider ended the turn on an error: a usage limit, a sign-in failure, an API error. */
  error?: TurnError
  /** Present on compact_boundary turn:end events */
  compact?: boolean
  trigger?: unknown
  /** Context size immediately before compaction, when supplied by the provider. */
  preTokens?: number
  /** Context size immediately after compaction, when supplied by the provider. */
  postTokens?: number
  /** Time spent compacting, distinct from the enclosing turn duration. */
  durationMs?: number
}

export type ContextCompactionPhase = 'started' | 'completed' | 'failed'

/**
 * Provider-neutral lifecycle for context compaction.
 *
 * This event is informational: it lets a UI show and clear transient compacting
 * state without pretending compaction starts or ends an agent turn. Providers
 * may emit a separate compact `turn:end` carrying the durable boundary and
 * before/after metrics.
 */
export interface ContextCompactionData {
  phase: ContextCompactionPhase
  /** Raw terminal result when the provider supplies one (for example, "success"). */
  result?: string
  /** Human-readable failure detail when the provider supplies one. */
  error?: string
}

export interface InputSentData {
  text: string
  /** Where this input originated. Omitted (or 'user') for normal user messages. */
  source?: 'user' | 'scheduled_wakeup' | 'command'
  /** Attachments that rode with this input, copied from the `extra` bag passed
   *  to `SessionManager.send()` / `SpawnConfig.extra` (see ATTACHMENTS_EXTRA_KEY).
   *  Present only when the caller supplied them, so text-only input keeps its
   *  existing payload shape. UIs render these alongside `text`; the provider
   *  itself receives them via the adapter, not from this event. */
  blocks?: AttachmentBlock[]
  /** The stretches of `text` the user pasted (`PASTES_EXTRA_KEY`); absent when none. */
  pastes?: PastedSpan[]
}

// ---- Background task payloads ----

export interface TaskStartedData {
  taskId: string
  toolUseId: string
  description?: string
  taskType: string
}

export interface TaskUpdatedData {
  taskId: string
  patch: {
    status: string
    end_time?: number
  }
}

export interface TaskNotificationData {
  taskId: string
}

// ---- Event types ----

export const EVENT_TYPES = [
  'run:start',
  'run:ready',
  'run:end',
  'run:error',
  'stop:requested',
  'content',
  'result',
  'turn:end',
  'context:compaction',
  'input:sent',
  'task:started',
  'task:updated',
  'task:notification',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

// ---- SessionEvent ----

export interface SessionEventMeta {
  pid?: number
  latency?: number
  rawType?: string
  /** True when the event was synthesized by the harness/server rather
   *  than emitted by the underlying provider process. */
  inferred?: boolean
  /** Where the event originated. Lets reducers and diagnostics tell
   *  recovery-injected events apart from real provider output. */
  source?: 'provider' | 'daemon' | 'harness' | 'recovery' | 'test'
}

export interface SessionEvent {
  sessionId: string
  runId: string
  seq: number
  timestamp: number
  type: EventType
  data: unknown
  meta?: SessionEventMeta
}
