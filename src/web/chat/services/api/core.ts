import type { ApiError } from '../../types';
import { API_TIMEOUT_MS } from '../../config/connection';
import { sendClientTelemetry } from '../client-telemetry';
import { sendBrowserIncident } from '../browser-incidents';
import { getNetworkHealthMonitor, isSuspectedTabSuspension } from '../network-health';
import type { UnifiedConversationResolutionResponse } from './types';

// Most browsers cap keepalive payloads around 64KB; stay below that to avoid silent drops.
const KEEPALIVE_BODY_SOFT_LIMIT = 60_000;
const API_SLOW_REQUEST_MS = 2_000;
const TIMEOUT_ERROR_PREFIX = 'Request timeout after ';
const CONVERSATION_DETAILS_FALLBACK_LIMIT = 25;

function normalizeApiPathForTelemetry(url: string): string {
  const [path] = url.split('?');
  return path
    .replace(/\/conv-[A-Za-z0-9_-]+/g, '/conv-:id')
    .replace(/\/codex-[A-Za-z0-9_-]+/g, '/codex-:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:uuid');
}

export function generateTraceId(): string {
  return `nav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function isApiTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(TIMEOUT_ERROR_PREFIX);
}

export class ApiRequestError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function resolveConversationDetailsFallbackLimit(requestedLimit?: number): number | null {
  if (requestedLimit === undefined) return CONVERSATION_DETAILS_FALLBACK_LIMIT;
  if (requestedLimit > CONVERSATION_DETAILS_FALLBACK_LIMIT) return CONVERSATION_DETAILS_FALLBACK_LIMIT;
  return null;
}

export class ApiCore {
  protected baseUrl = '';
  private canonicalConversationIdCache = new Map<string, string>();
  private canonicalConversationIdInFlight = new Map<string, Promise<string>>();
  private cachedGetResponses = new Map<string, { expiresAt: number; value: unknown }>();
  private cachedGetInFlight = new Map<string, Promise<unknown>>();
  private cachedGetGeneration = new Map<string, number>();

  protected assertUnifiedConversationId(sessionId: string): void {
    if (!sessionId.startsWith('conv-')) {
      throw new Error(`Expected unified conversation ID (conv-*), got "${sessionId}"`);
    }
  }

  protected async resolveCanonicalConversationId(sessionId: string): Promise<string> {
    if (sessionId.startsWith('conv-')) {
      return sessionId;
    }

    const cached = this.canonicalConversationIdCache.get(sessionId);
    if (cached) {
      return cached;
    }

    const pending = this.canonicalConversationIdInFlight.get(sessionId);
    if (pending) {
      return pending;
    }

    const resolvePromise = this.resolveUnifiedConversationId(sessionId)
      .then((resolved) => {
        this.canonicalConversationIdCache.set(sessionId, resolved.conversationId);
        return resolved.conversationId;
      })
      .finally(() => {
        this.canonicalConversationIdInFlight.delete(sessionId);
      });

    this.canonicalConversationIdInFlight.set(sessionId, resolvePromise);
    return resolvePromise;
  }

  private shouldEnableKeepalive(options: RequestInit): boolean {
    if (!options.keepalive) return false;

    const body = options.body;
    if (!body) return true;

    if (typeof body === 'string') {
      return body.length <= KEEPALIVE_BODY_SOFT_LIMIT;
    }

    if (body instanceof URLSearchParams) {
      return body.toString().length <= KEEPALIVE_BODY_SOFT_LIMIT;
    }

    // Non-string bodies have ambiguous size and can be rejected by keepalive.
    return false;
  }

  protected async apiCall<T>(
    url: string,
    options?: RequestInit & { timeout?: number }
  ): Promise<T> {
    const fullUrl = `${this.baseUrl}${url}`;
    const timeout = options?.timeout ?? API_TIMEOUT_MS;
    const method = (options?.method || 'GET').toUpperCase();
    const normalizedPath = normalizeApiPathForTelemetry(url);
    const requestStartedAt = performance.now();
    const networkHealth = getNetworkHealthMonitor();
    const requestId = networkHealth.beginApiRequest({
      method,
      path: normalizedPath,
      timeoutMs: timeout,
    });

    const headers = new Headers(options?.headers as HeadersInit);
    headers.set('Content-Type', 'application/json');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const requestOptions: RequestInit = { ...(options || {}) };
      delete (requestOptions as { timeout?: number }).timeout;
      const keepalive = this.shouldEnableKeepalive(requestOptions);

      const response = await fetch(fullUrl, {
        ...requestOptions,
        headers,
        signal: controller.signal,
        keepalive,
      });

      clearTimeout(timeoutId);

      const data = await response.json() as T;

      if (!response.ok) {
        const apiError = data as ApiError;
        const message = apiError.error || `HTTP ${response.status}`;
        const durationMs = Math.round(performance.now() - requestStartedAt);
        networkHealth.finishApiRequest(requestId, {
          status: 'http_error',
          method,
          path: normalizedPath,
          timeoutMs: timeout,
          durationMs,
          error: message,
        });
        sendClientTelemetry({
          component: 'ApiService',
          event: 'api-request-error',
          severity: 'warn',
          details: {
            method,
            path: normalizedPath,
            status: response.status,
            timeoutMs: timeout,
            durationMs,
            message,
          },
        });
        throw new ApiRequestError(message, response.status, apiError.code, apiError);
      }

      const durationMs = Math.round(performance.now() - requestStartedAt);
      networkHealth.finishApiRequest(requestId, {
        status: durationMs >= API_SLOW_REQUEST_MS ? 'slow' : 'success',
        method,
        path: normalizedPath,
        timeoutMs: timeout,
        durationMs,
      });
      if (durationMs >= API_SLOW_REQUEST_MS) {
        sendClientTelemetry({
          component: 'ApiService',
          event: 'api-request-slow',
          severity: 'warn',
          details: {
            method,
            path: normalizedPath,
            durationMs,
            timeoutMs: timeout,
          },
        });
      }

      return data;
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new Error(`Request timeout after ${timeout}ms: ${url}`);
        const durationMs = Math.round(performance.now() - requestStartedAt);
        // A wake burst after tab suspension looks identical to an outage in
        // the log unless the client says which one it saw — it is the only
        // party that knows the timer overshot its own budget.
        const suspectedTabSuspension = isSuspectedTabSuspension(durationMs, timeout);
        networkHealth.finishApiRequest(requestId, {
          status: 'timeout',
          method,
          path: normalizedPath,
          timeoutMs: timeout,
          durationMs,
          error: timeoutError.message,
        });
        sendClientTelemetry({
          component: 'ApiService',
          event: 'api-request-timeout',
          severity: suspectedTabSuspension ? 'warn' : 'error',
          details: {
            method,
            path: normalizedPath,
            timeoutMs: timeout,
            durationMs,
            suspectedTabSuspension,
          },
        });
        sendBrowserIncident({
          type: 'api-request-timeout',
          severity: suspectedTabSuspension ? 'warn' : 'error',
          message: timeoutError.message,
          details: {
            method,
            path: normalizedPath,
            timeoutMs: timeout,
            durationMs,
            suspectedTabSuspension,
          },
        });
        throw timeoutError;
      }

      const durationMs = Math.round(performance.now() - requestStartedAt);
      networkHealth.finishApiRequest(requestId, {
        status: 'failed',
        method,
        path: normalizedPath,
        timeoutMs: timeout,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      });
      sendClientTelemetry({
        component: 'ApiService',
        event: 'api-request-failed',
        severity: 'error',
        details: {
          method,
          path: normalizedPath,
          timeoutMs: timeout,
          durationMs,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      sendBrowserIncident({
        type: 'api-request-failed',
        severity: 'warn',
        message: error instanceof Error ? error.message : String(error),
        details: {
          method,
          path: normalizedPath,
          timeoutMs: timeout,
          durationMs,
        },
      });
      throw error;
    }
  }

  async fetchDirect(url: string, options?: RequestInit): Promise<Response> {
    return fetch(url, options);
  }

  protected async cachedGet<T>(
    cacheKey: string,
    ttlMs: number,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    const cached = this.cachedGetResponses.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }

    const pending = this.cachedGetInFlight.get(cacheKey);
    if (pending) {
      return pending as Promise<T>;
    }

    const generation = this.cachedGetGeneration.get(cacheKey) ?? 0;

    const request = fetcher()
      .then((value) => {
        if ((this.cachedGetGeneration.get(cacheKey) ?? 0) === generation) {
          this.cachedGetResponses.set(cacheKey, {
            value,
            expiresAt: Date.now() + ttlMs,
          });
        }
        return value;
      })
      .finally(() => {
        this.cachedGetInFlight.delete(cacheKey);
      });

    this.cachedGetInFlight.set(cacheKey, request as Promise<unknown>);
    return request;
  }

  protected invalidateCachedGet(cacheKeyPrefix: string): void {
    for (const key of this.cachedGetResponses.keys()) {
      if (key.startsWith(cacheKeyPrefix)) {
        this.cachedGetResponses.delete(key);
        this.cachedGetGeneration.set(key, (this.cachedGetGeneration.get(key) ?? 0) + 1);
      }
    }

    for (const key of this.cachedGetInFlight.keys()) {
      if (key.startsWith(cacheKeyPrefix)) {
        this.cachedGetInFlight.delete(key);
        this.cachedGetGeneration.set(key, (this.cachedGetGeneration.get(key) ?? 0) + 1);
      }
    }
  }

  async resolveUnifiedConversationId(sessionId: string): Promise<UnifiedConversationResolutionResponse> {
    return this.apiCall(`/api/conv/resolve/${encodeURIComponent(sessionId)}`);
  }
}
