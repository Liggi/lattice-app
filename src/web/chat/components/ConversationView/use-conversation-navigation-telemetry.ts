import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { api } from '../../services/api';
import { sendClientTelemetry } from '../../services/client-telemetry';
import { isUnifiedConversation } from './send-routing';

type NavigationStateRef = MutableRefObject<{ conversationId?: string; time?: number; traceId?: string }>;

export function useConversationNavigationTelemetry(params: {
  conversationId?: string;
  conversationDetails?: { sessionId?: string; messages?: unknown[]; totalMessages?: number };
  insights?: { context?: { mission?: string } | null } | null;
  navStartRef: NavigationStateRef;
  navigationDebugEnabled: boolean;
}): {
  onPerfRender: (id: string, phase: string, actualDuration: number, baseDuration: number) => void;
} {
  const { conversationId, conversationDetails, insights, navStartRef, navigationDebugEnabled } = params;
  const detailsLoggedRef = useRef<string | null>(null);
  const insightsLoggedRef = useRef<string | null>(null);
  const stallTelemetryByEventRef = useRef<Map<string, number>>(new Map());
  const perfLoggingEnabled = typeof window !== 'undefined' && window.localStorage.getItem('perf-debug') === '1';

  const onPerfRender = useCallback((
    _id: string,
    _phase: string,
    actualDuration: number,
    _baseDuration: number
  ) => {
    if (!perfLoggingEnabled) return;
    if (actualDuration < 32) return;
  }, [perfLoggingEnabled]);

  useEffect(() => {
    if (!conversationId) return;
    const traceId = `nav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    navStartRef.current = { conversationId, time: performance.now(), traceId };
    detailsLoggedRef.current = null;
    insightsLoggedRef.current = null;
  }, [conversationId, navigationDebugEnabled, navStartRef]);

  // Session-switch assertion: after navigation to a conv-* session, the latest
  // segment should stabilize to active quickly when runtime status is ongoing.
  useEffect(() => {
    if (!conversationId || !isUnifiedConversation(conversationId)) return;
    let cancelled = false;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const summary = await api.getConversationStatus(conversationId);
          if (cancelled) return;
          if (summary.status !== 'ongoing') return;

          const unifiedConversation = await api.getUnifiedConversation(conversationId);
          if (cancelled) return;

          const latestSegment = unifiedConversation.segments
            .slice()
            .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
            .at(-1);
          if (latestSegment?.status === 'active') return;

          const nowMs = Date.now();
          const eventName = 'session-switch-segment-status-mismatch';
          const lastSent = stallTelemetryByEventRef.current.get(eventName);
          if (lastSent === undefined || nowMs - lastSent >= 10_000) {
            stallTelemetryByEventRef.current.set(eventName, nowMs);
            sendClientTelemetry({
              component: 'ConversationView',
              event: eventName,
              severity: 'warn',
              details: {
                conversationId: conversationId.slice(0, 8),
                conversationStatus: summary.status,
                activeStreamingId: summary.streamingId || null,
                latestSegmentId: latestSegment?.segmentId || null,
                latestSegmentProvider: latestSegment?.provider || null,
                latestSegmentStatus: latestSegment?.status || 'missing',
              },
            });
          }

        } catch (_error) {
          if (cancelled) return;
        }
      })();
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId || !conversationDetails) return;
    if (detailsLoggedRef.current === conversationId) return;
    detailsLoggedRef.current = conversationId;
    const navState = navStartRef.current;
    const start = navState.conversationId === conversationId ? navState.time : undefined;
    const _deltaMs = start ? Math.round(performance.now() - start) : null;
    const _traceId = navState.conversationId === conversationId ? navState.traceId : undefined;
  }, [conversationDetails, conversationId, navStartRef]);

  useEffect(() => {
    if (!conversationId || !insights) return;
    if (insightsLoggedRef.current === conversationId) return;
    insightsLoggedRef.current = conversationId;
    const start = navStartRef.current.conversationId === conversationId ? navStartRef.current.time : undefined;
    const _deltaMs = start ? Math.round(performance.now() - start) : null;
  }, [conversationId, insights, navStartRef]);

  return {
    onPerfRender,
  };
}
