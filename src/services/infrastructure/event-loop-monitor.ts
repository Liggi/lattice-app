/**
 * Event Loop Lag Monitor
 *
 * Detects when the Node.js event loop is blocked for longer than a threshold.
 * Uses a simple setInterval approach: if the callback fires significantly later
 * than expected, the event loop was blocked during that interval.
 *
 * This is lightweight (~0.01% CPU) and catches the exact symptom we care about:
 * the event loop being unavailable to process SSE events and API requests.
 */

import { createLogger } from './logger.js';

const logger = createLogger('EventLoopMonitor');

const CHECK_INTERVAL_MS = 200;
const WARN_THRESHOLD_MS = 500;
const ERROR_THRESHOLD_MS = 2000;

let interval: NodeJS.Timeout | null = null;
let lastCheck = 0;
let lagCount = 0;
let maxLagMs = 0;

export function startEventLoopMonitor(): void {
  if (interval) return;

  lastCheck = Date.now();
  lagCount = 0;
  maxLagMs = 0;

  interval = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastCheck;
    const lag = elapsed - CHECK_INTERVAL_MS;
    lastCheck = now;

    if (lag > ERROR_THRESHOLD_MS) {
      lagCount++;
      if (lag > maxLagMs) maxLagMs = lag;
      logger.error(`Event loop blocked for ${lag}ms (check interval ${CHECK_INTERVAL_MS}ms, elapsed ${elapsed}ms)`, {
        lagMs: lag,
        elapsedMs: elapsed,
        lagCount,
        maxLagMs,
      });
    } else if (lag > WARN_THRESHOLD_MS) {
      lagCount++;
      if (lag > maxLagMs) maxLagMs = lag;
      logger.warn(`Event loop lag: ${lag}ms (check interval ${CHECK_INTERVAL_MS}ms, elapsed ${elapsed}ms)`, {
        lagMs: lag,
        elapsedMs: elapsed,
        lagCount,
        maxLagMs,
      });
    }
  }, CHECK_INTERVAL_MS);

  // Don't let the monitor prevent process exit
  interval.unref();

  logger.info('Event loop monitor started', {
    checkIntervalMs: CHECK_INTERVAL_MS,
    warnThresholdMs: WARN_THRESHOLD_MS,
    errorThresholdMs: ERROR_THRESHOLD_MS,
  });
}

export function stopEventLoopMonitor(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    logger.info('Event loop monitor stopped', { lagCount, maxLagMs });
  }
}
