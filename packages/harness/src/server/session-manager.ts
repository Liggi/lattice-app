import { EventLog } from './event-log.js'
import { JsonLinesParser } from './json-lines-parser.js'
import { normalizeClaude, isIgnoredClaudeEvent } from './normalize-claude.js'
import { deriveStatus, deriveActivity, deriveUnfinishedTasks } from '../protocol/derive.js'
import type { Status, Activity } from '../protocol/derive.js'
import { ATTACHMENTS_EXTRA_KEY, attachmentBlocksFromExtra } from '../protocol/events.js'
import type { SessionEvent, EventType, RunReadyData, ContentData, ToolUseBlock, TaskStartedData, InputSentData } from '../protocol/events.js'
import type {
  ProcessAdapter,
  ProcessHandle,
  SpawnConfig,
  SteerOutcome,
  SteerRequest,
} from './process-adapter.js'
import type { EventStorageAdapter } from './event-storage.js'

// StartConfig is SpawnConfig — re-export with the original name for API compatibility
type StartConfig = SpawnConfig
export type { StartConfig }

// ---- Logger ----

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/** Return `config` without per-turn payload. Used for the copy we remember as
 *  lastConfig and the copy we write into run:start — see start(). */
function stripTransientTurnData(config: StartConfig): StartConfig {
  if (!config.extra) return config
  const extra = { ...config.extra }
  delete extra[ATTACHMENTS_EXTRA_KEY]
  delete extra.internalCommand
  delete extra.inputSource
  if (Object.keys(extra).length === Object.keys(config.extra).length) return config
  return { ...config, extra }
}

function inputSource(extra: Record<string, unknown> | undefined): InputSentData['source'] | undefined {
  return extra?.inputSource === 'command' ? 'command' : undefined
}

/** Read the model a config would spawn with: the `--model=` CLI arg for
 *  arg-driven providers, falling back to `extra.model` for adapter-driven
 *  providers (codex). Undefined when the config defers to the provider default. */
function configModel(config: StartConfig): string | undefined {
  for (const arg of config.args ?? []) {
    if (arg.startsWith('--model=')) return arg.slice('--model='.length)
  }
  return typeof config.extra?.model === 'string' ? config.extra.model : undefined
}

// ---- Session ----

/** Pending scheduled wakeup state. */
interface ScheduledWakeup {
  /** Active timer handle. Null once the timer has fired but delivery has
   *  been deferred (session was not idle at fire time); in that state the
   *  wake is "pending" and will be flushed on the next idle transition. */
  timer: ReturnType<typeof setTimeout> | null
  prompt: string
  reason: string
  delaySecs: number
  /** Epoch ms when the wakeup is expected to fire. */
  expectedAt: number
}

interface Session {
  log: EventLog
  process: ProcessHandle | null
  runId: string | null
  resumeId: string | null
  lastConfig: StartConfig | null
  /** Pending task:started events waiting for their tool_result to detect
   *  auto-backgrounded vs long-running-tool cases. Maps toolUseId → taskId. */
  pendingTaskToolUseIds: Map<string, string>
  /** Maps toolUseId → tool name from content events, for correlating with task:started.
   *  Used to distinguish auto-backgrounded commands (synthetic completion) from
   *  long-running tools like Monitor (no synthetic completion). */
  pendingToolUseNames: Map<string, string>
  /** Pending scheduled wakeup (from ScheduleWakeup tool call). */
  scheduledWakeup: ScheduledWakeup | null
}

// ---- Config ----

export interface FollowUpSpawnInfo {
  sessionId: string
  runId: string
  processId?: string
}

export interface SessionManagerOptions {
  logger?: Logger
  maxLogSize?: number
  /** Pluggable storage backend for event persistence. When provided,
   *  events survive server restarts and in-memory eviction. */
  storage?: EventStorageAdapter
  onEvent?: (event: SessionEvent) => void
  /** Fired when send() spawns a fresh process for a follow-up turn (the
   *  previous process had exited). Lets consumers update any external state
   *  keyed by processId — e.g. a registry mapping streamingId → conversation —
   *  that the initial start()'s return value seeded. Not fired for the first
   *  spawn or for stdin-write follow-ups against a still-alive process. */
  onFollowUpSpawn?: (info: FollowUpSpawnInfo) => void
}

