/**
 * useHydrationTrace — client-side diagnostic for mobile cold-load and
 * SSE-reconnect symptoms.
 *
 * Posts structured trace events to /api/debug/hydration-trace on every
 * relevant transition (hydrationPhase, connected, latticeStatus,
 * visibilitychange) plus one snapshot per page-load. Each event is tagged
 * with a per-tab `traceId` so the server-side log lines for one mobile
 * session can be grepped out cleanly.
 *
 * The hypothesis under investigation: on iOS Chrome, when a tab is suspended
 * and re-foregrounded, the hydrationPhase gate is not re-engaging on SSE
 * reconnect — so the chat view replays events live, transiently deriving
 * 'streaming' between content and turn:end (the rewind+thinking symptom).
 *
 * Listening for visibilitychange catches the iOS suspend/resume edge.
 * sendBeacon is used for the visibility-hidden path because regular fetch
 * gets aborted when the tab suspends.
 */

import { useEffect, useRef } from 'react';
import type { HydrationPhase } from '@liggi/agent-ui-harness/client';
import type { Status as HarnessStatus } from '@liggi/agent-ui-harness/protocol';

interface TraceState {
  conversationId: string | null;
  rawStatus: HarnessStatus;
  latticeStatus: 'idle' | 'initializing' | 'streaming' | 'stopping';
  hydrationPhase: HydrationPhase;
  connected: boolean;
  processAlive: boolean;
  eventCount: number;
  lastEventSeq: number | null;
  lastEventType: string | null;
}

interface TracePayload extends Partial<TraceState> {
  traceId: string;
  kind: string;
  prev?: unknown;
  next?: unknown;
  visibility?: string;
  isMobile?: boolean;
  userAgent?: string;
  ts: string;
  pageLoadAt?: string;
  notes?: string;
}

const ENDPOINT = '/api/debug/hydration-trace';
const TRACE_ID_KEY = 'lattice-hydration-trace-id';
const PAGE_LOAD_KEY = 'lattice-hydration-page-load-at';

function getTraceId(): string {
  if (typeof window === 'undefined') return 'ssr';
  try {
    let id = sessionStorage.getItem(TRACE_ID_KEY);
    if (!id) {
      id = `t-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
      sessionStorage.setItem(TRACE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'no-storage';
  }
}

function getPageLoadAt(): string {
  if (typeof window === 'undefined') return '';
  try {
    let v = sessionStorage.getItem(PAGE_LOAD_KEY);
    if (!v) {
      v = new Date().toISOString();
      sessionStorage.setItem(PAGE_LOAD_KEY, v);
    }
    return v;
  } catch {
    return '';
  }
}

function detectMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
}

function shortUserAgent(): string {
  if (typeof navigator === 'undefined') return '';
  // Keep it short — the full UA bloats every log line. Just enough to
  // distinguish iOS Chrome / iOS Safari / Android Chrome / desktop.
  const ua = navigator.userAgent || '';
  return ua.slice(0, 160);
}

function postTrace(payload: TracePayload, useBeacon = false): void {
  if (typeof window === 'undefined') return;
  try {
    const body = JSON.stringify(payload);
    if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(ENDPOINT, blob);
      return;
    }
    // Regular fetch with keepalive so it survives short navigations.
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* swallow — diagnostic only */ });
  } catch {
    // Diagnostic only; never let a trace failure affect the UI.
  }
}

export function useHydrationTrace(state: TraceState): void {
  const prevRef = useRef<TraceState | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!state.conversationId) return;

    const traceId = getTraceId();
    const pageLoadAt = getPageLoadAt();
    const isMobile = detectMobile();
    const userAgent = shortUserAgent();
    const visibility = typeof document !== 'undefined' ? document.visibilityState : 'unknown';

    const base: Omit<TracePayload, 'kind' | 'ts'> = {
      traceId,
      conversationId: state.conversationId,
      rawStatus: state.rawStatus,
      latticeStatus: state.latticeStatus,
      hydrationPhase: state.hydrationPhase,
      connected: state.connected,
      processAlive: state.processAlive,
      eventCount: state.eventCount,
      lastEventSeq: state.lastEventSeq,
      lastEventType: state.lastEventType,
      visibility,
      isMobile,
      userAgent,
      pageLoadAt,
    };

    const send = (kind: string, extra?: { prev?: unknown; next?: unknown; notes?: string }) => {
      postTrace({
        ...base,
        kind,
        ts: new Date().toISOString(),
        prev: extra?.prev,
        next: extra?.next,
        notes: extra?.notes,
      });
    };

    // First mount per conversation: emit a snapshot so we know the starting state.
    if (!initializedRef.current) {
      initializedRef.current = true;
      send('mount');
      prevRef.current = state;
      return;
    }

    const prev = prevRef.current;
    if (!prev) {
      prevRef.current = state;
      return;
    }

    if (prev.hydrationPhase !== state.hydrationPhase) {
      send('hydrationPhase', { prev: prev.hydrationPhase, next: state.hydrationPhase });
    }
    if (prev.connected !== state.connected) {
      send('connected', { prev: prev.connected, next: state.connected });
    }
    if (prev.latticeStatus !== state.latticeStatus) {
      send('latticeStatus', { prev: prev.latticeStatus, next: state.latticeStatus });
    }
    if (prev.rawStatus !== state.rawStatus) {
      send('rawStatus', { prev: prev.rawStatus, next: state.rawStatus });
    }
    if (prev.processAlive !== state.processAlive) {
      send('processAlive', { prev: prev.processAlive, next: state.processAlive });
    }

    prevRef.current = state;
  }, [
    state,
    state.conversationId,
    state.rawStatus,
    state.latticeStatus,
    state.hydrationPhase,
    state.connected,
    state.processAlive,
    state.eventCount,
    state.lastEventSeq,
    state.lastEventType,
  ]);

  // Visibility transitions — the iOS tab-suspension edge. Logged with the
  // freshest state available via the ref so the visibility transition is
  // anchored to what the gate looked like at the moment of suspend/resume.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (!state.conversationId) return;

    const onVisibilityChange = () => {
      const traceId = getTraceId();
      const pageLoadAt = getPageLoadAt();
      const isMobile = detectMobile();
      const userAgent = shortUserAgent();
      const v = document.visibilityState;
      // Use sendBeacon when going hidden, since the tab may suspend before
      // a fetch resolves on iOS.
      const useBeacon = v === 'hidden';
      const snap = prevRef.current ?? state;
      postTrace({
        traceId,
        conversationId: snap.conversationId,
        rawStatus: snap.rawStatus,
        latticeStatus: snap.latticeStatus,
        hydrationPhase: snap.hydrationPhase,
        connected: snap.connected,
        processAlive: snap.processAlive,
        eventCount: snap.eventCount,
        lastEventSeq: snap.lastEventSeq,
        lastEventType: snap.lastEventType,
        visibility: v,
        isMobile,
        userAgent,
        pageLoadAt,
        kind: 'visibility',
        next: v,
        ts: new Date().toISOString(),
      }, useBeacon);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [state, state.conversationId]);
}
