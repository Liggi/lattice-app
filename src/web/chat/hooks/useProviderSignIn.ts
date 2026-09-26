import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { parseJson } from '../../../utils/json.js';

import type { ProviderSignIn } from '@/constants/coordinator-defaults.js';

export type { ProviderSignIn };

export interface ProviderSignInStatus {
  claude: ProviderSignIn;
  codex: ProviderSignIn;
}

export const PROVIDER_SIGN_IN_QUERY_KEY = ['provider-sign-in'] as const;

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return parseJson(await response.text()) as unknown;
}

function claudeSignIn(body: unknown): ProviderSignIn {
  const status = body as { available?: boolean; installed?: boolean; status?: { loggedIn?: unknown } };
  if (!status.available) return status.installed ? 'unavailable' : 'not-installed';
  return status.status?.loggedIn === true ? 'signed-in' : 'signed-out';
}

function codexSignIn(body: unknown): ProviderSignIn {
  const status = body as { available?: boolean; installed?: boolean; loggedIn?: boolean };
  if (!status.available) return status.installed ? 'unavailable' : 'not-installed';
  return status.loggedIn ? 'signed-in' : 'signed-out';
}

export function useProviderSignIn(): UseQueryResult<ProviderSignInStatus> {
  return useQuery({
    queryKey: PROVIDER_SIGN_IN_QUERY_KEY,
    queryFn: async (): Promise<ProviderSignInStatus> => {
      const [claude, codex] = await Promise.all([
        readJson('/api/provider-auth/claude/status'),
        readJson('/api/provider-auth/codex/status'),
      ]);
      return { claude: claudeSignIn(claude), codex: codexSignIn(codex) };
    },
    staleTime: 30_000,
    retry: false,
  });
}