// ---- Diagnostics ----

export interface ScheduledWakeupInfo {
  prompt: string
  reason: string
  delaySecs: number
  expectedAt: number
  /** True when the timer has already fired but delivery was deferred
   *  because the session was not idle. Will flush on next idle transition. */
  pending: boolean
}

export interface SessionDiagnostics {
  status: Status
  activity: Activity
  runId: string | null
  resumeId: string | null
  processAlive: boolean
  pid: number | undefined
  eventCount: number
  lastEventAt: number | null
  lastEventType: EventType | null
  subscriberCount: number
  scheduledWakeup: ScheduledWakeupInfo | null
}

// ---- Kill escalation timings ----

const SIGTERM_DELAY_MS = 3000
const SIGKILL_DELAY_MS = 5000

// ---- SessionManager ----

export class SessionManager {
  private sessions = new Map<string, Session>()
  private adapter: ProcessAdapter
  private logger: Logger
  private maxLogSize: number
  private storage: EventStorageAdapter | null
  private onEvent?: (event: SessionEvent) => void
  private onFollowUpSpawn?: (info: FollowUpSpawnInfo) => void

  constructor(adapter: ProcessAdapter, options?: SessionManagerOptions) {
    this.adapter = adapter
    this.logger = options?.logger ?? noopLogger
    this.maxLogSize = options?.maxLogSize ?? 2000
    this.storage = options?.storage ?? null
    this.onEvent = options?.onEvent
    this.onFollowUpSpawn = options?.onFollowUpSpawn
  }

  async start(sessionId: string, config: StartConfig): Promise<{ runId: string; processId?: string }> {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = {
        log: new EventLog({ maxSize: this.maxLogSize, storage: this.storage ?? undefined, sessionId }),
        process: null,
        runId: null,
        resumeId: null,
        lastConfig: null,
        pendingTaskToolUseIds: new Map(),
        pendingToolUseNames: new Map(),
        scheduledWakeup: null,
      }
      this.sessions.set(sessionId, session)
    }

    if (session.process?.alive) {
      const currentStatus = deriveStatus(session.log.all())
      if (currentStatus === 'idle') {
        // Process alive in keep-alive mode after turn completed — kill it before respawning
        this.logger.info('Killing idle keep-alive process before restart', { sessionId })
        session.process.signal('SIGTERM')
        await Promise.race([
          session.process.exited,
          new Promise(resolve => setTimeout(resolve, 5000)),
        ])
        session.process = null
      } else {
        throw new Error('Session already has an active process')
      }
    }

    const runId = crypto.randomUUID()
    session.runId = runId

    // Attachments are per-turn input, not session configuration. `config` still
    // carries them into spawn() below, but what we remember and what we log must
    // not: lastConfig is reused verbatim by a later attachment-less respawn
    // (which would replay a stale image), and run:start is persisted to storage
    // (where base64 payloads would bloat every session's event log).
    const rememberedConfig = stripTransientTurnData(config)
    session.lastConfig = rememberedConfig

    this.appendEvent(session, 'run:start', { config: rememberedConfig }, runId, sessionId)
    this.logger.info('Starting session', { sessionId, runId })

    let handle: ProcessHandle
    try {
      handle = await this.adapter.spawn(config)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.appendEvent(session, 'run:error', { message, code: 'SPAWN_FAILED' }, runId, sessionId)
      this.logger.error('Spawn failed', { sessionId, runId, error: message })
      throw err
    }

    session.process = handle
    this.logger.info('Process spawned', { sessionId, runId, pid: handle.pid })

    // Record the user's prompt after spawn succeeds (not before, so spawn
    // failures don't record phantom input). Attachments on the first turn come
    // in on config.extra — carry them onto the event so UIs can render what the
    // user attached, not just what they typed. A turn can be attachments-only,
    // so the guard covers both.
    const startBlocks = attachmentBlocksFromExtra(config.extra)
    if (config.prompt || startBlocks.length > 0) {
      const data: InputSentData = {
        text: config.prompt,
        ...(inputSource(config.extra) ? { source: inputSource(config.extra) } : {}),
        ...(startBlocks.length > 0 ? { blocks: startBlocks } : {}),
      }
      this.appendEvent(session, 'input:sent', data, runId, sessionId)
    }

