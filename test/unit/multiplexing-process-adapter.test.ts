import { describe, expect, it } from 'vitest';
import type { ProcessAdapter, ProcessHandle, SpawnConfig } from '@liggi/agent-ui-harness/server';
import { MultiplexingProcessAdapter } from '../../src/harness/multiplexing-process-adapter.js';
import type { DaemonProcessAdapter } from '../../src/harness/daemon-process-adapter.js';
import type { CodexProcessAdapter } from '../../src/harness/codex-process-adapter.js';
import type { OpencodeProcessAdapter } from '../../src/harness/opencode-process-adapter.js';

function makeHandle(processId: string): ProcessHandle {
  return {
    stdout: { async *[Symbol.asyncIterator]() {} },
    write() {},
    signal() {},
    exited: Promise.resolve({ code: 0 }),
    alive: true,
    processId,
  };
}

class StubAdapter implements ProcessAdapter {
  readonly managedStreamingIds = new Set<string>();
  spawnedConfigs: SpawnConfig[] = [];
  constructor(private readonly label: string) {}
  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    this.spawnedConfigs.push(config);
    return makeHandle(`${this.label}-handle`);
  }
}

function build() {
  const daemon = new StubAdapter('daemon');
  const codex = new StubAdapter('codex');
  const opencode = new StubAdapter('opencode');
  const mux = new MultiplexingProcessAdapter(
    daemon as unknown as DaemonProcessAdapter,
    codex as unknown as CodexProcessAdapter,
    opencode as unknown as OpencodeProcessAdapter,
  );
  return { daemon, codex, opencode, mux };
}

const baseConfig: SpawnConfig = { prompt: 'hi' };

describe('MultiplexingProcessAdapter routing', () => {
  it('routes codex provider to the codex adapter', async () => {
    const { codex, daemon, mux } = build();
    const handle = await mux.spawn({ ...baseConfig, extra: { provider: 'codex' } });
    expect(handle.processId).toBe('codex-handle');
    expect(codex.spawnedConfigs).toHaveLength(1);
    expect(daemon.spawnedConfigs).toHaveLength(0);
    expect(mux.capabilitiesFor('codex').approvals).toBe('fixed-never');
  });

  it('runs Claude through the daemon, the user\'s own CLI', async () => {
    const { daemon, mux } = build();
    const handle = await mux.spawn(baseConfig);
    expect(handle.processId).toBe('daemon-handle');
    expect(daemon.spawnedConfigs).toHaveLength(1);
  });

  it('ignores the SDK flag an older Lattice may have persisted in a session\'s launch config', async () => {
    const { daemon, mux } = build();
    const handle = await mux.spawn({ ...baseConfig, extra: { provider: 'claude', useSdkAdapter: true } });
    expect(handle.processId).toBe('daemon-handle');
    expect(daemon.spawnedConfigs).toHaveLength(1);
  });
});
