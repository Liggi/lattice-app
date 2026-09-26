// ============================================================
// Connection Configuration - Single Source of Truth
// ============================================================
// All connection-related constants for the frontend.

/**
 * SSE/WebSocket connection establishment timeout.
 * If connection isn't established within this time, abort and retry.
 */
export const CONNECTION_TIMEOUT_MS = 10000;

/**
 * API fetch timeout for HTTP requests.
 * Longer than connection timeout because some operations are slow.
 */
export const API_TIMEOUT_MS = 30000;