    this.pipeEvents(session, handle, runId, sessionId)
    this.handleExit(session, handle, runId, sessionId)

    return { runId, processId: handle.processId }
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.process?.alive) return

    const status = deriveStatus(session.log.all())
    if (status === 'stopping') return

    this.cancelWakeup(session, sessionId)
    this.appendEvent(session, 'stop:requested', {}, session.runId!, sessionId)
    this.logger.info('Stop requested', { sessionId })

    const process = session.process

    // Escalating kill: SIGINT → (if unresponsive) SIGTERM → SIGKILL
    // SIGINT asks the CLI to cancel the current turn. If it responds (turn:end
    // → status becomes idle), the process stays alive for future messages.
    // Only escalate to SIGTERM/SIGKILL if the CLI doesn't respond in time.
    process.signal('SIGINT')
    this.logger.debug('Sent SIGINT', { sessionId })

    setTimeout(() => {
      if (!process.alive) return
      // If the CLI responded to SIGINT (turn:end arrived after stop:requested),
      // don't kill it — it's alive and ready for the next message.
      // We check for turn:end directly rather than deriveStatus because late-
      // arriving content events from the cancelled turn can make deriveStatus
      // return 'streaming' even though the turn already ended.
      const events = session.log.all()
      let stopIdx = -1
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'stop:requested') { stopIdx = i; break }
      }
      const turnEndAfterStop = stopIdx >= 0 && events.slice(stopIdx).some((e: { type: string }) => e.type === 'turn:end')
      if (turnEndAfterStop) {
        this.logger.debug('CLI responded to SIGINT (turn:end after stop:requested), skipping SIGTERM', { sessionId })
        return
      }
      process.signal('SIGTERM')
      this.logger.debug('Sent SIGTERM (escalation)', { sessionId })
      setTimeout(() => {
        if (process.alive) {
          process.signal('SIGKILL')
          this.logger.debug('Sent SIGKILL (final escalation)', { sessionId })
        }
      }, SIGKILL_DELAY_MS - SIGTERM_DELAY_MS)
    }, SIGTERM_DELAY_MS)
  }

  async send(sessionId: string, input: string, extra?: Record<string, unknown>): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown session')

    const status = deriveStatus(session.log.all())

    if (status === 'starting') {
      throw new Error('Cannot send while starting')
    }
    if (status === 'stopping') {
      throw new Error('Cannot send while stopping')
    }

    // Cancel any pending scheduled wakeup — user is taking over
    this.cancelWakeup(session, sessionId)

    // Mid-session model switch: a live process cannot change model, so a send
    // carrying a different extra.model forces the respawn-with-resume path
    // (start() gracefully retires an idle keep-alive process first). Only an
    // idle session switches — a mid-turn send still goes to stdin, and the
    // switch lands on a later idle send because clients keep sending the
    // selection until the serving model confirms it.
    const requestedModel = typeof extra?.model === 'string' ? extra.model : undefined
    const modelChanged = Boolean(
      requestedModel && session.lastConfig && requestedModel !== configModel(session.lastConfig),
    )

    if (status === 'idle' && (!session.process?.alive || modelChanged)) {
      if (!session.lastConfig) {
        throw new Error('Session config not available')
      }
      this.logger.info(
        modelChanged ? 'Respawning run for model switch' : 'Spawning new run for follow-up',
        { sessionId, ...(modelChanged ? { model: requestedModel } : {}) },
      )
      const config: StartConfig = {
        ...session.lastConfig,
        prompt: input,
        ...(session.resumeId ? { resume: session.resumeId } : {}),
        ...(extra ? { extra: { ...session.lastConfig.extra, ...extra } } : {}),
      }
      if (modelChanged && requestedModel) {
        config.args = [
          ...(config.args ?? []).filter((arg) => !arg.startsWith('--model=')),
          `--model=${requestedModel}`,
        ]
      }
      const result = await this.start(sessionId, config)
      this.onFollowUpSpawn?.({
        sessionId,
        runId: result.runId,
        processId: result.processId,
      })
      return
    }

    // Process alive — write to stdin
    session.process!.write(input + '\n', extra)
    const sendBlocks = attachmentBlocksFromExtra(extra)
    const data: InputSentData = {
      text: input,
      ...(sendBlocks.length > 0 ? { blocks: sendBlocks } : {}),
    }
    this.appendEvent(session, 'input:sent', data, session.runId!, sessionId)
    this.logger.info('Input sent', { sessionId, inputLength: input.length, attachments: sendBlocks.length })
  }

  /**
   * Deliver input into the turn a session is already running, and say what the
   * provider did with it.
   *
   * `send()` cannot serve this: it writes and returns, so its caller learns
   * nothing about whether the provider took the input. An urgent correction
   * needs that answer, because the only safe thing to do with an input the
   * provider may or may not hold is to leave it exactly where it is and
   * re-send nothing.
   *
   * Three outcomes, and the caller must treat them differently. `accepted`
   * means the provider acknowledged this exact `deliveryId`; `input:sent` is
   * appended so the thread shows the delivery. `rejected` means nothing was
   * delivered and the caller still owns the input. `uncertain` means the
   * handover happened but no acknowledgement came back — the caller must not
   * re-send, and must not mark it delivered either.
   *
   * An adapter with no `steer` is `rejected: 'unsupported'`, so a provider
   * without a native path simply has no urgent route and the caller queues.
   */
  async steer(sessionId: string, request: SteerRequest): Promise<SteerOutcome> {
    const session = this.sessions.get(sessionId)
    if (!session) return { status: 'rejected', reason: 'Unknown session' }

    const process = session.process
    if (!process?.alive) return { status: 'rejected', reason: 'Process is not running' }
    if (!process.steer) return { status: 'rejected', reason: 'Provider has no steering path' }

    const status = deriveStatus(session.log.all())
    if (status !== 'streaming') {
      return { status: 'rejected', reason: `Session is ${status}, so there is no running turn to steer` }
    }

    let outcome: SteerOutcome
    try {
      outcome = await process.steer(request)
    } catch (error) {
      // A throw from the adapter is not evidence that nothing was delivered.
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('Steer threw', { sessionId, error: message })
      return { status: 'uncertain', reason: `Steering threw: ${message}` }
    }

    if (outcome.status === 'accepted') {
      const sendBlocks = attachmentBlocksFromExtra(request.extra)
      const data: InputSentData = {
        text: request.input,
        ...(sendBlocks.length > 0 ? { blocks: sendBlocks } : {}),
      }
      const sent = this.appendEvent(session, 'input:sent', data, session.runId!, sessionId)
      this.logger.info('Steered into the running turn', {
        sessionId,
        deliveryId: request.deliveryId,
        inputLength: request.input.length,
      })
      // The caller pairs its own later receipt to this event by seq; it
      // cannot assume the newest `input:sent` is still this one, because a
      // steered message may only be taken into a turn well after other input
      // has been sent.
      return { ...outcome, sentSeq: sent.seq }
    } else {
      this.logger.info('Steer did not land', { sessionId, deliveryId: request.deliveryId, ...outcome })
    }
    return outcome
  }

  /**
   * Compact a session through the provider's native action when available.
   *
   * Claude exposes compaction as the `/compact` command, while providers such
   * as Codex expose a dedicated protocol method. The semantic action lives
   * here so product clients never need to send a fake user message or know
   * which transport is serving the session.
   */
  async compact(sessionId: string): Promise<void> {
    let session = this.sessions.get(sessionId)
    if (!session && this.recoverFromStorage(sessionId)) {
      session = this.sessions.get(sessionId)
    }
    if (!session) throw new Error('Unknown session')

    const status = deriveStatus(session.log.all())
    if (status !== 'idle') {
      throw new Error(`Cannot compact while session is ${status}`)
    }

    this.cancelWakeup(session, sessionId)

    if (session.process?.alive) {
      const data: InputSentData = { text: '/compact', source: 'command' }
      this.appendEvent(session, 'input:sent', data, session.runId!, sessionId)

      try {
        if (session.process.compact) {
          await session.process.compact()
        } else {
          session.process.write('/compact\n', {
            internalCommand: 'compact',
            inputSource: 'command',
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.appendEvent(
          session,
          'context:compaction',
          { phase: 'failed', error: message },
          session.runId!,
          sessionId,
        )
        // input:sent moved the derived state to streaming. Close this failed
        // internal turn so a rejected RPC cannot wedge the session there.
        this.appendEvent(session, 'turn:end', {}, session.runId!, sessionId)
        throw error
      }
      this.logger.info('Context compaction requested', { sessionId })
      return
    }

    if (!session.lastConfig) {
      throw new Error('Session config not available')
    }

    const config: StartConfig = {
      ...session.lastConfig,
      prompt: '/compact',
      ...(session.resumeId ? { resume: session.resumeId } : {}),
      extra: {
        ...session.lastConfig.extra,
        internalCommand: 'compact',
        inputSource: 'command',
      },
    }
    const result = await this.start(sessionId, config)
    this.onFollowUpSpawn?.({
      sessionId,
      runId: result.runId,
      processId: result.processId,
    })
  }

  getStatus(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return 'idle' as const
    return deriveStatus(session.log.all())
  }

  /**
   * Recover a session from storage after a server restart.
   * Creates an in-memory session with a storage-backed EventLog but no process.
   *
   * If the session was mid-stream when the server died, a synthetic `run:end`
   * is injected so the session derives as idle. We can't reconnect to a
   * running process after restart, so honest idle is better than a stuck
   * streaming indicator with no live event pipe.
   *
   * Returns the EventLog if recovery succeeded, null if no storage or no events.
   */
  recoverFromStorage(sessionId: string): EventLog | null {
    if (!this.storage) return null
    if (this.sessions.has(sessionId)) return this.sessions.get(sessionId)!.log

    const count = this.storage.count(sessionId)
    if (count === 0) return null

    const log = new EventLog({ maxSize: this.maxLogSize, storage: this.storage, sessionId })

    const tailEvents = this.storage.read(sessionId, {
      beforeSeq: Number.MAX_SAFE_INTEGER,
      limit: 50,
    })

    // resumeId comes from the latest run:ready in storage — queried directly
    // rather than scanned out of the tail window, because a long single turn
    // can bury run:ready below the 50-event limit. `pending-*` IDs are
    // placeholders, not real provider sessions, so they never count.
    let resumeId: string | null = null
    const latestReady = this.storage.findLatestRunReady(sessionId)
    if (latestReady) {
      const data = latestReady.data as { resumeId?: string }
      if (data.resumeId && !data.resumeId.startsWith('pending-')) {
        resumeId = data.resumeId
      }
    }

    // lastConfig is fine to derive from the tail: we only need the most
    // recent run:start, and that always sits at the end of the most recent
    // run cycle.
    let lastConfig: StartConfig | null = null
    for (let i = tailEvents.length - 1; i >= 0; i--) {
      if (tailEvents[i].type === 'run:start') {
        const data = tailEvents[i].data as { config?: StartConfig }
        if (data.config) {
          lastConfig = data.config
          break
        }
      }
    }

    // If the session was interrupted mid-stream, close it cleanly.
    const status = tailEvents.length > 0 ? deriveStatus(tailEvents) : 'idle'
    if (status !== 'idle') {
      const lastEvent = tailEvents[tailEvents.length - 1]
      log.append(
        'run:end',
        { reason: 'server_restart', code: null },
        lastEvent.runId,
        sessionId,
        { inferred: true, source: 'recovery' },
      )
      this.logger.info('Closed interrupted session on recovery', {
        sessionId,
        previousStatus: status,
      })
    }

    const session: Session = {
      log,
      process: null,
      runId: null,
      resumeId,
      lastConfig,
      pendingTaskToolUseIds: new Map(),
      pendingToolUseNames: new Map(),
      scheduledWakeup: null,
    }
    this.sessions.set(sessionId, session)
    this.logger.info('Recovered session from storage', { sessionId, count })
    return log
  }

  /** Return the EventLog for a session. */
  getLog(sessionId: string): EventLog | null {
    return this.sessions.get(sessionId)?.log ?? null
  }

  /** Read events directly from storage, bypassing in-memory sessions.
   *  Useful when the session doesn't exist in memory (server restarted)
   *  but events are persisted in the storage adapter. */
  readFromStorage(sessionId: string, opts?: {
    afterSeq?: number
    beforeSeq?: number
    limit?: number
  }): SessionEvent[] {
    return this.storage?.read(sessionId, opts) ?? []
  }

  /** Count events in storage for a session. */
  countInStorage(sessionId: string): number {
    return this.storage?.count(sessionId) ?? 0
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Return all tracked session IDs. */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys())
  }

  inspect(sessionId: string): SessionDiagnostics | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const events = session.log.all()
    return {
      status: deriveStatus(events),
      activity: deriveActivity(events),
      runId: session.runId,
      resumeId: session.resumeId,
      processAlive: session.process?.alive ?? false,
      pid: session.process?.pid,
      eventCount: session.log.length,
      lastEventAt: session.log.latest()?.timestamp ?? null,
      lastEventType: session.log.latest()?.type ?? null,
      subscriberCount: session.log.subscriberCount,
      scheduledWakeup: session.scheduledWakeup
        ? {
            prompt: session.scheduledWakeup.prompt,
            reason: session.scheduledWakeup.reason,
            delaySecs: session.scheduledWakeup.delaySecs,
            expectedAt: session.scheduledWakeup.expectedAt,
            pending: session.scheduledWakeup.timer === null,
          }
        : null,
    }
  }

  /**
   * Returns a promise that resolves with the run:ready data for a session.
   * Scans existing events first, then subscribes for new ones.
   * Rejects on timeout or run:error.
   */
  waitForReady(sessionId: string, timeoutMs = 180_000): Promise<RunReadyData> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.reject(new Error(`Unknown session: ${sessionId}`))

    // Check existing events first
    for (const event of session.log.all()) {
      if (event.type === 'run:ready') {
        return Promise.resolve(event.data as RunReadyData)
      }
    }

    return new Promise<RunReadyData>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null

      const unsub = session.log.subscribe((event) => {
        if (event.type === 'run:ready') {
          if (timer) clearTimeout(timer)
          unsub()
          resolve(event.data as RunReadyData)
        } else if (event.type === 'run:error') {
          if (timer) clearTimeout(timer)
          unsub()
          const data = event.data as { message?: string }
          reject(new Error(data.message ?? 'Session failed before ready'))
        }
      })

      timer = setTimeout(() => {
        unsub()
        reject(new Error(`waitForReady timed out after ${timeoutMs}ms for session ${sessionId}`))
      }, timeoutMs)
    })
  }

  signal(sessionId: string, sig: NodeJS.Signals): boolean {
    const session = this.sessions.get(sessionId)
    if (!session?.process?.alive) return false
    session.process.signal(sig)
    this.logger.info('Signal sent', { sessionId, signal: sig })
    return true
  }

  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.cancelWakeup(session, sessionId)
    if (session.process?.alive) {
      session.process.signal('SIGKILL')
      this.logger.info('Force-killed process on destroy', { sessionId })
    }
    this.sessions.delete(sessionId)
    this.logger.info('Session destroyed', { sessionId })
  }

  private appendEvent(
    session: Session,
    type: EventType,
    data: unknown,
    runId: string,
    sessionId: string,
    meta?: SessionEvent['meta'],
  ): SessionEvent {
    const event = session.log.append(type, data, runId, sessionId, meta)
    this.onEvent?.(event)
    this.logger.debug('Event appended', { sessionId, seq: event.seq, type })
    return event
  }

  private pipeEvents(
    session: Session,
    handle: ProcessHandle,
    runId: string,
    sessionId: string,
  ): void {
    const parser = new JsonLinesParser()

    ;(async () => {
      try {
        for await (const chunk of handle.stdout) {
          const objects = parser.feed(chunk + '\n')
          for (const raw of objects) {
            const normalized = normalizeClaude(raw)
            if (!normalized) {
              if (isIgnoredClaudeEvent(raw)) {
                this.logger.debug('Normalizer ignored known event', {
                  sessionId,
                  subtype: (raw as Record<string, unknown>).subtype,
                })
              } else {
                this.logger.warn('Normalizer skipped event', { sessionId, raw })
              }
              continue
            }

            // Store resumeId from run:ready
            if (normalized.type === 'run:ready') {
              const data = normalized.data as { resumeId?: string }
              if (data.resumeId) {
                session.resumeId = data.resumeId
              }
            }

            this.appendEvent(
              session,
              normalized.type as EventType,
              normalized.data,
              runId,
              sessionId,
              { rawType: (raw as Record<string, unknown>).type as string },
            )

            // Track tool names and detect special tools in content events.
            if (normalized.type === 'content') {
              const contentData = normalized.data as ContentData
              this.trackToolUseNames(session, contentData)
              // ScheduleWakeup detection: the harness takes ownership of the timer
              // because the CLI's internal timer doesn't reliably fire in the
              // daemon PTY context.
              this.detectScheduleWakeup(session, sessionId, contentData)
            }

            // Background task tailing: correlate task:started → result to find output path
            this.handleBackgroundTaskEvent(session, normalized.type, normalized.data, runId, sessionId)

            // If a wake timer previously fired while the session was busy,
            // this newly-appended event may have just returned it to idle.
            this.flushPendingWakeupIfIdle(session, sessionId)
          }
        }

        // Process stdout closed — flush any remaining buffer
        const remaining = parser.flush()
        for (const raw of remaining) {
          const normalized = normalizeClaude(raw)
          if (normalized) {
            this.appendEvent(
              session,
              normalized.type as EventType,
              normalized.data,
              runId,
              sessionId,
            )
          }
        }
      } catch (err) {
        this.logger.error('Error piping process events', {
          sessionId,
          runId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }

  /** Record tool names from content events so handleBackgroundTaskEvent can
   *  distinguish auto-backgrounded commands from long-running tools. */
  private trackToolUseNames(session: Session, data: ContentData): void {
    if (!data.blocks) return
    for (const block of data.blocks) {
      if (block.type === 'tool_use') {
        const toolUse = block as ToolUseBlock
        session.pendingToolUseNames.set(toolUse.id, toolUse.name)
      }
    }
  }

  /**
   * Scan a content event for ScheduleWakeup tool_use blocks.
   * If found, set a harness-owned timer to send the wakeup prompt.
   */
  private detectScheduleWakeup(
    session: Session,
    sessionId: string,
    data: ContentData,
  ): void {
    if (!data.blocks) return
    for (const block of data.blocks) {
      if (block.type !== 'tool_use') continue
      const toolUse = block as ToolUseBlock
      if (toolUse.name !== 'ScheduleWakeup') continue
      const input = toolUse.input as {
        delaySeconds?: number
        prompt?: string
        reason?: string
      } | null
      if (!input?.delaySeconds || !input?.prompt) continue

      this.scheduleWakeup(
        session,
        sessionId,
        input.delaySeconds,
        input.prompt,
        input.reason ?? '',
      )
    }
  }

  /**
   * Set a harness-owned timer to fire a scheduled wakeup.
   * Replaces any existing wakeup for this session.
   */
  private scheduleWakeup(
    session: Session,
    sessionId: string,
    delaySecs: number,
    prompt: string,
    reason: string,
  ): void {
    // Cancel any existing wakeup — new one replaces it
    this.cancelWakeup(session, sessionId)

    const expectedAt = Date.now() + delaySecs * 1000
    const timer = setTimeout(() => {
      // Only fire if process is alive and session is idle.
      // If the process is dead, drop the wake entirely. If the session is
      // merely busy (CLI woke itself up for something else), defer delivery
      // until the next idle transition — flushPendingWakeupIfIdle handles it.
      if (!session.process?.alive) {
        session.scheduledWakeup = null
        this.logger.info('Scheduled wakeup dropped (process not alive)', { sessionId })
        return
      }

      const status = deriveStatus(session.log.all())
      if (status !== 'idle') {
        if (session.scheduledWakeup) session.scheduledWakeup.timer = null
        this.logger.info('Scheduled wakeup deferred (not idle)', { sessionId, status })
        return
      }

      this.deliverWakeup(session, sessionId)
    }, delaySecs * 1000)

    session.scheduledWakeup = { timer, prompt, reason, delaySecs, expectedAt }
    this.logger.info('Scheduled wakeup set', { sessionId, delaySecs, reason, expectedAt })
  }

  /**
   * Write the pending wakeup prompt to stdin and append an input:sent event.
   * Clears the scheduledWakeup entry. Caller must have already verified that
   * the process is alive and the session is idle.
   */
  private deliverWakeup(session: Session, sessionId: string): void {
    const wake = session.scheduledWakeup
    if (!wake || !session.process?.alive) return
    session.scheduledWakeup = null
    this.logger.info('Scheduled wakeup firing', {
      sessionId, reason: wake.reason, prompt: wake.prompt.slice(0, 100),
    })
    session.process.write(wake.prompt + '\n')
    this.appendEvent(
      session,
      'input:sent',
      { text: wake.prompt, source: 'scheduled_wakeup' },
      session.runId!,
      sessionId,
    )
  }

  /**
   * Called after every appended event. If the session has a deferred wake
   * (timer already fired) and has just become idle, flush it now.
   */
  private flushPendingWakeupIfIdle(session: Session, sessionId: string): void {
    const wake = session.scheduledWakeup
    if (!wake || wake.timer !== null) return
    if (!session.process?.alive) {
      session.scheduledWakeup = null
      return
    }
    if (deriveStatus(session.log.all()) !== 'idle') return
    this.deliverWakeup(session, sessionId)
  }

  private cancelWakeup(session: Session, sessionId: string): void {
    if (!session.scheduledWakeup) return
    if (session.scheduledWakeup.timer) clearTimeout(session.scheduledWakeup.timer)
    session.scheduledWakeup = null
    this.logger.debug('Scheduled wakeup cancelled', { sessionId })
  }

  private handleBackgroundTaskEvent(
    session: Session,
    type: string,
    data: unknown,
    runId: string,
    sessionId: string,
  ): void {
    if (type === 'task:started') {
      const d = data as TaskStartedData
      if (d.taskType !== 'local_bash') return
      session.pendingTaskToolUseIds.set(d.toolUseId, d.taskId)
      this.logger.debug('Background task started', {
        sessionId, taskId: d.taskId, toolUseId: d.toolUseId,
      })
    } else if (type === 'result' && session.pendingTaskToolUseIds.size > 0) {
      // Correlate tool_result with pending task:started. For auto-backgrounded
      // commands (no "Output is being written to: ..." marker in the result),
      // the CLI won't emit a follow-up task:updated — synthesize completion so
      // hasRunningBackgroundTasks clears. Long-running tools like Monitor get
      // a real task:updated later; skip synthetic completion for them.
      const blocks = (data as { blocks?: Array<{ type: string; tool_use_id?: string; content?: string }> }).blocks
      if (!blocks) return
      for (const block of blocks) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const taskId = session.pendingTaskToolUseIds.get(block.tool_use_id)
        if (!taskId) continue

        session.pendingTaskToolUseIds.delete(block.tool_use_id)
        const toolName = session.pendingToolUseNames.get(block.tool_use_id)
        session.pendingToolUseNames.delete(block.tool_use_id)
        const hasOutputPath = typeof block.content === 'string' && /Output is being written to:\s*\S+/.test(block.content)
        if (hasOutputPath) continue
        if (toolName === 'Monitor') {
          this.logger.info('Background task is Monitor — skipping synthetic completion', {
            sessionId, taskId, toolName,
          })
          continue
        }
        this.logger.info('Background task result inline (auto-backgrounded), marking completed', { sessionId, taskId })
        this.appendEvent(session, 'task:updated', {
          taskId,
          patch: { status: 'completed' },
        }, runId, sessionId)
      }
    }
  }

  private handleExit(
    session: Session,
    handle: ProcessHandle,
    runId: string,
    sessionId: string,
  ): void {
    handle.exited.then(({ code, signal, lost }) => {
      session.process = null
      this.cancelWakeup(session, sessionId)
      session.pendingTaskToolUseIds.clear()
      session.pendingToolUseNames.clear()
      const events = session.log.all()
      const status = deriveStatus(events)
      const reason =
        lost
          ? 'process_lost'
          : status === 'stopping'
            ? 'stopped'
            : code === 0
              ? 'completed'
              : 'process_exit'
      const lostTasks = lost ? deriveUnfinishedTasks(events) : []

      this.appendEvent(
        session,
        'run:end',
        { code, signal, reason, ...(lostTasks.length > 0 ? { lostTasks } : {}) },
        runId,
        sessionId,
      )
      this.logger.info('Process exited', { sessionId, runId, code, signal, reason })
    })
  }
}
