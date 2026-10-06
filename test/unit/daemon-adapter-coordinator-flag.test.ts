/**
 * A coordinator's spawn carries `coordinator: true` to the daemon, which then
 * switches off Claude Code's nudge for a visible response (process-daemon.ts,
 * silentTurnEnv). Any other session keeps the nudge.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ProcessManagerClient } from '../../src/process-daemon/process-manager-client.js';
import { DaemonProcessAdapter } from '../../src/harness/daemon-process-adapter.js';

function spawnFor(sessionId: string) {
  const startConversationOptimistic = vi.fn(async () => ({ streamingId: 'sid-1' }));
  const client = { on: vi.fn(), removeListener: vi.fn(), startConversationOptimistic } as unknown as ProcessManagerClient;
  const adapter = new DaemonProcessAdapter(client, (id) => id === 'conv-front');
  return adapter.spawn({ prompt: 'hi', extra: { sessionId } })
    .then(() => (startConversationOptimistic.mock.calls[0] as unknown[])[0] as { coordinator?: boolean });
}

describe('DaemonProcessAdapter coordinator flag', () => {
  it('marks a coordinator spawn', async () => {
    expect((await spawnFor('conv-front')).coordinator).toBe(true);
  });

  it('leaves a worker spawn unmarked', async () => {
    expect((await spawnFor('conv-worker')).coordinator).toBeUndefined();
  });
});
