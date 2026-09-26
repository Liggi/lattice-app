import { describe, it, expect } from 'vitest';
import { deriveSessionStatusFromEvents } from '@/harness/derive-session-status.js';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';

let seq = 0;
function ev(type: string, data: unknown = {}): SessionEvent {
  seq += 1;
  return { type, data, timestamp: 1_000 + seq, seq, sessionId: 'conv-x' } as unknown as SessionEvent;
}

const LIMIT = { message: "You've hit your weekly limit · resets 4am (Europe/London)", reason: 'api_error' };
const start = () => [ev('run:start'), ev('run:ready'), ev('input:sent'), ev('content')];
const failure = (events: SessionEvent[]) => deriveSessionStatusFromEvents(events).failure;

describe('deriveSessionStatusFromEvents failure', () => {
  it('reports a turn the provider ended on an error, with its text', () => {
    expect(failure([...start(), ev('turn:end', { error: LIMIT })])?.message).toBe(LIMIT.message);
  });

  it('keeps the failure after the idle process is stopped, and clears it when new input starts a turn', () => {
    const failed = [...start(), ev('turn:end', { error: LIMIT }), ev('run:end', { reason: 'stopped' })];
    expect(failure(failed)).not.toBeNull();
    expect(failure([...failed, ev('run:start'), ev('input:sent'), ev('content'), ev('turn:end')])).toBeNull();
  });

  it('does not count a turn the user stopped', () => {
    expect(failure([...start(), ev('stop:requested'), ev('turn:end', { error: { message: 'aborted' } })])).toBeNull();
    expect(failure([...start(), ev('stop:requested'), ev('run:end', { reason: 'process_exit', code: 1 })])).toBeNull();
  });

  it('reports a process that exited mid-turn, but not one that exited idle', () => {
    expect(failure([...start(), ev('run:end', { reason: 'process_exit', code: 1, signal: null })])?.message)
      .toBe('The process exited mid-turn (code 1)');
    expect(failure([...start(), ev('turn:end'), ev('run:end', { reason: 'process_exit', code: 1 })])).toBeNull();
  });

  it('does not count a turn a restart cut off', () => {
    expect(failure([...start(), ev('run:end', { reason: 'server_restart' })])).toBeNull();
    expect(failure([...start(), ev('run:end', { reason: 'process_lost' })])).toBeNull();
  });

  it('reports a run that could not start', () => {
    expect(failure([ev('run:start'), ev('run:error', { message: 'Codex is not signed in.', code: 'SPAWN_FAILED' })])?.message)
      .toBe('Codex is not signed in.');
  });

  it('says nothing while a turn is running', () => {
    expect(failure([...start(), ev('turn:end', { error: LIMIT }), ev('input:sent'), ev('content')])).toBeNull();
  });
});
