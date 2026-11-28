import { describe, expect, it } from 'vitest';
import {
  openCircuitFromNewestFirst,
  RETRY_CIRCUIT_CLOSED_EVENT,
  RETRY_CIRCUIT_OPEN_EVENT,
  RetryCircuitBreaker,
} from '../../src/services/sessions/retry-circuit-breaker';
import { deriveRunFailure } from '../../src/harness/derive-session-status';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('RetryCircuitBreaker', () => {
  it('backs off 2s then 6s and opens on the third failure inside two minutes', () => {
    const time = clock();
    const breaker = new RetryCircuitBreaker(undefined, time.now);
    expect(breaker.noteFailure('s', 'boom')).toEqual({ open: false, tripped: false, delayMs: 2_000 });
    time.advance(2_000);
    expect(breaker.noteFailure('s', 'boom')).toEqual({ open: false, tripped: false, delayMs: 6_000 });
    time.advance(6_000);
    expect(breaker.noteFailure('s', 'still boom')).toEqual({ open: true, tripped: true, delayMs: 0 });
    expect(breaker.isOpen('s')).toBe(true);
    expect(breaker.state('s')).toMatchObject({ open: true, reason: 'still boom', failures: 3 });
    // Further failures leave it open without tripping again.
    expect(breaker.noteFailure('s', 'again')).toEqual({ open: true, tripped: false, delayMs: 0 });
  });

  it('does not count failures older than the window', () => {
    const time = clock();
    const breaker = new RetryCircuitBreaker(undefined, time.now);
    breaker.noteFailure('s', 'a');
    breaker.noteFailure('s', 'b');
    time.advance(2 * 60_000 + 1);
    expect(breaker.noteFailure('s', 'c')).toEqual({ open: false, tripped: false, delayMs: 2_000 });
  });

  it('keeps sessions apart and resets on request', () => {
    const breaker = new RetryCircuitBreaker();
    for (let i = 0; i < 3; i += 1) breaker.noteFailure('a', 'x');
    breaker.noteFailure('b', 'y');
    expect(breaker.isOpen('a')).toBe(true);
    expect(breaker.isOpen('b')).toBe(false);
    expect(breaker.reset('a')).toBe(true);
    expect(breaker.isOpen('a')).toBe(false);
    expect(breaker.reset('b')).toBe(false);
    expect(breaker.noteFailure('a', 'x').delayMs).toBe(2_000);
  });

  it('reads an open circuit back from the log, newest event first', () => {
    expect(openCircuitFromNewestFirst([
      { type: RETRY_CIRCUIT_OPEN_EVENT, data: { reason: 'spawn failed', failures: 3 }, timestamp: 5 },
      { type: RETRY_CIRCUIT_CLOSED_EVENT, data: { why: 'retry' }, timestamp: 4 },
    ])).toEqual({ reason: 'spawn failed', failures: 3, at: 5 });
    expect(openCircuitFromNewestFirst([
      { type: RETRY_CIRCUIT_CLOSED_EVENT, data: { why: 'retry' }, timestamp: 6 },
      { type: RETRY_CIRCUIT_OPEN_EVENT, data: { reason: 'spawn failed', failures: 3 }, timestamp: 5 },
    ])).toBeNull();
  });
});

describe('deriveRunFailure with a retry circuit', () => {
  const event = (type: string, timestamp: number, data: unknown = {}) => ({ type, timestamp, data, seq: timestamp }) as unknown as SessionEvent;

  it('reports an open circuit as a failure until a message clears it', () => {
    const opened = [
      event('input:sent', 1),
      event('run:error', 2, { message: 'spawn ENOENT' }),
      event(RETRY_CIRCUIT_OPEN_EVENT, 3, { reason: 'spawn ENOENT', failures: 3 }),
    ];
    expect(deriveRunFailure(opened)).toEqual({ message: 'spawn ENOENT', at: 3, circuitBroken: true });
    expect(deriveRunFailure([...opened, event(RETRY_CIRCUIT_CLOSED_EVENT, 4, { why: 'retry' })])).toEqual({ message: 'spawn ENOENT', at: 3 });
    expect(deriveRunFailure([...opened, event('input:sent', 5)])).toBeNull();
  });
});
