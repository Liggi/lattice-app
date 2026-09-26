import { describe, it, expect } from 'vitest';
import { deriveSessionStatusFromEvents } from '@/harness/derive-session-status.js';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';

let seq = 0;
function ev(type: string, data: unknown = {}, timestamp = 1_000 + seq): SessionEvent {
  seq += 1;
  return { type, data, timestamp, seq, sessionId: 'conv-x' } as unknown as SessionEvent;
}

function aliveTurn(): SessionEvent[] {
  return [
    ev('run:start'),
    ev('run:ready'),
    ev('input:sent'),
    ev('content'),
    ev('turn:end'),
  ];
}

describe('deriveSessionStatusFromEvents compacting', () => {
  it('reports compacting after a started phase with no terminal', () => {
    const events = [...aliveTurn(), ev('context:compaction', { phase: 'started' })];
    const derived = deriveSessionStatusFromEvents(events);
    expect(derived.compacting).toBe(true);
  });

  it('clears on completed phase', () => {
    const events = [
      ...aliveTurn(),
      ev('context:compaction', { phase: 'started' }),
      ev('context:compaction', { phase: 'completed', result: 'success' }),
    ];
    expect(deriveSessionStatusFromEvents(events).compacting).toBe(false);
  });

  it('clears on failed phase', () => {
    const events = [
      ...aliveTurn(),
      ev('context:compaction', { phase: 'started' }),
      ev('context:compaction', { phase: 'failed', result: 'error' }),
    ];
    expect(deriveSessionStatusFromEvents(events).compacting).toBe(false);
  });

  it('clears when a turn boundary lands after the started phase', () => {
    const events = [
      ...aliveTurn(),
      ev('context:compaction', { phase: 'started' }),
      ev('content'),
      ev('turn:end'),
    ];
    expect(deriveSessionStatusFromEvents(events).compacting).toBe(false);
  });

  it('clears when the session respawns after crashing mid-compaction', () => {
    // A process killed mid-compaction never writes a terminal phase. The
    // respawn's run:start / run:ready has to clear the flag, otherwise the
    // session keeps reporting compacting:true right through the next turn.
    const events = [
      ...aliveTurn(),
      ev('input:sent'),
      ev('context:compaction', { phase: 'started' }),
      ev('run:start'),
      ev('run:ready'),
    ];
    const derived = deriveSessionStatusFromEvents(events);
    expect(derived.compacting).toBe(false);
    expect(derived.processAlive).toBe(true);
  });

  it('stays cleared once the respawned run starts producing content', () => {
    const events = [
      ...aliveTurn(),
      ev('context:compaction', { phase: 'started' }),
      ev('run:start'),
      ev('run:ready'),
      ev('input:sent'),
      ev('content'),
    ];
    expect(deriveSessionStatusFromEvents(events).compacting).toBe(false);
  });

  it('still reports compacting when the compaction starts after the run boundary', () => {
    // Ordering guard: a run boundary only clears compactions older than it.
    const events = [
      ...aliveTurn(),
      ev('run:start'),
      ev('run:ready'),
      ev('input:sent'),
      ev('context:compaction', { phase: 'started' }),
    ];
    expect(deriveSessionStatusFromEvents(events).compacting).toBe(true);
  });

  it('never reports compacting for a dead process', () => {
    const events = [
      ...aliveTurn(),
      ev('context:compaction', { phase: 'started' }),
      ev('run:end'),
    ];
    const derived = deriveSessionStatusFromEvents(events);
    expect(derived.compacting).toBe(false);
    expect(derived.processAlive).toBe(false);
  });

  it('does not disturb status derivation', () => {
    const events = [...aliveTurn(), ev('context:compaction', { phase: 'started' })];
    const derived = deriveSessionStatusFromEvents(events);
    expect(derived.status).toBe('idle');
    expect(derived.processAlive).toBe(true);
  });
});
