/**
 * One line on the first screen when the provider about to start is not ready,
 * linking to Settings → Providers. Nothing is shown when it is signed in.
 */

import React from 'react';
import type { ProviderSignIn, ProviderSignInStatus as Status } from '../../hooks/useProviderSignIn';

const LABELS = { claude: 'Claude', codex: 'Codex' } as const;

function describe(state: Exclude<ProviderSignIn, 'signed-in'>, label: string): string {
  if (state === 'not-installed') return `${label} is not installed.`;
  if (state === 'unavailable') return `${label} is unavailable.`;
  return `${label} is signed out.`;
}

interface ProviderSignInStatusProps {
  status: Status | undefined;
  provider: 'claude' | 'codex';
  onOpenProviders: () => void;
}

export function ProviderSignInStatus({ status, provider, onOpenProviders }: ProviderSignInStatusProps): JSX.Element | null {
  const state = status?.[provider];
  if (!state || state === 'signed-in') return null;
  return (
    <p className="px-4 text-center text-xs text-fg-3" data-testid="provider-sign-in-status" data-state={state}>
      {describe(state, LABELS[provider])}{' '}
      <button
        type="button"
        data-testid={`provider-sign-in-${provider}`}
        onClick={onOpenProviders}
        className="text-accent hover:text-fg cursor-pointer"
      >
        {state === 'signed-out' ? 'Sign in' : 'Open settings'}
      </button>
    </p>
  );
}
