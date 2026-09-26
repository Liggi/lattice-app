/**
 * The terminal a person signs in to Claude through, owned by the daemon.
 *
 * It runs the user's own `claude auth login` on a PTY and nothing else: no
 * shell underneath, fixed arguments, the CLI's own prompts. Lattice carries
 * keystrokes and screen output between the browser and that process the way
 * a web terminal would, and the CLI owns the exchange and the credentials.
 *
 * What passes through here is sensitive (the pasted authorization code echoes
 * on screen), so it lives only in memory for the life of the attempt and is
 * never logged, journaled or persisted. Log lines carry ids and phases only.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { createLogger } from '../services/infrastructure/logger.js';

const logger = createLogger('ClaudeLoginTerminal');

/** Anthropic's sign-in page does not wait forever either; a forgotten attempt is closed. */
const DEFAULT_TTL_MS = 15 * 60 * 1000;
/** Screen history replayed to a reconnecting browser. */
const DEFAULT_BUFFER_CHARS = 256 * 1024;
/** How long a finished attempt keeps its last screen for a phone that comes back late. */
const FINISHED_OUTPUT_GRACE_MS = 60 * 1000;
/** How long a finished attempt's state stays readable. */
const FINISHED_STATE_RETENTION_MS = 10 * 60 * 1000;
/** Largest single input request. A pasted authorization code is well under this. */
export const MAX_INPUT_CHARS = 4096;
const SIGNED_IN_CHECK_TIMEOUT_MS = 10_000;

export type LoginAttemptState =
  | { phase: 'running'; startedAt: number; expiresAt: number }
  | { phase: 'succeeded'; startedAt: number; endedAt: number }
  | { phase: 'failed'; startedAt: number; endedAt: number; reason: string }
  | { phase: 'cancelled'; startedAt: number; endedAt: number };

export interface LoginTerminalProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): void;
}

export interface LoginTerminalSize {
  cols: number;
  rows: number;
}

export interface ClaudeLoginTerminalOptions {
  spawn: (size: LoginTerminalSize) => LoginTerminalProcess;
  /** Asked once the CLI exits cleanly; only its answer makes an attempt succeeded. */
  checkSignedIn: () => Promise<boolean>;
  ttlMs?: number;
  bufferChars?: number;
  now?: () => number;
}

interface Attempt {
  id: string;
  process: LoginTerminalProcess | null;
  state: LoginAttemptState;
  output: string;
  /** Characters emitted over the attempt's life, so a live stream can pick up exactly where a replay ends. */
  totalChars: number;
  /** Last input sequence applied per browser client, so a retried request cannot type twice. */
  lastSeqByClient: Map<string, number>;
  expiryTimer: NodeJS.Timeout | null;
  cleanupTimers: NodeJS.Timeout[];
  ending: boolean;
}

export interface ClaudeLoginTerminalEvents {
  output: (data: { attemptId: string; data: string; offset: number }) => void;
  state: (data: { attemptId: string; state: LoginAttemptState }) => void;
}

export function clampTerminalSize(size: Partial<LoginTerminalSize> | undefined): LoginTerminalSize {
  const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  return { cols: clamp(size?.cols, 80, 20, 500), rows: clamp(size?.rows, 24, 5, 200) };
}

export class ClaudeLoginTerminalManager extends EventEmitter {
  private attempts = new Map<string, Attempt>();
  private readonly ttlMs: number;
  private readonly bufferChars: number;
  private readonly now: () => number;

  constructor(private readonly options: ClaudeLoginTerminalOptions) {
    super();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.bufferChars = options.bufferChars ?? DEFAULT_BUFFER_CHARS;
    this.now = options.now ?? Date.now;
  }

  override on<E extends keyof ClaudeLoginTerminalEvents>(event: E, listener: ClaudeLoginTerminalEvents[E]): this {
    return super.on(event, listener);
  }

  override emit<E extends keyof ClaudeLoginTerminalEvents>(event: E, ...args: Parameters<ClaudeLoginTerminalEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * One sign-in at a time. A second start while one is running returns that
   * one, so a reopened settings screen rejoins the attempt in progress rather
   * than starting a login the first is still waiting on. `restart` ends the
   * running attempt first; that is the explicit "start over" the UI offers.
   */
  start(size: Partial<LoginTerminalSize> | undefined, restart = false): { attemptId: string; state: LoginAttemptState; reused: boolean } {
    const running = this.runningAttempt();
    if (running && !restart) {
      return { attemptId: running.id, state: running.state, reused: true };
    }
    if (running) this.cancel(running.id);

    const startedAt = this.now();
    const attempt: Attempt = {
      id: randomUUID(),
      process: null,
      state: { phase: 'running', startedAt, expiresAt: startedAt + this.ttlMs },
      output: '',
      totalChars: 0,
      lastSeqByClient: new Map(),
      expiryTimer: null,
      cleanupTimers: [],
      ending: false,
    };
    this.attempts.set(attempt.id, attempt);

    try {
      attempt.process = this.options.spawn(clampTerminalSize(size));
    } catch (error) {
      this.attempts.delete(attempt.id);
      logger.error('Claude login terminal failed to start', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }

    attempt.process.onData((data) => this.append(attempt, data));
    attempt.process.onExit(({ exitCode }) => void this.onExit(attempt, exitCode));
    attempt.expiryTimer = setTimeout(() => this.expire(attempt), this.ttlMs);
    attempt.expiryTimer.unref?.();

    logger.info('Claude login terminal started', { attemptId: attempt.id });
    return { attemptId: attempt.id, state: attempt.state, reused: false };
  }

  /**
   * The screen so far plus the state, for a browser attaching or reattaching.
   * `outputEnd` is the offset the next live chunk will carry, so a subscriber
   * that heard chunks while this was being answered can drop the ones the
   * replay already covers.
   */
  attach(attemptId: string): { state: LoginAttemptState; output: string; outputEnd: number } | null {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return null;
    return { state: attempt.state, output: attempt.output, outputEnd: attempt.totalChars };
  }

  getState(attemptId: string): LoginAttemptState | null {
    return this.attempts.get(attemptId)?.state ?? null;
  }

  /**
   * Keystrokes from one browser client. `seq` climbs per client; a request the
   * client retried after losing the response arrives with a seq already
   * applied and is acknowledged without typing it again. That is what keeps a
   * flaky phone connection from pasting the authorization code twice.
   */
  input(attemptId: string, clientId: string, seq: number, data: string): { accepted: boolean; lastSeq: number } {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state.phase !== 'running' || !attempt.process) {
      throw new Error('Claude login is not running');
    }
    if (!Number.isInteger(seq) || seq < 1) throw new Error('Input sequence must be a positive integer');
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_INPUT_CHARS) {
      throw new Error(`Input must be 1 to ${MAX_INPUT_CHARS} characters`);
    }
    const lastSeq = attempt.lastSeqByClient.get(clientId) ?? 0;
    if (seq <= lastSeq) return { accepted: false, lastSeq };
    attempt.lastSeqByClient.set(clientId, seq);
    attempt.process.write(data);
    return { accepted: true, lastSeq: seq };
  }

