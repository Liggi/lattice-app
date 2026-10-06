/**
 * A process's last output and its exit arriving in one burst.
 *
 * Seen 2026-10-02 on conv-oh2TDVDNrd-R: the daemon replayed a process's last
 * frames to a new server and closed it straight after. `exited` resolved
 * before the harness had read the queued frames, so `run:end` landed in the
 * middle of the run's output. The session read as streaming with no process,
 * and every message to it failed on a null stdin.
 */

import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '@liggi/agent-ui-harness/server';
import type { SpawnConfig } from '@liggi/agent-ui-harness/server';
import { deriveStatus } from '@liggi/agent-ui-harness/protocol';
import { DaemonProcessAdapter } from '../../src/harness/daemon-process-adapter.js';
import type { ProcessManagerClient } from '../../src/process-daemon/process-manager-client.js';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

describe('a process that exits right after its last output', () => {
  it('ends the run after every frame it printed', async () => {
    const daemon = new (class extends EventEmitter {
      async startConversationOptimistic() { return { streamingId: 'stream-1' }; }
    })();
    const manager = new SessionManager(new DaemonProcessAdapter(daemon as unknown as ProcessManagerClient), { logger: quiet });
    await manager.start('conv-burst', { prompt: 'go', cwd: '/tmp' } as SpawnConfig);

    const frame = (text: string) => ({
      streamingId: 'stream-1',
      message: { type: 'assistant', message: { id: `m-${text}`, role: 'assistant', content: [{ type: 'text', text }] } },
    });
    for (const text of ['one', 'two', 'three']) daemon.emit('claude-message', frame(text));
    daemon.emit('process-closed', { streamingId: 'stream-1', code: 143 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const events = manager.getLog('conv-burst')!.all();
    expect(events.filter((e) => e.type === 'content')).toHaveLength(3);
    expect(events.at(-1)!.type).toBe('run:end');
    expect(deriveStatus(events)).toBe('idle');
  });
});
