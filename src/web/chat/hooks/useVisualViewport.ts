import { useEffect, useState } from 'react';
import type { ViewportMetrics } from '../utils/annotation-viewport';

function readMetrics(): ViewportMetrics {
  if (typeof window === 'undefined') {
    return { width: 1024, height: 768, offsetTop: 0, layoutHeight: 768 };
  }
  const layoutHeight = window.innerHeight;
  const visual = window.visualViewport;
  return {
    width: visual?.width ?? window.innerWidth,
    height: visual?.height ?? layoutHeight,
    offsetTop: visual?.offsetTop ?? 0,
    layoutHeight,
  };
}

function sameMetrics(a: ViewportMetrics, b: ViewportMetrics): boolean {
  return a.width === b.width
    && a.height === b.height
    && a.offsetTop === b.offsetTop
    && a.layoutHeight === b.layoutHeight;
}

/**
 * Tracks the visual viewport so fixed UI can ride above a software keyboard.
 *
 * `visualViewport` fires `resize` when the keyboard opens or closes and
 * `scroll` when iOS pans the visual viewport within the layout viewport to
 * reveal a focused input — both change where the visible bottom edge is, so
 * both are subscribed.
 */
export function useVisualViewport(): ViewportMetrics {
  const [metrics, setMetrics] = useState<ViewportMetrics>(readMetrics);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = readMetrics();
        setMetrics((prev) => (sameMetrics(prev, next) ? prev : next));
      });
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    const visual = window.visualViewport;
    visual?.addEventListener('resize', update);
    visual?.addEventListener('scroll', update);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      visual?.removeEventListener('resize', update);
      visual?.removeEventListener('scroll', update);
    };
  }, []);

  return metrics;
}

/** Live `(pointer: coarse)` match — touch devices, including iPad with a keyboard. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try {
      return window.matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia('(pointer: coarse)');
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    setCoarse(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return coarse;
}
