import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { DaemonProcessAdapter } from '../../src/harness/daemon-process-adapter.js';
import type { ProcessManagerClient } from '../../src/process-daemon/process-manager-client.js';

function createFakeClient() {
  const emitter = new EventEmitter();
  const startConversationOptimistic = vi.fn().mockResolvedValue({ streamingId: 'stream-1' });
  const client = Object.assign(emitter, {
    startConversationOptimistic,
    sendStdinMessage: vi.fn().mockResolvedValue(true),
    stopConversation: vi.fn().mockResolvedValue(undefined),
    forceKillConversation: vi.fn().mockResolvedValue(undefined),
  });
  return { client: client as unknown as ProcessManagerClient, startConversationOptimistic };
}

describe('DaemonProcessAdapter mid-session Claude --effort handling', () => {
  it('prefers explicit --effort= arg over segment callback when switching effort', async () => {
    const { client, startConversationOptimistic } = createFakeClient();
    const adapter = new DaemonProcessAdapter(client, () => false, () => 'low');

    await adapter.spawn({
      prompt: 'hi',
      cwd: '/tmp',
      args: ['--model=claude-fable-5-2', '--effort=max'],
      extra: { sessionId: 'conv-test' },
    });

    expect(startConversationOptimistic).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-fable-5-2',
        effort: 'max',
      }),
    );
  });

  it('clears effort back to CLI default when --effort= is empty', async () => {
    const { client, startConversationOptimistic } = createFakeClient();
    const adapter = new DaemonProcessAdapter(client, () => false, () => 'high');

    await adapter.spawn({
      prompt: 'hi',
      cwd: '/tmp',
      args: ['--effort='],
      extra: { sessionId: 'conv-test' },
    });

    const config = startConversationOptimistic.mock.calls[0][0];
    expect(config.effort).toBeUndefined();
  });

  it('falls back to segment effort when no --effort= arg is passed', async () => {
    const { client, startConversationOptimistic } = createFakeClient();
    const adapter = new DaemonProcessAdapter(client, () => false, () => 'xhigh');

    await adapter.spawn({
      prompt: 'hi',
      cwd: '/tmp',
      extra: { sessionId: 'conv-test' },
    });

    expect(startConversationOptimistic).toHaveBeenCalledWith(
      expect.objectContaining({ effort: 'xhigh' }),
    );
  });
});
