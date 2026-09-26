/**
 * The daemon adapter accepts spawn-time attachments under either spelling:
 * `initialContent` (the resume/inject routes' key) or `attachments` (the
 * harness-wide key the SDK adapter reads and SessionManager copies onto
 * input:sent). POST /api/conv/create sets both, so this pins the fallback.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ProcessManagerClient } from '../../src/process-daemon/process-manager-client.js';
import { DaemonProcessAdapter } from '../../src/harness/daemon-process-adapter.js';

const IMAGE = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png', data: 'aW1hZ2U=' },
};

function build() {
  const startConversationOptimistic = vi.fn(async () => ({ streamingId: 'sid-1' }));
  const client = {
    on: vi.fn(),
    removeListener: vi.fn(),
    startConversationOptimistic,
  } as unknown as ProcessManagerClient;

  return { adapter: new DaemonProcessAdapter(client), startConversationOptimistic };
}

function spawnedConfig(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls[0][0] as { initialContent?: unknown };
}

describe('DaemonProcessAdapter spawn-time attachment keys', () => {
  it('forwards extra.attachments as daemon initialContent', async () => {
    const { adapter, startConversationOptimistic } = build();

    await adapter.spawn({ prompt: 'look', extra: { attachments: [IMAGE] } });

    expect(spawnedConfig(startConversationOptimistic).initialContent).toEqual([IMAGE]);
  });

  it('still honours the legacy extra.initialContent key', async () => {
    const { adapter, startConversationOptimistic } = build();

    await adapter.spawn({ prompt: 'look', extra: { initialContent: [IMAGE] } });

    expect(spawnedConfig(startConversationOptimistic).initialContent).toEqual([IMAGE]);
  });

  it('leaves initialContent unset when neither key is present', async () => {
    const { adapter, startConversationOptimistic } = build();

    await adapter.spawn({ prompt: 'look', extra: { provider: 'claude' } });

    expect(spawnedConfig(startConversationOptimistic).initialContent).toBeUndefined();
  });
});
