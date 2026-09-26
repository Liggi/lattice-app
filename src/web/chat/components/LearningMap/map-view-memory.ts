/**
 * Where you were in a map.
 *
 * A map is something you switch into and back out of, so leaving and returning
 * should put you back where you were rather than at the top: the article you
 * had open, and which side of the split was expanded. Viewport pan/zoom is
 * deliberately not stored — the canvas fits the graph on entry, which is the
 * more useful landing state while maps stay small.
 *
 * localStorage, keyed per map, same pattern as the chat's pending annotations.
 * Subscribers are notified on write so a toggle re-renders the workspace.
 */

import { useSyncExternalStore } from 'react';
import { storage } from '../../utils/storage';

export interface MapView {
  /** Last article opened in this map, reopened on a bare `/map/:mapId`. */
  articleId: string | null;
  /** True when the map takes two thirds of the width, as it does on arrival. */
  mapExpanded: boolean;
}

const DEFAULT_VIEW: MapView = { articleId: null, mapExpanded: true };

export const MAP_VIEW_STORAGE_PREFIX = 'lattice-km-view-';

export function mapViewStorageKey(mapId: string): string {
  return `${MAP_VIEW_STORAGE_PREFIX}${mapId}`;
}

const listeners = new Set<() => void>();
/** Cached so `readMapView` can be a stable snapshot source for React. */
const cache = new Map<string, MapView>();

function sanitize(value: unknown): MapView {
  if (!value || typeof value !== 'object') return DEFAULT_VIEW;
  const candidate = value as Partial<MapView>;
  return {
    articleId: typeof candidate.articleId === 'string' ? candidate.articleId : null,
    mapExpanded: typeof candidate.mapExpanded === 'boolean' ? candidate.mapExpanded : true,
  };
}

/** Current remembered view for a map. Defaults are the first-visit state. */
export function readMapView(mapId: string): MapView {
  if (!mapId) return DEFAULT_VIEW;
  const cached = cache.get(mapId);
  if (cached) return cached;
  const loaded = sanitize(storage.get<unknown>(mapViewStorageKey(mapId), null));
  cache.set(mapId, loaded);
  return loaded;
}

/** Merge a partial update into the remembered view and notify subscribers. */
export function writeMapView(mapId: string, patch: Partial<MapView>): void {
  if (!mapId) return;
  const current = readMapView(mapId);
  const next: MapView = { ...current, ...patch };
  if (next.articleId === current.articleId && next.mapExpanded === current.mapExpanded) return;
  cache.set(mapId, next);
  storage.set(mapViewStorageKey(mapId), next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-renders the caller whenever any remembered view changes. */
export function useMapView(mapId: string): MapView {
  return useSyncExternalStore(
    subscribe,
    () => readMapView(mapId),
    () => DEFAULT_VIEW,
  );
}

/** Test seam — drops the in-memory cache so storage is re-read. */
export function resetMapViewCache(): void {
  cache.clear();
}
