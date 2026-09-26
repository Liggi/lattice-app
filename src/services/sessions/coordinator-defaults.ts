/**
 * The coordinator defaults (src/constants/coordinator-defaults.ts) for this
 * server's config.
 */

import {
  coordinatorClaudeModelFrom,
  coordinatorCodexDefaultsFrom,
  coordinatorProviderFor,
  type CoordinatorCodexDefaults,
  type CoordinatorSettings,
  type ProviderSignIn,
} from '@/constants/coordinator-defaults.js';
import { ConfigService } from '@/services/infrastructure/config-service.js';
import { getProviderAuthService } from '@/services/provider-auth-service.js';

export type { CoordinatorCodexDefaults };

function settings(): CoordinatorSettings | undefined {
  try {
    return ConfigService.getInstance().getConfig();
  } catch {
    return undefined;
  }
}

/** Each provider's sign-in, read the same way as the composer's /api/provider-auth status. */
async function providerSignIn(): Promise<Record<'claude' | 'codex', ProviderSignIn>> {
  const auth = getProviderAuthService();
  const [claude, codex] = await Promise.all([auth.getClaudeAuthStatus(), auth.getCodexAuthStatus()]);
  const loggedIn = (claude.status as { loggedIn?: unknown } | undefined)?.loggedIn === true;
  return {
    claude: !claude.available ? (claude.installed ? 'unavailable' : 'not-installed') : loggedIn ? 'signed-in' : 'signed-out',
    codex: !codex.available ? (codex.installed ? 'unavailable' : 'not-installed') : codex.loggedIn ? 'signed-in' : 'signed-out',
  };
}

/**
 * The provider a coordinator starts on when the caller names none: the
 * configured one, or the other when only that one is signed in.
 */
export async function coordinatorProvider(): Promise<'claude' | 'codex'> {
  return coordinatorProviderFor(settings(), await providerSignIn());
}

/** The Claude model a coordinator starts on when the caller names none, or undefined for the CLI's default. */
export function coordinatorClaudeModel(): string | undefined {
  return coordinatorClaudeModelFrom(settings());
}

/** The coordinator's Codex model and effort. */
export function coordinatorCodexDefaults(): CoordinatorCodexDefaults {
  return coordinatorCodexDefaultsFrom(settings());
}
