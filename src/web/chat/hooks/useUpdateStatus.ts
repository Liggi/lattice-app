import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import type { UpdateStatus } from '@/types/update';

export const updateStatusQueryKey = ['update', 'status'] as const;

/** What the server knows about newer Lattice releases; it checks the registry daily itself. */
export function useUpdateStatus(): UpdateStatus | null {
  const { data } = useQuery({
    queryKey: updateStatusQueryKey,
    queryFn: () => api.getUpdateStatus(),
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
  return data ?? null;
}
