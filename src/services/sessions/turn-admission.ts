/**
 * Turn admission — one owner per session for "who writes the next input".
 *
 * Three things want the boundary between a session's turns: a send that
 * cancels the current turn first (`--interrupt`), the inbox drain that runs
 * at every turn end, and auto-compaction. Left to race, the drain won: on
 * 2026-09-20 an interrupt's `stop()` completed in ~5ms, the turn:end side
 * effect drained the backlog into a new turn ~11ms later, and the interrupt,
 * polling status every 100ms, found the session mid-turn again and reported
 * "did not stop in time" — with the correction never written anywhere.
 * The admission is what the interrupt takes before it
 * cancels, so the drain and the compaction wait for it and the correction is
 * admitted first, in one chronological batch with whatever else arrived.
 *
 * The owner is a per-session FIFO mutex, in memory only. It does not need to
 * survive a restart: the inbox rows are the durable state, and a fresh server
 * drains them in order. Every holder releases in `finally`; a holder that
 * lives longer than `SLOW_HOLD_MS` is logged so a wedge is visible in the
 * server log rather than silent.
 *
 * The drain delivers through the same HTTP `/send` route every other input
 * takes. That route also acquires admission, so a drain that held it and then
 * called the route would wait on itself. Instead the drain passes its
 * admission's id in the request body and the route recognises the holder
 * (`isAdmissionToken`) and runs inside that admission instead of taking a
 * new one. Only a live admission id is accepted, so an `inboxIds` batch sent
 * by anything that does not hold the session's admission is refused.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../infrastructure/logger.js';

const logger = createLogger('TurnAdmission');

export type AdmissionPurpose = 'send' | 'interrupt' | 'drain' | 'auto-compact' | 'review' | 'switch';

export interface TurnAdmission {
  readonly sessionId: string;
  /** Random per-grant id; the drain passes it to the send route to prove it is the holder. */
  readonly id: string;
  readonly purpose: AdmissionPurpose;
  readonly acquiredAt: number;
  /** Hand the boundary to the next waiter. Safe to call more than once. */
  release(): void;
}

interface Waiter {
  purpose: AdmissionPurpose;
  grant: (admission: TurnAdmission) => void;
}

interface SessionAdmission {
  current: TurnAdmission | null;
  queue: Waiter[];
}

const SLOW_HOLD_MS = 30_000;

const sessions = new Map<string, SessionAdmission>();

function entry(sessionId: string): SessionAdmission {
  let state = sessions.get(sessionId);
  if (!state) {
    state = { current: null, queue: [] };
    sessions.set(sessionId, state);
  }
  return state;
}

function grant(sessionId: string, state: SessionAdmission, purpose: AdmissionPurpose): TurnAdmission {
  let released = false;
  const slow = setTimeout(() => {
    logger.warn('Turn admission held for a long time', { sessionId, purpose, heldMs: SLOW_HOLD_MS });
  }, SLOW_HOLD_MS);
  const admission: TurnAdmission = {
    sessionId,
    id: randomUUID(),
    purpose,
    acquiredAt: Date.now(),
    release: () => {
      if (released) return;
      released = true;
      clearTimeout(slow);
      if (state.current !== admission) return;
      const next = state.queue.shift();
      if (next) {
        state.current = grant(sessionId, state, next.purpose);
        next.grant(state.current);
      } else {
        state.current = null;
        sessions.delete(sessionId);
      }
    },
  };
  return admission;
}

/** Take the session's next-turn boundary, waiting behind whoever holds it. */
export function admitTurn(sessionId: string, purpose: AdmissionPurpose): Promise<TurnAdmission> {
  const state = entry(sessionId);
  if (!state.current) {
    state.current = grant(sessionId, state, purpose);
    return Promise.resolve(state.current);
  }
  return new Promise((resolve) => {
    state.queue.push({ purpose, grant: resolve });
  });
}

/** Take the boundary only if nobody holds it; null otherwise. For work that can simply not happen this time. */
export function tryAdmitTurn(sessionId: string, purpose: AdmissionPurpose): TurnAdmission | null {
  const state = entry(sessionId);
  if (state.current) return null;
  state.current = grant(sessionId, state, purpose);
  return state.current;
}

/** Run `fn` holding the boundary, releasing whatever happens. */
export async function withTurnAdmission<T>(
  sessionId: string,
  purpose: AdmissionPurpose,
  fn: (admission: TurnAdmission) => Promise<T>,
): Promise<T> {
  const admission = await admitTurn(sessionId, purpose);
  try {
    return await fn(admission);
  } finally {
    admission.release();
  }
}

/** Whether `token` is the id of the admission currently held for this session. */
export function isAdmissionToken(sessionId: string, token: string): boolean {
  const current = sessions.get(sessionId)?.current;
  return current !== undefined && current !== null && current.id === token;
}

/** Who holds the boundary now, and how many wait, for diagnostics. */
export function inspectAdmission(sessionId: string): { holder: AdmissionPurpose; heldMs: number; waiting: number } | null {
  const state = sessions.get(sessionId);
  if (!state?.current) return null;
  return { holder: state.current.purpose, heldMs: Date.now() - state.current.acquiredAt, waiting: state.queue.length };
}

/** Tests only: forget every admission. */
export function __resetTurnAdmissionForTests(): void {
  sessions.clear();
}