  resize(attemptId: string, size: Partial<LoginTerminalSize>): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state.phase !== 'running' || !attempt.process) return;
    const { cols, rows } = clampTerminalSize(size);
    attempt.process.resize(cols, rows);
  }

  cancel(attemptId: string): boolean {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state.phase !== 'running') return false;
    logger.info('Claude login terminal cancelled', { attemptId });
    this.finish(attempt, { phase: 'cancelled', startedAt: attempt.state.startedAt, endedAt: this.now() });
    return true;
  }

  /** Ends every running attempt; for daemon shutdown. */
  shutdown(): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.state.phase === 'running') this.cancel(attempt.id);
      for (const timer of attempt.cleanupTimers) clearTimeout(timer);
    }
    this.attempts.clear();
  }

  private runningAttempt(): Attempt | undefined {
    for (const attempt of this.attempts.values()) {
      if (attempt.state.phase === 'running') return attempt;
    }
    return undefined;
  }

  private append(attempt: Attempt, data: string): void {
    const offset = attempt.totalChars;
    attempt.totalChars += data.length;
    attempt.output += data;
    if (attempt.output.length > this.bufferChars) {
      attempt.output = attempt.output.slice(attempt.output.length - this.bufferChars);
    }
    this.emit('output', { attemptId: attempt.id, data, offset });
  }

  private expire(attempt: Attempt): void {
    if (attempt.state.phase !== 'running') return;
    logger.info('Claude login terminal expired', { attemptId: attempt.id });
    this.finish(attempt, {
      phase: 'failed',
      startedAt: attempt.state.startedAt,
      endedAt: this.now(),
      reason: 'Sign-in was not completed in time',
    });
  }

  private async onExit(attempt: Attempt, exitCode: number): Promise<void> {
    if (attempt.state.phase !== 'running' || attempt.ending) return;
    attempt.ending = true;
    const startedAt = attempt.state.startedAt;
    if (exitCode !== 0) {
      logger.info('Claude login exited without signing in', { attemptId: attempt.id, exitCode });
      this.settle(attempt, { phase: 'failed', startedAt, endedAt: this.now(), reason: `Claude Code exited with code ${exitCode}` });
      return;
    }
    // A clean exit is the CLI's word that it finished, not that it signed in;
    // its own status check is the only thing that turns this attempt green.
    let signedIn = false;
    try {
      signedIn = await Promise.race([
        this.options.checkSignedIn(),
        new Promise<boolean>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('status check timed out')), SIGNED_IN_CHECK_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      logger.warn('Claude auth status check failed after login', { attemptId: attempt.id, error: error instanceof Error ? error.message : String(error) });
      this.settle(attempt, { phase: 'failed', startedAt, endedAt: this.now(), reason: 'Claude Code finished, but its sign-in status could not be checked' });
      return;
    }
    if (!signedIn) {
      logger.info('Claude login finished but Claude Code reports it is not signed in', { attemptId: attempt.id });
      this.settle(attempt, { phase: 'failed', startedAt, endedAt: this.now(), reason: 'Claude Code finished, but reports that it is not signed in' });
      return;
    }
    logger.info('Claude login succeeded', { attemptId: attempt.id });
    this.settle(attempt, { phase: 'succeeded', startedAt, endedAt: this.now() });
  }

  /** Ends a running process, then records the outcome. */
  private finish(attempt: Attempt, state: LoginAttemptState): void {
    attempt.ending = true;
    try {
      attempt.process?.kill();
    } catch (_error) {
      // Already gone.
    }
    this.settle(attempt, state);
  }

  private settle(attempt: Attempt, state: LoginAttemptState): void {
    if (attempt.expiryTimer) {
      clearTimeout(attempt.expiryTimer);
      attempt.expiryTimer = null;
    }
    attempt.process = null;
    attempt.state = state;
    attempt.lastSeqByClient.clear();
    this.emit('state', { attemptId: attempt.id, state });

    const forgetOutput = setTimeout(() => { attempt.output = ''; }, FINISHED_OUTPUT_GRACE_MS);
    const forgetAttempt = setTimeout(() => { this.attempts.delete(attempt.id); }, FINISHED_STATE_RETENTION_MS);
    forgetOutput.unref?.();
    forgetAttempt.unref?.();
    attempt.cleanupTimers.push(forgetOutput, forgetAttempt);
  }
}
