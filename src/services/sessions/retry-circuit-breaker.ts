/**
 * Stops a session's inbox from re-sending into a run that keeps failing.
 *
 * Every `run:error` drains the session's inbox, and a drain that sends into a
 * process that cannot start produces another `run:error`: on 2026-11-20 one
 * session logged 85k `run:error` and ~112k `input:undeliverable` events in
 * four minutes, with nothing on screen saying so. Consecutive failures within
 * a rolling window back the automatic drain off (2s, then 6s), and the third
 * opens the circuit: automatic drains stop until a healthy turn ends, the
 * user sends a message, or Retry is pressed (`POST /api/conv/:id/retry`).
 *
 * The open circuit is recorded in the session's log (`retry:circuit-open`),
 * so status derivation shows the session as failed and a restart does not
 * start the loop again.
 */

export const RETRY_CIRCUIT_OPEN_EVENT = 'retry:circuit-open';
export const RETRY_CIRCUIT_CLOSED_EVENT = 'retry:circuit-closed';

export interface RetryCircuitOpenData {
  /** The last failure's message. */
  reason: string;
  /** Failures inside the window when it opened. */
  failures: number;
}

export interface RetryCircuitClosedData {
  why: 'turn-succeeded' | 'user-send' | 'retry';
}

export interface RetryCircuitOptions {
  /** Failures older than this no longer count. */
  windowMs: number;
  /** The failure that opens the circuit. */
  tripAfter: number;
  /** Delay before the automatic drain after the 1st, 2nd, … failure. */
  backoffMs: readonly number[];
}

export const DEFAULT_RETRY_CIRCUIT: RetryCircuitOptions = {
  windowMs: 2 * 60_000,
  tripAfter: 3,
  backoffMs: [2_000, 6_000],
};

export interface CircuitVerdict {
  /** Automatic drains are stopped. */
  open: boolean;
  /** This failure opened it. */
  tripped: boolean;
  /** How long to wait before the automatic drain, when still closed. */
  delayMs: number;
}

export interface CircuitState {
  open: boolean;
  reason: string | null;
  openedAt: number | null;
  /** Failures inside the window. */
  failures: number;
}

interface Entry {
  failures: number[];
  reason: string | null;
  openedAt: number | null;
}

export class RetryCircuitBreaker {
  private readonly sessions = new Map<string, Entry>();

  constructor(
    private readonly options: RetryCircuitOptions = DEFAULT_RETRY_CIRCUIT,
    private readonly now: () => number = Date.now,
  ) {}

  noteFailure(sessionId: string, reason: string): CircuitVerdict {
    const at = this.now();
    const entry = this.sessions.get(sessionId) ?? { failures: [], reason: null, openedAt: null };
    this.sessions.set(sessionId, entry);
    entry.reason = reason;
    if (entry.openedAt !== null) return { open: true, tripped: false, delayMs: 0 };
    entry.failures = entry.failures.filter((failedAt) => at - failedAt < this.options.windowMs);
    entry.failures.push(at);
    if (entry.failures.length >= this.options.tripAfter) {
      entry.openedAt = at;
      return { open: true, tripped: true, delayMs: 0 };
    }
    const delayMs = this.options.backoffMs[Math.min(entry.failures.length - 1, this.options.backoffMs.length - 1)] ?? 0;
    return { open: false, tripped: false, delayMs };
  }

  /** Marks the circuit open without a failure here, as read back from the log after a restart. */
  restoreOpen(sessionId: string, reason: string, openedAt: number): void {
    this.sessions.set(sessionId, { failures: [], reason, openedAt });
  }

  /** Forgets the session's failures; returns whether the circuit was open. */
  reset(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return entry?.openedAt != null;
  }

  clear(): void {
    this.sessions.clear();
  }

  isOpen(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.openedAt != null;
  }

  state(sessionId: string): CircuitState | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    const at = this.now();
    return {
      open: entry.openedAt !== null,
      reason: entry.reason,
      openedAt: entry.openedAt,
      failures: entry.failures.filter((failedAt) => at - failedAt < this.options.windowMs).length,
    };
  }
}

/**
 * Whether the log leaves the circuit open: the newest of the circuit's own
 * events, given newest first, is an open.
 */
export function openCircuitFromNewestFirst(events: Iterable<{ type: string; data?: unknown; timestamp?: number }>): (RetryCircuitOpenData & { at: number }) | null {
  for (const event of events) {
    if (event.type === RETRY_CIRCUIT_CLOSED_EVENT) return null;
    if (event.type === RETRY_CIRCUIT_OPEN_EVENT) {
      const data = (event.data ?? {}) as Partial<RetryCircuitOpenData>;
      return { reason: data.reason ?? 'Repeated failures', failures: data.failures ?? 0, at: event.timestamp ?? 0 };
    }
  }
  return null;
}
