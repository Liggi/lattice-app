import type { QueryClient } from '@tanstack/react-query';
import { conversationKeys } from '@/web/chat/contexts/ConversationsContext';
import { api } from '@/web/chat/services/api';

const SESSION_LOAD_WATCHDOG_ACTIVE_MS = 7_000;
const SESSION_LOAD_WATCHDOG_SLOW_MS = 15_000;

export type SessionLoadWatchdogReason = 'empty-active' | 'slow-hydration';

export function logSessionLoadWatchdogTriggered(_params: {
  sessionId: string;
  reason: SessionLoadWatchdogReason;
  attempt: number;
  elapsedMs: number | null;
}): void {
}

export function reconnectClaudeStreamIfNeeded(params: {
  streamingId: string | null;
  isConnected: boolean;
  reconnectToStream: (streamingId: string) => void;
}): void {
  if (params.streamingId && !params.isConnected) {
    params.reconnectToStream(params.streamingId);
  }
}

export async function reconnectFromConversationStatus(params: {
  sessionId: string;
  reconnectToStream: (streamingId: string) => void;
}): Promise<void> {
  try {
    const status = await api.getConversationStatus(params.sessionId);
    if (status.status === 'ongoing' && status.streamingId) {
      params.reconnectToStream(status.streamingId);
    }
  } catch (_statusError) {
    // Status endpoint may be transiently unavailable during watchdog recovery.
  }
}

export async function refetchSessionWatchdogQueries(params: {
  queryClient: QueryClient;
  sessionId: string;
}): Promise<void> {
  // eslint-disable-next-line no-console
  console.debug(`[DETAIL-TRACE] watchdog-recovery refetching details for ${params.sessionId?.slice(0, 12)}`);
  await params.queryClient.cancelQueries({ queryKey: conversationKeys.details(params.sessionId), exact: true });
  await Promise.all([
    params.queryClient.refetchQueries({ queryKey: conversationKeys.details(params.sessionId), exact: true }),
    params.queryClient.refetchQueries({ queryKey: ['insights', params.sessionId], exact: true }),
  ]);
}

export function evaluateSessionLoadWatchdogRecovery(params: {
  hasActiveSignal: boolean;
  noVisibleContent: boolean;
  slowHydration: boolean;
}): { shouldRecover: false } | { shouldRecover: true; reason: SessionLoadWatchdogReason; delayMs: number } {
  const shouldRecover = (params.hasActiveSignal && params.noVisibleContent) || params.slowHydration;
  if (!shouldRecover) {
    return { shouldRecover: false };
  }

  const reason: SessionLoadWatchdogReason = params.hasActiveSignal && params.noVisibleContent
    ? 'empty-active'
    : 'slow-hydration';
  const delayMs = reason === 'empty-active'
    ? SESSION_LOAD_WATCHDOG_ACTIVE_MS
    : SESSION_LOAD_WATCHDOG_SLOW_MS;
  return { shouldRecover: true, reason, delayMs };
}
