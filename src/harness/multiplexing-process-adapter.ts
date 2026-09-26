import type { ProcessAdapter, ProcessHandle, SpawnConfig } from '@liggi/agent-ui-harness/server';
import { DaemonProcessAdapter } from './daemon-process-adapter.js';
import { CodexProcessAdapter } from './codex-process-adapter.js';
import { OpencodeProcessAdapter } from './opencode-process-adapter.js';
import {
  createProviderDriver,
  type ProviderDriver,
} from './provider-driver.js';
import type { Provider } from '../types/unified-messages.js';
import type { ProviderCapabilities } from '../types/provider-capabilities.js';

export class MultiplexingProcessAdapter implements ProcessAdapter {
  readonly managedStreamingIds = new Set<string>();
  private readonly claudeDriver: ProviderDriver;
  private readonly codexDriver: ProviderDriver;
  private readonly opencodeDriver: ProviderDriver;

  constructor(
    private readonly claudeAdapter: DaemonProcessAdapter,
    private readonly codexAdapter: CodexProcessAdapter,
    private readonly opencodeAdapter: OpencodeProcessAdapter,
  ) {
    this.claudeDriver = createProviderDriver('claude', 'claude-daemon', claudeAdapter);
    this.codexDriver = createProviderDriver('codex', 'codex-app-server', codexAdapter);
    this.opencodeDriver = createProviderDriver('opencode', 'opencode-server', opencodeAdapter);
  }

  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    const driver = this.resolveDriver(config);
    const handle = await driver.adapter.spawn(config);

    if (handle.processId) {
      this.managedStreamingIds.add(handle.processId);
    }

    return handle;
  }

  hasActiveCodexThread(threadId: string): boolean {
    return this.codexAdapter.hasActiveThread(threadId);
  }

  hasActiveOpencodeSession(sessionId: string): boolean {
    return this.opencodeAdapter.hasActiveSession(sessionId);
  }

  capabilitiesFor(provider: Provider): ProviderCapabilities {
    return this.driverFor(provider).capabilities;
  }

  private driverFor(provider: Provider): ProviderDriver {
    switch (provider) {
      case 'codex':
        return this.codexDriver;
      case 'opencode':
        return this.opencodeDriver;
      case 'claude':
        return this.claudeDriver;
    }
  }

  /**
   * Claude has one route: the user's own installed CLI, through the daemon.
   * A session persisted by an older Lattice may still carry `useSdkAdapter`
   * in its launch config; it is ignored, and the session resumes on the CLI.
   */
  private resolveDriver(config: SpawnConfig): ProviderDriver {
    const provider = config.extra?.provider;
    if (provider === 'codex') return this.codexDriver;
    if (provider === 'opencode') return this.opencodeDriver;
    return this.claudeDriver;
  }
}
