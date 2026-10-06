/**
 * A daemon restart under a running server: the harness closes each live
 * Claude handle with a run:end of reason process_lost, and the sessions that
 * were mid-turn or waiting on background tasks get a carry-on note in their
 * inbox at once, delivered when the daemon answers again or, if this server
 * exits first, by the next server's boot drain.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';

const logs = vi.hoisted(() => new Map<string, SessionEvent[]>());
const enqueued = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const drained = vi.hoisted(() => [] as string[]);

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({ getLog: (id: string) => ({ all: () => logs.get(id) ?? [] }) }),
}));
vi.mock('../../src/services/sessions/session-inbox.js', () => ({
  enqueueInboxItem: (input: Record<string, unknown>) => { enqueued.push(input); return 'row'; },
  drainInbox: async (id: string) => { drained.push(id); },
}));

const { noteRunEnd, carryOnAfterDaemonReconnect } = await import('../../src/services/sessions/restart-carry-on.js');

function ev(sessionId: string, seq: number, type: string, data: unknown = {}, meta?: Record<string, unknown>): SessionEvent {
  return { sessionId, runId: 'r1', seq, timestamp: 1_700_000_000_000 + seq, type, data, ...(meta ? { meta } : {}) } as SessionEvent;
}

function lose(sessionId: string, before: SessionEvent[], lostTasks: unknown[] = []): void {
  const end = ev(sessionId, before.length + 1, 'run:end', { reason: 'process_lost', code: 1, ...(lostTasks.length ? { lostTasks } : {}) });
  logs.set(sessionId, [...before, end]);
  noteRunEnd(end);
}

beforeEach(() => {
  logs.clear();
  enqueued.length = 0;
  drained.length = 0;
});

describe('carrying sessions on after a daemon restart', () => {
  it('queues the note when the process is lost and drains it once the daemon is back', async () => {
    lose('conv-mid', [ev('conv-mid', 1, 'run:start'), ev('conv-mid', 2, 'run:ready'), ev('conv-mid', 3, 'input:sent'), ev('conv-mid', 4, 'content')]);
    lose('conv-waiting', [ev('conv-waiting', 1, 'run:start'), ev('conv-waiting', 2, 'turn:end')],
      [{ taskId: 'b1', taskType: 'local_bash', description: 'Sleep' }]);
    lose('conv-stopping', [ev('conv-stopping', 1, 'run:start'), ev('conv-stopping', 2, 'content'), ev('conv-stopping', 3, 'stop:requested')]);
    lose('conv-idle', [ev('conv-idle', 1, 'run:start'), ev('conv-idle', 2, 'turn:end')]);

    // Queued now: a server that exits before the daemon is back leaves them to its successor's boot drain.
    expect(enqueued.map((e) => e.sessionId).sort()).toEqual(['conv-mid', 'conv-waiting']);
    expect(drained).toHaveLength(0);
    const mid = enqueued.find((e) => e.sessionId === 'conv-mid')!;
    expect(mid).toMatchObject({ source: 'agent', sender: 'the server', deliveryId: 'restart-resume:5' });
    expect(String(mid.text)).toContain('background service that runs Claude processes restarted');
    expect(String(enqueued.find((e) => e.sessionId === 'conv-waiting')!.text)).toContain('"Sleep" (b1)');

    await carryOnAfterDaemonReconnect();
    expect(drained.sort()).toEqual(['conv-idle', 'conv-mid', 'conv-stopping', 'conv-waiting']);

    // A second reconnect has nothing left to drain.
    await carryOnAfterDaemonReconnect();
    expect(drained).toHaveLength(4);
    expect(enqueued).toHaveLength(2);
  });

  it('ignores the boot sweep\'s own process_lost and other run:end reasons', async () => {
    const before = [ev('conv-x', 1, 'run:start'), ev('conv-x', 2, 'content')];
    const swept = ev('conv-x', 3, 'run:end', { reason: 'process_lost' }, { inferred: true, source: 'recovery' });
    logs.set('conv-x', [...before, swept]);
    expect(noteRunEnd(swept)).toBe(false);
    const exited = ev('conv-y', 3, 'run:end', { reason: 'process_exit' });
    logs.set('conv-y', [...before, exited]);
    expect(noteRunEnd(exited)).toBe(false);

    await carryOnAfterDaemonReconnect();

    expect(enqueued).toHaveLength(0);
    expect(drained).toHaveLength(0);
  });
});
