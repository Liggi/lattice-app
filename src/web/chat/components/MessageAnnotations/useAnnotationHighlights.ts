import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildNormalizedTextIndex,
  findQuoteRangeInIndex,
  type NormalizedTextIndex,
} from '../../utils/annotation-range';
import type { PendingAnnotation } from '../../utils/annotations-format';

/** Registry name for the CSS Custom Highlight; styled in chat/styles/global.css. */
export const ANNOTATION_HIGHLIGHT_NAME = 'lattice-annotation';
/** The span under the pointer or being edited, painted a step stronger. */
export const ANNOTATION_ACTIVE_HIGHLIGHT_NAME = 'lattice-annotation-active';

export interface AnnotationSpanPlacement {
  annotationId: string;
  messageId: string;
  /** The assistant-message root — `position: relative`, so it anchors the icon. */
  host: HTMLElement;
  /** Live range over the quoted text; measure it when needed, it tracks the DOM. */
  range: Range;
}

/** Feature detection — Firefox shipped this late, older Safari not at all. */
export function supportsHighlightApi(): boolean {
  return typeof CSS !== 'undefined'
    && typeof Highlight !== 'undefined'
    && 'highlights' in CSS
    && CSS.highlights !== undefined;
}

function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Where an annotation's quote lives in the DOM. The default looks inside
 * assistant messages. The returned element must be `position: relative` —
 * icons are portalled into it.
 */
export type AnnotationHostResolver = (annotatedId: string) => HTMLElement | null;

function resolveAssistantHost(messageId: string): HTMLElement | null {
  const wrapper = document.querySelector(
    `[data-message-id="${escapeAttrValue(messageId)}"]`,
  );
  return (wrapper?.querySelector('[data-testid="assistant-message"]') as HTMLElement | null) ?? null;
}

function samePlacements(a: AnnotationSpanPlacement[], b: AnnotationSpanPlacement[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].annotationId !== b[i].annotationId) return false;
    if (a[i].host !== b[i].host) return false;
    if (a[i].range !== b[i].range) return false;
  }
  return true;
}

interface ResolvedEntry {
  host: HTMLElement;
  textLength: number;
  range: Range;
}

/**
 * Resolves each pending annotation's quote to a live Range in the transcript,
 * paints it with the CSS Custom Highlight API, and returns the live ranges so
 * callers can hit-test and anchor to them.
 *
 * The transcript is virtualized and re-renders on every streamed event, so
 * resolution is hooked to a render effect (rather than run once) and coalesced
 * into a single animation frame. A message that is unmounted simply drops out
 * of the result — the compact line above the composer remains the authoritative
 * count of what is pending.
 */
export function useAnnotationHighlights(
  annotations: PendingAnnotation[],
  resolveHost: AnnotationHostResolver = resolveAssistantHost,
): AnnotationSpanPlacement[] {
  const [placements, setPlacements] = useState<AnnotationSpanPlacement[]>([]);

  const resolveHostRef = useRef(resolveHost);
  resolveHostRef.current = resolveHost;

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const placementsRef = useRef<AnnotationSpanPlacement[]>(placements);
  placementsRef.current = placements;

  const cacheRef = useRef<Map<string, ResolvedEntry>>(new Map());
  const observedRef = useRef<Set<Element>>(new Set());
  const observerRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef(0);

  const resolve = useCallback(() => {
    if (typeof document === 'undefined') return;

    const cache = cacheRef.current;
    const nextPlacements: AnnotationSpanPlacement[] = [];
    const ranges: Range[] = [];
    const indexByHost = new Map<HTMLElement, NormalizedTextIndex>();
    const liveIds = new Set<string>();
    const hostsThisPass = new Set<Element>();

    for (const annotation of annotationsRef.current) {
      liveIds.add(annotation.id);

      const host = resolveHostRef.current(annotation.messageId);
      if (!host || !host.isConnected) {
        cache.delete(annotation.id);
        continue;
      }
      hostsThisPass.add(host);

      // Re-resolving is only needed when the message was remounted or its text
      // changed; a Range tracks DOM mutations on its own otherwise.
      const textLength = host.textContent?.length ?? 0;
      const cached = cache.get(annotation.id);
      let range: Range | null = null;
      if (cached && cached.host === host && cached.textLength === textLength) {
        range = cached.range;
      } else {
        let index = indexByHost.get(host);
        if (!index) {
          index = buildNormalizedTextIndex(host);
          indexByHost.set(host, index);
        }
        range = findQuoteRangeInIndex(index, annotation.quote, annotation.quoteStart);
        if (range) {
          cache.set(annotation.id, { host, textLength, range });
        } else {
          cache.delete(annotation.id);
        }
      }
      if (!range) continue;

      ranges.push(range);
      nextPlacements.push({
        annotationId: annotation.id,
        messageId: annotation.messageId,
        host,
        range,
      });
    }

    // Drop cache entries for annotations that no longer exist.
    for (const id of Array.from(cache.keys())) {
      if (!liveIds.has(id)) cache.delete(id);
    }

    if (supportsHighlightApi()) {
      try {
        if (ranges.length === 0) {
          CSS.highlights.delete(ANNOTATION_HIGHLIGHT_NAME);
        } else {
          CSS.highlights.set(ANNOTATION_HIGHLIGHT_NAME, new Highlight(...ranges));
        }
      } catch {
        // Highlighting is decorative — never let it break the surrounding UI.
      }
    }

    // Observe exactly the hosts in play. Adding an already-observed element
    // would re-fire the observer and spin the animation frame forever.
    const observer = observerRef.current;
    if (observer) {
      for (const element of Array.from(observedRef.current)) {
        if (!hostsThisPass.has(element)) {
          observer.unobserve(element);
          observedRef.current.delete(element);
        }
      }
      for (const element of hostsThisPass) {
        if (!observedRef.current.has(element)) {
          observer.observe(element);
          observedRef.current.add(element);
        }
      }
    }

    if (!samePlacements(placementsRef.current, nextPlacements)) {
      setPlacements(nextPlacements);
    }
  }, []);

  const schedule = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      resolve();
    });
  }, [resolve]);

  // After every render of the owning component — the transcript re-renders on
  // mount, unmount, and each streamed chunk, which is exactly when a resolved
  // range can go stale.
  useEffect(() => {
    schedule();
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (typeof ResizeObserver !== 'undefined' && !observerRef.current) {
      observerRef.current = new ResizeObserver(() => schedule());
    }
    window.addEventListener('resize', schedule);

    return () => {
      window.removeEventListener('resize', schedule);
    };
  }, [schedule]);

  // Teardown: drop the highlight registry entry and stop observing.
  useEffect(() => {
    // These two collections are created once and only ever mutated in place,
    // so capturing them here is equivalent to reading the refs at cleanup.
    const observed = observedRef.current;
    const cache = cacheRef.current;
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      // Reset, or a remount (StrictMode runs effects twice) finds a stale id
      // and `schedule` never runs again, so nothing is ever highlighted.
      frameRef.current = 0;
      observerRef.current?.disconnect();
      observerRef.current = null;
      observed.clear();
      cache.clear();
      if (supportsHighlightApi()) {
        try {
          CSS.highlights.delete(ANNOTATION_HIGHLIGHT_NAME);
        } catch {
          // Nothing to clean up.
        }
      }
    };
  }, []);

  return placements;
}
