import { shouldAllowClientTelemetryEvent, type TelemetryRateBucket } from './client-telemetry';

export type BrowserIncidentSeverity = 'warn' | 'error';

export interface BrowserIncidentInput {
  type: string;
  severity: BrowserIncidentSeverity;
  message?: string;
  route?: string;
  traceId?: string;
  conversationId?: string;
  sessionId?: string;
  streamingId?: string;
  details?: Record<string, unknown>;
}

const INCIDENT_ENDPOINT = '/api/logs/incidents';
const KEEPALIVE_BODY_SOFT_LIMIT = 60_000;
const INCIDENT_LIMIT_PER_MINUTE = 4;
const INCIDENT_WINDOW_MS = 60_000;

const incidentRateBuckets = new Map<string, TelemetryRateBucket>();

let installed = false;

interface IncidentContext {
  conversationId?: string;
  sessionId?: string;
  streamingId?: string;
}

let currentContext: IncidentContext = {};

/**
 * Update the ambient session context for global error handlers.
 * Call this when the active conversation changes so that
 * window.onerror / unhandledrejection incidents carry correlation IDs.
 */
export function setBrowserIncidentContext(ctx: IncidentContext): void {
  currentContext = { ...ctx };
}

export function clearBrowserIncidentContext(): void {
  currentContext = {};
}

function currentRoute(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search}`;
}

function shouldAllowIncident(key: string, nowMs: number): boolean {
  return shouldAllowClientTelemetryEvent(
    incidentRateBuckets,
    key,
    nowMs,
    INCIDENT_LIMIT_PER_MINUTE,
    INCIDENT_WINDOW_MS
  );
}

export function sendBrowserIncident(input: BrowserIncidentInput): void {
  if (typeof window === 'undefined') return;

  const nowMs = Date.now();
  const key = `${input.type}:${input.severity}:${input.route || currentRoute()}:${input.message || ''}`;
  if (!shouldAllowIncident(key, nowMs)) {
    return;
  }

  const payload = JSON.stringify({
    incidents: [{
      conversationId: input.conversationId ?? currentContext.conversationId,
      sessionId: input.sessionId ?? currentContext.sessionId,
      streamingId: input.streamingId ?? currentContext.streamingId,
      ...input,
      route: input.route || currentRoute(),
    }],
  });

  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      typeof Blob !== 'undefined' &&
      payload.length <= KEEPALIVE_BODY_SOFT_LIMIT
    ) {
      const enqueued = navigator.sendBeacon(
        INCIDENT_ENDPOINT,
        new Blob([payload], { type: 'application/json' })
      );
      if (enqueued) return;
    }
  } catch {
    // Fall through to fetch.
  }

  fetch(INCIDENT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // Incident reporting must not break the app.
  });
}

// --- Browser console capture ---
// Intercepts console.warn and console.error and forwards to the server
// in batches via sendBeacon for unified timeline correlation.

const CONSOLE_ENDPOINT = '/api/logs/console';
const CONSOLE_BATCH_INTERVAL_MS = 2_000;
const CONSOLE_MAX_BUFFER = 50;

let consoleBatch: Array<{
  level: 'warn' | 'error';
  message: string;
  timestamp: string;
  route?: string;
  conversationId?: string;
  sessionId?: string;
}> = [];

/**
 * Armed only while entries are waiting. A standing interval here woke the tab every
 * 2s for the life of the page even with nothing to send, which is exactly what
 * background throttling is meant to avoid.
 */
let consoleFlushTimer: ReturnType<typeof setTimeout> | null = null;

function clearConsoleFlushTimer(): void {
  if (consoleFlushTimer !== null) {
    clearTimeout(consoleFlushTimer);
    consoleFlushTimer = null;
  }
}

function scheduleConsoleFlush(): void {
  if (consoleFlushTimer !== null) return;
  consoleFlushTimer = setTimeout(() => {
    consoleFlushTimer = null;
    flushConsoleBatch();
  }, CONSOLE_BATCH_INTERVAL_MS);
}

function flushConsoleBatch(): void {
  clearConsoleFlushTimer();
  if (consoleBatch.length === 0) return;
  const entries = consoleBatch;
  consoleBatch = [];

  const payload = JSON.stringify({ entries });
  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      typeof Blob !== 'undefined' &&
      payload.length <= KEEPALIVE_BODY_SOFT_LIMIT
    ) {
      const enqueued = navigator.sendBeacon(
        CONSOLE_ENDPOINT,
        new Blob([payload], { type: 'application/json' })
      );
      if (enqueued) return;
    }
  } catch {
    // Fall through to fetch.
  }

  fetch(CONSOLE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // Console capture must not break the app.
  });
}

function captureConsoleCall(level: 'warn' | 'error', args: unknown[]): void {
  const message = args
    .map(a => (typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a))))
    .join(' ')
    .slice(0, 500);

  consoleBatch.push({
    level,
    message,
    timestamp: new Date().toISOString(),
    route: currentRoute(),
    conversationId: currentContext.conversationId,
    sessionId: currentContext.sessionId,
  });

  if (consoleBatch.length >= CONSOLE_MAX_BUFFER) {
    flushConsoleBatch();
  } else {
    scheduleConsoleFlush();
  }
}

let consoleCapInstalled = false;

export function installBrowserConsoleCapture(): void {
  if (consoleCapInstalled || typeof window === 'undefined') return;
  consoleCapInstalled = true;

  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    captureConsoleCall('warn', args);
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    captureConsoleCall('error', args);
  };

  // No standing interval: captureConsoleCall arms a one-shot timer when it enqueues.

  // Flush on page unload
  window.addEventListener('beforeunload', flushConsoleBatch);
}

export function installBrowserIncidentCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    sendBrowserIncident({
      type: 'window-error',
      severity: 'error',
      message: event.message || 'Unhandled window error',
      ...currentContext,
      details: {
        filename: event.filename || null,
        lineno: event.lineno || null,
        colno: event.colno || null,
      },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const message = event.reason instanceof Error
      ? event.reason.message
      : String(event.reason ?? 'Unhandled promise rejection');

    sendBrowserIncident({
      type: 'unhandled-rejection',
      severity: 'error',
      message,
      ...currentContext,
    });
  });
}
