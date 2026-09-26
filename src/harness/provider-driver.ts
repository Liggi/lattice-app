import type { ProcessAdapter } from '@liggi/agent-ui-harness/server';
import type { Provider } from '../types/unified-messages.js';
import {
  getProviderCapabilities,
  type ProviderCapabilities,
} from '../types/provider-capabilities.js';

export type ProviderTransport =
  | 'claude-daemon'
  | 'codex-app-server'
  | 'opencode-server';

/**
 * One provider/transport implementation behind the shared harness contract.
 * Capabilities describe the product surface; the adapter owns process I/O.
 */
export interface ProviderDriver {
  provider: Provider;
  transport: ProviderTransport;
  capabilities: ProviderCapabilities;
  adapter: ProcessAdapter;
}

export function createProviderDriver(
  provider: Provider,
  transport: ProviderTransport,
  adapter: ProcessAdapter,
): ProviderDriver {
  return {
    provider,
    transport,
    capabilities: getProviderCapabilities(provider),
    adapter,
  };
}
