/**
 * ActivityStreamContext - Topic-based pub/sub for cross-session activity events,
 * fed by the server's `/api/conv/activity-stream` SSE endpoint.
 *
 * History: the original SSE transport (`/api/mux-stream`) was deleted in an
 * April 2026 cleanup and this context spent months as a no-op shell, leaving
 * every consumer on its polling fallback — the source of both the stale
 * sidebar and the constant request churn. The server has long since exposed
 * a full replacement stream; this client connects to it.
 *
 * Contract with consumers (unchanged from the shell era):
 * - subscribe({ type: 'activity' }, cb) receives every parsed server message
 *   (session-started/ended/idle, activity, insights, current-work, teams,
 *   permission and pending-question changes, ...). Consumers switch on
 *   `data.type` and ignore what they don't know.
 * - connectionState/isConnected report transport health. Pollers use this to
 *   relax their intervals while push is live and tighten them while it isn't.
 *
 * Reconnect policy: EventSource's built-in retry handles transient drops; a
 * manual exponential backoff (capped at 30s) takes over if the browser gives
 * up (readyState CLOSED, e.g. server restart mid-deploy). Retries never stop —
 * this is a personal tool whose server restarts routinely.
 */

import React, {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  ReactNode,
  useMemo,
} from 'react';
import { parseJson } from '../../../utils/json.js';

// =============================================================================
// Types
// =============================================================================

/** Topics that can be subscribed to */
export type StreamTopic =
  | { type: 'session'; sessionId: string }      // Per-session events only
  | { type: 'activity' };                        // All stream events

/** Connection state machine states */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

/** Full connection state */
export interface ConnectionState {
  status: ConnectionStatus;
  error: Error | null;
  reconnectAttempt: number;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
}

/** Subscriber callback */
type SubscriberCallback = (data: unknown) => void;

// =============================================================================
// Context
// =============================================================================

interface ActivityStreamContextValue {
  /** Current connection state */
  connectionState: ConnectionState;

  /** Subscribe to a topic. Returns unsubscribe function. */
  subscribe: (topic: StreamTopic, callback: SubscriberCallback) => () => void;

  /** Manually trigger reconnection */
  reconnect: () => void;

  /** Check if connected */
  isConnected: boolean;

  /** Check if currently trying to reconnect */
  isReconnecting: boolean;

  /** Derived error message for UI display */
  errorMessage: string | null;
}

const ActivityStreamContext = createContext<ActivityStreamContextValue | undefined>(undefined);

// =============================================================================
// Provider Component
// =============================================================================

const STREAM_URL = '/api/conv/activity-stream';
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

// The server writes a ping every 30s (unified-conversation.transport-routes).
// A connection silent for longer than one ping plus slack is a zombie:
// readyState still reads OPEN, so the CLOSED check below can't see it. This
// matters most on a phone — backgrounding the browser kills the TCP stream
// without erroring the EventSource, and a zombie here reports
// isConnected=true, which relaxes every status poll to its slow safety-net
// interval. The UI then shows stale WORKING with nothing left to correct it.
const STALE_AFTER_MS = 35_000;
// Sweep for zombies that arise while the tab stays visible (network switch
// with no error event). Two missed pings = dead.
const WATCHDOG_INTERVAL_MS = 15_000;
const WATCHDOG_STALE_MS = 75_000;

