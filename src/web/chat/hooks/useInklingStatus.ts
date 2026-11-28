import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { parseJson } from '../../../utils/json.js';

export interface InklingStatus {
  installed: boolean;
  /** Whether the local model server answered its health check. */
  serverReachable: boolean;
  baseUrl: string;
}

/** Whether this server can start Inkling sessions: the `inkling` CLI is installed, and its model server is up. */
export function useInklingStatus(): UseQueryResult<InklingStatus> {
  return useQuery({
    queryKey: ['inkling-status'],
    queryFn: async (): Promise<InklingStatus> => {
      const response = await fetch('/api/provider-auth/inkling/status');
      if (!response.ok) throw new Error(`/api/provider-auth/inkling/status: HTTP ${response.status}`);
      return parseJson(await response.text()) as InklingStatus;
    },
    staleTime: 30_000,
    retry: false,
  });
}
