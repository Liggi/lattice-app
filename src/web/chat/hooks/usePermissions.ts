/**
 * usePermissions — polls for pending permission and question requests,
 * provides action methods for answering them.
 *
 * Standalone hook providing permission and question polling for Claude sessions.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '../services/api';
import { useActivityStream, useActivityStreamSubscription } from '../contexts/ActivityStreamContext';
import type { PermissionRequest } from '@/types';

/** Fast interval when a permission request is actively pending. */
const POLL_INTERVAL_ACTIVE_MS = 2500;
/** Slow interval when nothing is pending — avoids unnecessary CPU/network wake. */
const POLL_INTERVAL_IDLE_MS = 10_000;
/**
 * Idle interval while the activity stream is connected: permission-request
 * events arrive as push, so the poll is only a missed-event safety net.
 */
const POLL_INTERVAL_STREAMING_IDLE_MS = 60_000;

export interface UsePermissionsReturn {
  permissionRequest: PermissionRequest | null;
  answerPermission: (requestId: string, action: 'approve' | 'deny', denyReason?: string) => Promise<void>;
  answerPermissionWithPattern: (requestId: string, pattern: string, scope: 'session' | 'global') => Promise<void>;
  answerPermissionWithPatterns: (requestId: string, patterns: string[], scope: 'session' | 'global') => Promise<void>;
  setPermissionRequest: (request: PermissionRequest | null) => void;
}

export function usePermissions(conversationId: string | undefined): UsePermissionsReturn {
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const { isConnected } = useActivityStream();
  const isPollingRef = useRef(false);

  // Track whether anything is pending to choose the poll interval.
  const hasPendingRef = useRef(false);
  // Lets the push subscription below trigger an immediate check without
  // being part of the polling effect's lifecycle.
  const pollRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!conversationId) return;

    let intervalId: ReturnType<typeof setTimeout> | null = null;
    const idleInterval = isConnected ? POLL_INTERVAL_STREAMING_IDLE_MS : POLL_INTERVAL_IDLE_MS;

    const poll = async () => {
      if (isPollingRef.current) return;
      isPollingRef.current = true;
      try {
        const { permissions } = await api.getPermissions({
          sessionId: conversationId,
          status: 'pending',
        });
        const mostRecent = permissions.length > 0 ? permissions[permissions.length - 1] : null;
        setPermissionRequest(mostRecent);

        // Switch to fast polling when a request is pending, slow when idle.
        const wasPending = hasPendingRef.current;
        hasPendingRef.current = mostRecent !== null;
        if (wasPending !== hasPendingRef.current) {
          // Interval changed — reschedule.
          if (intervalId !== null) clearInterval(intervalId);
          const nextInterval = hasPendingRef.current ? POLL_INTERVAL_ACTIVE_MS : idleInterval;
          intervalId = setInterval(() => void poll(), nextInterval);
        }
      } catch {
        // Silently continue polling on failure
      } finally {
        isPollingRef.current = false;
      }
    };

    pollRef.current = poll;
    void poll();
    intervalId = setInterval(() => void poll(), idleInterval);
    return () => {
      if (intervalId !== null) clearInterval(intervalId);
      if (pollRef.current === poll) pollRef.current = null;
    };
  }, [conversationId, isConnected]);

  // Server pushes permission lifecycle onto the activity stream; an event for
  // this conversation (or with no session attribution) checks immediately.
  useActivityStreamSubscription({ type: 'activity' }, (event) => {
    if (!conversationId) return;
    const payload = event as { type?: string; sessionId?: string | null };
    if (payload.type !== 'permission-request' && payload.type !== 'permission-updated') return;
    if (payload.sessionId && payload.sessionId !== conversationId) return;
    void pollRef.current?.();
  });

  const answerPermission = useCallback(async (
    requestId: string,
    action: 'approve' | 'deny',
    denyReason?: string,
  ) => {
    await api.sendPermissionDecision(requestId, { action, denyReason });
    setPermissionRequest(null);
  }, []);

  const answerPermissionWithPattern = useCallback(async (
    requestId: string,
    pattern: string,
    scope: 'session' | 'global',
  ) => {
    await api.addToAllowlist(scope, pattern, permissionRequest?.streamingId);
    await api.sendPermissionDecision(requestId, { action: 'approve' });
    setPermissionRequest(null);
  }, [permissionRequest?.streamingId]);

  const answerPermissionWithPatterns = useCallback(async (
    requestId: string,
    patterns: string[],
    scope: 'session' | 'global',
  ) => {
    for (const pattern of patterns) {
      await api.addToAllowlist(scope, pattern, permissionRequest?.streamingId);
    }
    await api.sendPermissionDecision(requestId, { action: 'approve' });
    setPermissionRequest(null);
  }, [permissionRequest?.streamingId]);

  return {
    permissionRequest,
    setPermissionRequest,
    answerPermission,
    answerPermissionWithPattern,
    answerPermissionWithPatterns,
  };
}
