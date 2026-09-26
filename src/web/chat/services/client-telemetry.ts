export type ClientTelemetrySeverity = 'info' | 'warn' | 'error';

export interface ClientTelemetryEvent {
  component: string;
  event: string;
  severity?: ClientTelemetrySeverity;
  traceId?: string;
  details?: Record<string, unknown>;
}

export interface TelemetryRateBucket {
  windowStartMs: number;
  count: number;
}

const TELEMETRY_ENDPOINT = '/api/system/telemetry/client';
const TELEMETRY_KEEPALIVE_BODY_SOFT_LIMIT = 60_000;
const TELEMETRY_LIMIT_PER_MINUTE = 8;
const TELEMETRY_WINDOW_MS = 60_000;

const telemetryRateBuckets = new Map<string, TelemetryRateBucket>();

export function shouldAllowClientTelemetryEvent(
  buckets: Map<string, TelemetryRateBucket>,
  key: string,
  nowMs: number,
  limit = TELEMETRY_LIMIT_PER_MINUTE,
  windowMs = TELEMETRY_WINDOW_MS
): boolean {
  const existing = buckets.get(key);

  if (!existing || nowMs - existing.windowStartMs >= windowMs) {
    buckets.set(key, {
      windowStartMs: nowMs,
      count: 1,
    });
    return true;
  }

  if (existing.count >= limit) {
    return false;
  }

  existing.count += 1;
  return true;
}

export function sendClientTelemetry(event: ClientTelemetryEvent): void {
  if (typeof window === 'undefined') return;

  const component = event.component.trim();
  const eventName = event.event.trim();
  const severity = event.severity || 'info';

  if (!component || !eventName) return;

  const nowMs = Date.now();
  const key = `${component}:${eventName}:${severity}`;
  if (!shouldAllowClientTelemetryEvent(telemetryRateBuckets, key, nowMs)) {
    return;
  }

  const payload = JSON.stringify({
    component,
    event: eventName,
    severity,
    traceId: event.traceId,
    details: {
      ...(event.details || {}),
      clientTimestamp: new Date(nowMs).toISOString(),
    },
  });

  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      typeof Blob !== 'undefined' &&
      payload.length <= TELEMETRY_KEEPALIVE_BODY_SOFT_LIMIT
    ) {
      const enqueued = navigator.sendBeacon(
        TELEMETRY_ENDPOINT,
        new Blob([payload], { type: 'application/json' })
      );
      if (enqueued) return;
    }
  } catch {
    // Fall through to fetch.
  }

  fetch(TELEMETRY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // Telemetry should never disrupt the user experience.
  });
}
