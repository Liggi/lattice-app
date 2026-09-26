/**
 * Argus's per-session reads, keyed by conversation id, for the sidebar.
 *
 * The ambient scan (scripts/ambient-scan.ts, run by the watcher) writes
 * ~/.lattice/ambient/latest.json on every turn-end boundary; the server serves
 * it at /ambient/latest.json. That read is fresher than session insights —
 * insights freeze a mission at session start and regenerate rarely, so a card
 * can describe what a session set out to do while it is doing something else
 * entirely. Argus rescans whenever a turn ends.
 *
 * The sidebar already has its conversations; all it needs is the lookup.
 *
 * Absence is normal and silent: the scan skips sessions dormant beyond 48h, and
 * the whole file is missing if the watcher isn't running. Cards fall back to
 * their insight-derived text in both cases.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AmbientPayload, AmbientRead } from '../components/AmbientPortfolio/ambient-types';

export const ambientReadsQueryKey = ['ambient-reads'] as const;

/** Matches the ambient watcher's own cadence; the file only changes on turn boundaries. */
export const AMBIENT_POLL_MS = 30_000;

/** Single fetcher for /ambient/latest.json, cached under `ambientReadsQueryKey`. */
export async function fetchAmbientPayload(): Promise<AmbientPayload | null> {
  // Cache-bust: the file is rewritten in place, so a conditional request can
  // hand back a stale body through the disk cache.
  const response = await fetch(`/ambient/latest.json?ts=${Date.now()}`);
  if (!response.ok) return null;
  return (await response.json()) as AmbientPayload;
}

export function useAmbientReads(options?: { enabled?: boolean }): {
  readsBySessionId: Map<string, AmbientRead>;
  generatedAt: string | null;
} {
  const enabled = options?.enabled ?? true;

  const query = useQuery({
    queryKey: ambientReadsQueryKey,
    queryFn: fetchAmbientPayload,
    enabled,
    refetchInterval: enabled ? AMBIENT_POLL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: AMBIENT_POLL_MS,
    // A missing or unparseable scan is an expected state, not an error worth
    // retrying into.
    retry: false,
  });

  const payload = query.data ?? null;
  // Rebuilt only when the payload changes: consumers hold this Map in render-scope
  // deps, so a fresh identity every render would fan out into their memos.
  const readsBySessionId = useMemo(() => {
    const byId = new Map<string, AmbientRead>();
    for (const read of payload?.reads ?? []) {
      if (read?.sessionId) byId.set(read.sessionId, read);
    }
    return byId;
  }, [payload]);

  return { readsBySessionId, generatedAt: payload?.generatedAt ?? null };
}