export function ActivityStreamProvider({ children }: { children: ReactNode }): JSX.Element {
  const subscribersRef = useRef<Map<string, Set<SubscriberCallback>>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lastMessageAtRef = useRef(Date.now());

  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: 'disconnected',
    error: null,
    reconnectAttempt: 0,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
  });

  const publish = useCallback((key: string, data: unknown): void => {
    const callbacks = subscribersRef.current.get(key);
    if (!callbacks) return;
    for (const callback of callbacks) {
      try {
        callback(data);
      } catch (error) {
        // A throwing subscriber must not break delivery to the others.
        console.error('[ActivityStream] subscriber threw', error);
      }
    }
  }, []);

  const connect = useCallback((): void => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    eventSourceRef.current?.close();

    setConnectionState(prev => ({
      ...prev,
      status: reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting',
      reconnectAttempt: reconnectAttemptRef.current,
    }));

    const source = new EventSource(STREAM_URL);
    eventSourceRef.current = source;

    source.onopen = () => {
      reconnectAttemptRef.current = 0;
      lastMessageAtRef.current = Date.now();
      setConnectionState({
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        lastConnectedAt: new Date(),
        lastDisconnectedAt: null,
      });
    };

    source.onmessage = (event: MessageEvent<string>) => {
      lastMessageAtRef.current = Date.now();
      let data: unknown;
      try {
        data = parseJson(event.data);
      } catch {
        return;
      }
      const message = data as { type?: string; sessionId?: string };
      if (message.type === 'ping') return;

      publish('activity', data);
      if (typeof message.sessionId === 'string' && message.sessionId.length > 0) {
        publish(`session:${message.sessionId}`, data);
      }
    };

    source.onerror = () => {
      // CONNECTING means EventSource is retrying on its own — report the gap
      // but let it work. CLOSED means it gave up; take over with backoff.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        if (eventSourceRef.current === source) {
          eventSourceRef.current = null;
        }
        const attempt = reconnectAttemptRef.current + 1;
        reconnectAttemptRef.current = attempt;
        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * 2 ** Math.min(attempt, 5),
          MAX_RECONNECT_DELAY_MS,
        );
        setConnectionState(prev => ({
          ...prev,
          status: 'reconnecting',
          error: new Error('Activity stream connection lost'),
          reconnectAttempt: attempt,
          lastDisconnectedAt: new Date(),
        }));
        reconnectTimerRef.current = setTimeout(() => connect(), delay);
      } else {
        setConnectionState(prev => (
          prev.status === 'reconnecting'
            ? prev
            : { ...prev, status: 'reconnecting', lastDisconnectedAt: new Date() }
        ));
      }
    };
  }, [publish]);

  useEffect(() => {
    connect();

    // A machine waking from sleep or regaining network can leave a zombie
    // EventSource that neither errors nor receives. Force a reconnect when
    // connectivity returns or the tab becomes visible with a dead source.
    const handleOnline = (): void => connect();
    const handleVisibility = (): void => {
      if (document.visibilityState !== 'visible') return;
      const source = eventSourceRef.current;
      const stale = Date.now() - lastMessageAtRef.current > STALE_AFTER_MS;
      if (!source || source.readyState === EventSource.CLOSED || stale) {
        connect();
      }
    };
    const watchdog = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastMessageAtRef.current > WATCHDOG_STALE_MS) {
        connect();
      }
    }, WATCHDOG_INTERVAL_MS);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(watchdog);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [connect]);

  const subscribe = useCallback((topic: StreamTopic, callback: SubscriberCallback): (() => void) => {
    const key = topic.type === 'session' ? `session:${topic.sessionId}` : 'activity';

    if (!subscribersRef.current.has(key)) {
      subscribersRef.current.set(key, new Set());
    }
    subscribersRef.current.get(key)!.add(callback);

    return () => {
      const callbacks = subscribersRef.current.get(key);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          subscribersRef.current.delete(key);
        }
      }
    };
  }, []);

  const reconnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    connect();
  }, [connect]);

  const value = useMemo<ActivityStreamContextValue>(() => ({
    connectionState,
    subscribe,
    reconnect,
    isConnected: connectionState.status === 'connected',
    isReconnecting: connectionState.status === 'reconnecting',
    errorMessage: connectionState.error?.message ?? null,
  }), [connectionState, subscribe, reconnect]);

  return (
    <ActivityStreamContext.Provider value={value}>
      {children}
    </ActivityStreamContext.Provider>
  );
}

// =============================================================================
// Hooks
// =============================================================================

export function useActivityStream(): ActivityStreamContextValue {
  const context = useContext(ActivityStreamContext);
  if (context === undefined) {
    throw new Error('useActivityStream must be used within an ActivityStreamProvider');
  }
  return context;
}

/**
 * Hook to subscribe to a specific topic.
 * Automatically handles subscription lifecycle with useEffect.
 */
export function useActivityStreamSubscription(
  topic: StreamTopic | null,
  callback: SubscriberCallback
): void {
  const { subscribe } = useActivityStream();
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const sessionId = topic?.type === 'session' ? topic.sessionId : null;
  const topicType = topic?.type ?? null;

  useEffect(() => {
    if (!topicType) return;

    const stableTopic: StreamTopic = topicType === 'session'
      ? { type: 'session', sessionId: sessionId ?? '' }
      : { type: 'activity' };

    const unsubscribe = subscribe(stableTopic, (data) => {
      callbackRef.current(data);
    });

    return unsubscribe;
  }, [topicType, sessionId, subscribe]);
}
