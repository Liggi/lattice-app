import type { Provider } from '@/types/unified-messages';

export type LaunchPermissionMode = 'bypassPermissions';
export type LaunchProvider = Provider;

export const LAST_PERMISSION_MODE_KEY = 'claudia-last-permission-mode';

export function normalizeLaunchPermissionMode(
  _value?: string,
  _provider?: LaunchProvider
): LaunchPermissionMode {
  return 'bypassPermissions';
}

export function readLastLaunchPermissionMode(
  fallback?: string,
  provider?: LaunchProvider
): LaunchPermissionMode {
  try {
    const stored = localStorage.getItem(LAST_PERMISSION_MODE_KEY);
    if (stored === 'default' || stored === 'acceptEdits' || stored === 'bypassPermissions') {
      return normalizeLaunchPermissionMode(stored, provider);
    }
  } catch {
    // Ignore storage failures and fall back below.
  }

  return normalizeLaunchPermissionMode(fallback, provider);
}

export function resolveInitialLaunchPermissionMode(options: {
  explicit?: string;
  fallback?: string;
  provider?: LaunchProvider;
}): LaunchPermissionMode {
  const { explicit, fallback, provider } = options;

  if (typeof explicit === 'string' && explicit.length > 0) {
    return normalizeLaunchPermissionMode(explicit, provider);
  }

  return readLastLaunchPermissionMode(fallback, provider);
}

export function persistLastLaunchPermissionMode(mode: LaunchPermissionMode): void {
  try {
    localStorage.setItem(LAST_PERMISSION_MODE_KEY, mode);
  } catch {
    // Ignore storage failures.
  }
}
