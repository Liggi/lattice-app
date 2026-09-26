export interface SpawnConfig {
  prompt: string
  cwd?: string
  resume?: string
  env?: Record<string, string>
  args?: string[]
  /** Adapter-specific extra fields (e.g., systemPrompt, initialContent). */
  extra?: Record<string, unknown>
}

/**
 * A delivery aimed at the turn a process is already running, rather than at
 * the next one. Providers expose this natively (Codex `turn/steer`, Claude's
 * `priority: "next"` queue), so it is a separate operation from `write`:
 * `write` returns nothing and cannot say whether the provider took the input,
 * and an urgent correction is only safe to mark delivered once it has.
 */
export interface SteerRequest {
  input: string
  /**
   * Correlation id for exactly this delivery, carried to the provider so its
   * acknowledgement can be matched to it. Must be a UUID: Claude's queue keys
   * its lifecycle frames on one.
   */
  deliveryId: string
  extra?: Record<string, unknown>
  /**
   * Called as the delivery moves, zero or more times, possibly long after
   * `steer()` has returned. See `SteerStage` for why the caller needs each
   * moment separately.
   */
  onStage?: (stage: SteerStage) => void
}

/**
 * Where a steered input has got to. Three moments, because a caller that
 * cannot tell them apart will either claim a delivery it has not got or
 * re-send one it has.
 *
 * `handed-over` is the instant the input left for the provider and the last
 * instant at which "nothing was delivered" is still true. A caller that dies
 * after this cannot know on restart whether the input arrived.
 *
 * `accepted` is the provider acknowledging it. That is all it is: Claude
 * acknowledges a queued message in milliseconds, before any turn has been
 * given it. `late` marks an acknowledgement that arrived after `steer()` had
 * already given up and answered `uncertain`, which is the caller's cue to
 * reconcile a batch it is holding.
 *
 * `incorporated` is a turn actually taking it, which is the only one of the
 * three that a receipt may describe as delivered to the model.
 */
export type SteerStage =
  | { kind: 'handed-over' }
  | { kind: 'accepted'; late: boolean; detail?: Record<string, unknown> }
  | { kind: 'incorporated'; where: 'mid-turn' | 'next-turn'; evidence: string }

export type SteerOutcome =
  /**
   * The provider took it. It has not necessarily acted on it. `sentSeq` is
   * the `input:sent` the session log got for this delivery, so a receipt
   * written later can name the event it belongs to rather than assuming it
   * is still the most recent one.
   */
  | { status: 'accepted'; sentSeq?: number; detail?: Record<string, unknown> }
  /** The provider definitively refused, or could not be asked. Nothing was delivered. */
  | { status: 'rejected'; reason: string }
  /**
   * The input was handed over but no acknowledgement came back. It may or may
   * not have arrived, so the caller must not re-send it.
   */
  | { status: 'uncertain'; reason: string }

export interface ProcessHandle {
  stdout: AsyncIterable<string>
  write(input: string, extra?: Record<string, unknown>): void
  /**
   * Deliver into the currently running turn. Optional: an adapter without it
   * simply has no urgent path, and callers fall back to queueing.
   */
  steer?(request: SteerRequest): Promise<SteerOutcome>
  /** Ask the provider to compact its current context through its native API.
   *  Adapters without a dedicated API may omit this; SessionManager falls
   *  back to the provider's `/compact` command. */
  compact?(): Promise<void>
  signal(sig: NodeJS.Signals): void
  /** `lost` means the process stopped being reachable rather than exiting in
   *  view: the adapter can no longer hear it, whatever happened to it. */
  exited: Promise<{ code: number; signal?: string; lost?: boolean }>
  alive: boolean
  pid?: number
  /** Adapter-specific process identifier (e.g., daemon streamingId). */
  processId?: string
}

export interface ProcessAdapter {
  spawn(config: SpawnConfig): Promise<ProcessHandle>
}
