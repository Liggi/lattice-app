/**
 * A session waiting on a background task whose process has gone.
 *
 * Reproduced 2026-09-24 on the lattice-app npm build: a Claude session ends
 * its turn with a background command running, then the process behind it
 * stops being reachable. The stored log still says the task runs, so the
 * session shows "Waiting for background task" for good. Two ways in:
 *
 * - the server restarts. Its startup sweep only closed sessions that died
 *   mid-turn; this one's tail is `turn:end`, so it was skipped.
 * - the daemon restarts under a running server. The socket closes, no
 *   `process-closed` arrives, and the handle stays alive: the next message
 *   is written into a process nobody runs and the session shows working.
 *
 * Either way the log should end with a `run:end` of reason `process_lost`
 * naming the task, and the thread should say the task was lost.
 */

import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@liggi/agent-ui-harness/server';
import type { ProcessAdapter, ProcessHandle, SpawnConfig } from '@liggi/agent-ui-harness/server';
import type { RunEndData, SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { DaemonProcessAdapter } from '../../src/harness/daemon-process-adapter.js';
import { derivePendingWork } from '../../src/harness/derive-pending-work.js';
import { SqliteEventStorageAdapter } from '../../src/harness/sqlite-event-storage.js';
import { runStartupRecoverySweep } from '../../src/harness/startup-recovery-sweep.js';
import type { ProcessManagerClient } from '../../src/process-daemon/process-manager-client.js';
import { eventsToMessages } from '../../src/web/chat/hooks/useHarnessSession.js';

// The sweep queues a carry-on note for the waiting session; the inbox is not under test here.
vi.mock('../../src/services/sessions/session-inbox.js', () => ({ enqueueInboxItem: () => 'row' }));

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function seed(db: Database.Database, sessionId: string, events: Array<{ seq: number; type: string; data?: unknown }>): void {
  const stmt = db.prepare(
    'INSERT INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  );
  for (const e of events) stmt.run(sessionId, e.seq, 'run-1', 1_700_000_000_000 + e.seq, e.type, JSON.stringify(e.data ?? {}));
}

const WAITING = [
  { seq: 1, type: 'run:start', data: { config: { prompt: 'go' } } },
  { seq: 2, type: 'run:ready', data: { resumeId: 'sess-1' } },
  { seq: 3, type: 'task:started', data: { taskId: 'b1', toolUseId: 'tu1', taskType: 'local_bash', description: 'Sleep 45 seconds' } },
  { seq: 4, type: 'result', data: { blocks: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Command running in background with ID: b1' }] } },
  { seq: 5, type: 'turn:end', data: {} },
];

function lastRunEnd(events: readonly SessionEvent[]): RunEndData | undefined {
  return events.filter((e) => e.type === 'run:end').at(-1)?.data as RunEndData | undefined;
}

describe('a background task whose process is gone', () => {
  it('is closed as lost at server boot, and the thread says so', () => {
    const db = new Database(':memory:');
    const storage = new SqliteEventStorageAdapter(db);
    seed(db, 'conv-waiting', WAITING);
    // Finished before the restart: nothing to lose.
    seed(db, 'conv-finished', [...WAITING, { seq: 6, type: 'task:notification', data: { taskId: 'b1' } }]);
    // Started in an earlier process that already ended: not this process's work.
    seed(db, 'conv-earlier', [...WAITING, { seq: 6, type: 'run:end', data: { reason: 'completed' } }]);

    const result = runStartupRecoverySweep(new SessionManager({ spawn: () => { throw new Error('no spawn'); } }, { logger: quiet, storage }), storage);

    expect(result.lostTaskSessions).toBe(1);
    const events = storage.read('conv-waiting', { afterSeq: 0 });
    expect(lastRunEnd(events)).toMatchObject({
      reason: 'process_lost',
      lostTasks: [{ taskId: 'b1', taskType: 'local_bash', description: 'Sleep 45 seconds' }],
    });
    expect(derivePendingWork(events)).toBeNull();
    expect(storage.read('conv-finished', { afterSeq: 0 }).map((e) => e.type)).not.toContain('run:end');
    expect(storage.read('conv-earlier', { afterSeq: 0 }).filter((e) => e.type === 'run:end')).toHaveLength(1);

    const messages = eventsToMessages(events, new Map(events.map((e) => [e.seq, 'claude' as const])));
    expect(messages.at(-1)).toMatchObject({ type: 'error', errorTitle: 'Background task lost' });
    expect(String(messages.at(-1)!.content)).toContain('Sleep 45 seconds');
    db.close();
  });

  it('ends the daemon handle as lost when the daemon connection drops', async () => {
    const daemon = new (class extends EventEmitter {
      async startConversationOptimistic() { return { streamingId: 'stream-1' }; }
    })();
    const handle = await new DaemonProcessAdapter(daemon as unknown as ProcessManagerClient)
      .spawn({ prompt: 'go', cwd: '/tmp' } as SpawnConfig);

    daemon.emit('daemon-disconnected');

    await expect(handle.exited).resolves.toEqual({ code: 1, lost: true });
    expect(handle.alive).toBe(false);
  });

  it('records the unfinished tasks when a live handle is lost', async () => {
    let lose!: () => void;
    const handle: ProcessHandle = {
      stdout: (async function* () { /* nothing */ })(),
      write: () => undefined,
      signal: () => undefined,
      exited: new Promise((resolve) => { lose = () => resolve({ code: 1, lost: true }); }),
      alive: true,
    };
    const adapter: ProcessAdapter = { spawn: async () => handle };
    const manager = new SessionManager(adapter, { logger: quiet });
    await manager.start('conv-live', { prompt: 'go', cwd: '/tmp' } as never);
    const log = manager.getLog('conv-live')!;
    log.append('task:started', { taskId: 'b2', toolUseId: 'tu2', taskType: 'local_bash', description: 'Long build' }, 'run-x', 'conv-live');
    log.append('result', { blocks: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'Command running in background with ID: b2' }] }, 'run-x', 'conv-live');
    // A foreground command, cut off with the turn: not a lost background task.
    log.append('task:started', { taskId: 'f1', toolUseId: 'tu3', taskType: 'local_bash', description: 'Run the tests' }, 'run-x', 'conv-live');

    lose();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(lastRunEnd(log.all())).toMatchObject({
      reason: 'process_lost',
      lostTasks: [{ taskId: 'b2', description: 'Long build' }],
    });
    expect(derivePendingWork(log.all())).toBeNull();
  });
});
