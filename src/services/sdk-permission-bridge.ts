/**
 * SDK Permission Bridge
 *
 * When the daemon spawns Claude Code with `--permission-prompt-tool stdio`
 * (see `process-daemon.ts#applyPermissionMode`), the CLI routes
 * `behavior: 'ask'` permission decisions through stdout as
 * `{type: 'control_request', request: {subtype: 'can_use_tool', ...}}`
 * SDK control messages.
 *
 * The daemon parses those messages and forwards them as
 * `claude-control-request` IPC events. This bridge listens for those
 * events, runs them through the same allowlist + UI banner flow as the
 * existing `/api/permissions/hooks/permission-request` endpoint, and
 * sends the decision back to the daemon via the
 * `respondToControlRequest` RPC.
 *
 * This is the path that fixes sensitive-file edits (`~/.claude/**`,
 * `.git/**`, shell configs) in `bypassPermissions` mode. CC's safety
 * check at `permissions.ts:1144` is bypass-immune; before this bridge,
 * the resulting 'ask' decision was silently auto-denied at
 * `toolExecution.ts:995`.
 */

import { ProcessManagerClient } from '@/process-daemon/process-manager-client.js';
import { ClaudeControlRequestEventData } from '@/process-daemon/types.js';
import { PermissionTracker } from '@/services/permission-tracker.js';
import { isToolAllowed } from '@/routes/session/permission.routes.js';
import { getPermissionEventLog } from '@/services/permission-event-log.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { addRoutedPermissionRequest } from '@/services/sessions/worker-permission-delivery.js';

interface PermissionUpdateEvent {
  id: string;
  status: 'pending' | 'approved' | 'denied';
  modifiedInput?: Record<string, unknown>;
  denyReason?: string;
}

/**
 * Wait for a tracker decision on a specific permission request.
 *
 * Mirrors the `waitForDecision` helper in `permission.routes.ts`. Kept
 * local rather than exported because the bridge has slightly different
 * defaults (no upstream HTTP timeout, longer wait — the CLI's
 * `runPermissionRequestHooksForSDK` will time out on its own side first
 * if the user doesn't decide).
 */
function waitForDecision(
  tracker: PermissionTracker,
  requestId: string,
  timeoutMs: number,
): Promise<{ status: 'approved' | 'denied' | 'timeout'; modifiedInput?: Record<string, unknown>; denyReason?: string }> {
  // Fast path: the request may already be resolved by the time we attach.
  const existing = tracker.getPermissionRequest(requestId);
  if (existing?.status === 'approved') {
    return Promise.resolve({ status: 'approved', modifiedInput: existing.modifiedInput });
  }
  if (existing?.status === 'denied') {
    return Promise.resolve({ status: 'denied', denyReason: existing.denyReason });
  }

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      tracker.removeListener('permission_updated', onUpdated);
      resolve({ status: 'timeout' });
    }, timeoutMs);

    const onUpdated = (updated: PermissionUpdateEvent) => {
      if (resolved || updated.id !== requestId || updated.status === 'pending') {
        return;
      }
      resolved = true;
      clearTimeout(timer);
      tracker.removeListener('permission_updated', onUpdated);
      resolve({
        status: updated.status,
        modifiedInput: updated.modifiedInput,
        denyReason: updated.denyReason,
      });
    };

    tracker.on('permission_updated', onUpdated);
  });
}

/**
 * Set up the SDK control-request bridge. Must be called once after the
 * `ProcessManagerClient` is connected and the `PermissionTracker` is
 * constructed. Returns a teardown function for tests.
 */
export function setupSdkPermissionBridge(
  client: ProcessManagerClient,
  tracker: PermissionTracker,
): () => void {
  const logger = createLogger('SdkPermissionBridge');

  // Match the CLI's PreToolUse hook timeout (600s) plus a small buffer.
  // If we don't respond by then the CLI auto-denies on its side anyway,
  // but resolving locally first lets the tracker emit a clean 'denied'
  // event the UI can render.
  const DECISION_TIMEOUT_MS = 605_000;

  const handler = (event: ClaudeControlRequestEventData): void => {
    void handleEvent(event).catch((err: unknown) => {
      logger.error('Bridge handler crashed', err instanceof Error ? err : new Error(String(err)), {
        streamingId: event.streamingId,
        requestId: event.requestId.slice(0, 8),
      });
      // Best-effort: tell the CLI we couldn't decide so it doesn't hang.
      client
        .respondToControlRequest(event.streamingId, event.requestId, {
          behavior: 'deny',
          message: 'Lattice permission bridge encountered an internal error.',
        })
        .catch((rpcErr: unknown) => {
          logger.error('Failed to send error fallback control_response', rpcErr instanceof Error ? rpcErr : new Error(String(rpcErr)));
        });
    });
  };

  const handleEvent = async (event: ClaudeControlRequestEventData): Promise<void> => {
    const permissionLog = getPermissionEventLog();
    logger.info('Received claude-control-request', {
      streamingId: event.streamingId,
      requestId: event.requestId.slice(0, 8),
      toolName: event.toolName,
      decisionReasonType: event.decisionReasonType,
    });

    // Fast path: tool already allowed by user/session pattern. Auto-approve
    // without surfacing a banner. Mirrors `/api/permissions/notify` (see
    // `permission.routes.ts:208–237`).
    const match = isToolAllowed(event.toolName, event.toolInput, event.streamingId);
    if (match) {
      permissionLog.autoApproved({
        toolName: event.toolName,
        toolInput: event.toolInput,
        streamingId: event.streamingId,
        matchedPattern: match.pattern,
        patternSource: match.source,
      });
      await client.respondToControlRequest(event.streamingId, event.requestId, {
        behavior: 'allow',
        // Empty updatedInput tells the CLI to use the original input.
        updatedInput: {},
      });
      return;
    }

    // Slow path: surface as a permission request. The PermissionBanner
    // renders this via the existing SSE stream + reconciliation polling
    // (see permission-delivery.md memory). A worker's request goes to its
    // coordinator instead, which decides or escalates it to the user.
    const request = addRoutedPermissionRequest(
      tracker,
      event.toolName,
      event.toolInput,
      event.streamingId,
      { reason: typeof event.decisionReason === 'string' ? event.decisionReason : undefined },
    );
    permissionLog.request({
      toolName: event.toolName,
      toolInput: event.toolInput,
      streamingId: event.streamingId,
      sessionId: request.sessionId,
      permissionRequestId: request.id,
    });

    const decision = await waitForDecision(tracker, request.id, DECISION_TIMEOUT_MS);

    if (decision.status === 'approved') {
      const updatedInput = decision.modifiedInput ?? {};
      await client.respondToControlRequest(event.streamingId, event.requestId, {
        behavior: 'allow',
        updatedInput,
      });
      return;
    }

    const denyMessage =
      decision.status === 'timeout'
        ? 'Permission request timed out waiting for user decision.'
        : decision.denyReason || 'Permission denied by user.';
    await client.respondToControlRequest(event.streamingId, event.requestId, {
      behavior: 'deny',
      message: denyMessage,
    });
  };

  client.on('claude-control-request', handler);
  logger.info('SDK permission bridge installed');

  return () => {
    client.removeListener('claude-control-request', handler);
  };
}
