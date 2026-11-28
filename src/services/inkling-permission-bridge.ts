/**
 * Decides Inkling's approval requests the way Lattice decides Claude's.
 *
 * Inkling asks about every shell command and file change; this bridge
 * answers from the conversation's permission mode as it is now (so switching
 * mode applies to the next tool call), then the session and global
 * allowlists, and otherwise raises an approval card through the same tracker
 * the Claude bridges use. A worker's card goes to its coordinator first.
 */

import type { InklingApproval, InklingApprovalRequest, InklingPermissionBridge } from '@/harness/inkling-process-adapter.js';
import type { PermissionTracker } from '@/services/permission-tracker.js';
import { isToolAllowed } from '@/routes/session/permission.routes.js';
import { getPermissionEventLog } from '@/services/permission-event-log.js';
import { addRoutedPermissionRequest } from '@/services/sessions/worker-permission-delivery.js';
import { waitForDecision } from '@/services/sdk-permission-bridge.js';
import { createLogger } from '@/services/infrastructure/logger.js';

const logger = createLogger('InklingPermissionBridge');

/** As long as Claude's hook waits; a card nobody answers is then denied. */
const DECISION_TIMEOUT_MS = 605_000;

const FILE_TOOLS = new Set(['Write', 'Edit']);

/** What a Lattice permission mode decides by itself, before any allowlist or card. */
export function decisionForMode(mode: string | undefined, toolName: string): 'allow' | 'ask' {
  if (mode === 'bypassPermissions' || mode === 'auto') return 'allow';
  if (mode === 'acceptEdits' && FILE_TOOLS.has(toolName)) return 'allow';
  return 'ask';
}

export function createInklingPermissionBridge(
  tracker: PermissionTracker,
  permissionModeFor: (conversationId: string) => string | undefined,
): InklingPermissionBridge {
  const pending = new Map<string, string>(); // request id -> streaming id

  return {
    async decide(request: InklingApprovalRequest): Promise<InklingApproval> {
      const { toolName, toolInput, streamingId, conversationId } = request;
      const mode = conversationId ? permissionModeFor(conversationId) : undefined;
      if (decisionForMode(mode, toolName) === 'allow') return { allow: true };

      const log = getPermissionEventLog();
      const match = isToolAllowed(toolName, toolInput, streamingId);
      if (match) {
        log.autoApproved({ toolName, toolInput, streamingId, matchedPattern: match.pattern, patternSource: match.source });
        return { allow: true };
      }

      const card = addRoutedPermissionRequest(tracker, toolName, toolInput, streamingId, {
        sessionId: conversationId || undefined,
      });
      pending.set(card.id, streamingId);
      log.request({ toolName, toolInput, streamingId, sessionId: card.sessionId, permissionRequestId: card.id });
      try {
        const decision = await waitForDecision(tracker, card.id, DECISION_TIMEOUT_MS);
        if (decision.status === 'approved') return { allow: true };
        if (decision.status === 'timeout') {
          tracker.updatePermissionStatus(card.id, 'denied', { denyReason: 'No decision within 10 minutes' });
          return { allow: false, feedback: 'Nobody answered the approval request in time.' };
        }
        return { allow: false, ...(decision.denyReason ? { feedback: decision.denyReason } : {}) };
      } finally {
        pending.delete(card.id);
      }
    },

    withdraw(streamingId: string): void {
      for (const [id, owner] of pending) {
        if (owner !== streamingId) continue;
        logger.info('Withdrawing an Inkling approval card whose turn ended', { id, streamingId });
        tracker.updatePermissionStatus(id, 'denied', { denyReason: 'The turn ended before a decision' });
      }
    },
  };
}
