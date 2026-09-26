import crypto from 'node:crypto';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import type { EventType, SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { createLogger } from '../services/infrastructure/logger.js';

const logger = createLogger('HarnessCustomEvents');

export function appendCustomHarnessEvent(
  sessionManager: SessionManager,
  sessionId: string,
  type: string,
  data: unknown,
): SessionEvent | null {
  const log = sessionManager.getLog(sessionId) ?? sessionManager.recoverFromStorage(sessionId);
  if (!log) {
    logger.warn('Cannot append custom harness event without an event log', { sessionId, type });
    return null;
  }

  const latest = log.latest();
  const runId = sessionManager.inspect(sessionId)?.runId
    ?? latest?.runId
    ?? crypto.randomUUID();

  return log.append(
    type as EventType,
    data,
    runId,
    sessionId,
    { rawType: type, source: 'provider' },
  );
}
