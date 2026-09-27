/**
 * A worker's permission prompt goes to its coordinator, not the user.
 *
 * Workers usually run with permission prompts skipped, but Claude Code's
 * safety check still asks about some commands (deleting with a wildcard,
 * writing under `~/.claude`), and a worker started in ask mode asks about
 * ordinary tool calls. The coordinator gets the request straight away, even mid-turn,
 * because Claude Code gives up on it after about ten minutes. It decides with
 * `session permission` or hands it to the user with `escalate`; the user is
 * not asked until it does. The inbox item is not a message, so the
 * coordinator's thread does not show it.
 */

import type { PermissionRequest } from '../../types/index.js';
import type { PermissionTracker } from '../permission-tracker.js';
import { createLogger } from '../infrastructure/logger.js';
import { ConversationService } from './conversation-service.js';
import { enqueueInboxItem } from './session-inbox.js';
import { handOverNow } from './immediate-delivery.js';
import { latticeCli } from './pickup-prompts.js';
import { UserName } from '../user-profile.js';

const logger = createLogger('WorkerPermissionDelivery');

/** The worker a provider session belongs to and the coordinator it reports to, if it has one. */
export function workerAndCoordinator(providerSessionId: string | undefined): { worker: string; coordinator: string } | null {
  if (!providerSessionId) return null;
  const conversation = ConversationService.getInstance().getConversationByProviderSession(providerSessionId)?.conversation;
  if (!conversation?.pickedUpFrom) return null;
  return { worker: conversation.conversationId, coordinator: conversation.pickedUpFrom };
}

/** What the tool would do, as the coordinator reads it. */
function describeInput(request: PermissionRequest): string {
  const input = request.toolInput;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  return JSON.stringify(input, null, 2);
}

/** The text the coordinator reads. Exported for tests. */
export function workerPermissionText(request: PermissionRequest, worker: string, cli: string): string {
  const command = `${cli} session permission ${request.id}`;
  return [
    `[Permission request from your worker ${worker}. Claude Code's safety check stopped this ${request.toolName} call and is waiting for a decision; it denies it on its own after about 10 minutes. ${UserName()} has not been asked.]`,
    ...(request.reason ? [`Reason given: ${request.reason}`] : []),
    '```',
    describeInput(request),
    '```',
    `Decide it yourself if you can: \`${command} allow --from ${request.coordinator}\` or \`${command} deny --from ${request.coordinator} --reason "<what the worker should do instead>"\`.`,
    `If it is ${UserName()}'s call (it deletes or overwrites something that matters, reaches outside the work, or you cannot tell what it does), hand it over: \`${command} escalate --from ${request.coordinator} --reason "<one plain sentence for ${UserName()}>"\`. ${UserName()} is then asked directly; do not also ask in the thread.`,
  ].join('\n');
}

/** Hand the request to the coordinator now. Never rejects. */
export async function tellCoordinatorAboutPermission(request: PermissionRequest, worker: string): Promise<void> {
  if (!request.coordinator) return;
  try {
    const inboxId = enqueueInboxItem({
      sessionId: request.coordinator,
      source: 'worker-permission',
      text: workerPermissionText(request, worker, latticeCli()),
      worker,
    });
    await handOverNow(request.coordinator, inboxId);
  } catch (err) {
    logger.error('Handing a permission request to the coordinator threw', {
      worker,
      coordinator: request.coordinator,
      requestId: request.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record a permission request, routed to the worker's coordinator when the
 * session is a worker. Every path that raises a prompt goes through here: the
 * SDK bridge (safety checks under skipped prompts) and the hooks (ask mode).
 * A hook passes the provider `sessionId` it was given, for when the streaming
 * ID no longer resolves.
 */
export function addRoutedPermissionRequest(
  tracker: PermissionTracker,
  toolName: string,
  toolInput: Record<string, unknown>,
  streamingId: string | undefined,
  options?: { reason?: string; sessionId?: string },
): PermissionRequest {
  const sessionId = (streamingId ? tracker.sessionIdForStreaming(streamingId) : undefined) ?? options?.sessionId;
  const routing = workerAndCoordinator(sessionId);
  const request = tracker.addPermissionRequest(toolName, toolInput, streamingId, { ...options, coordinator: routing?.coordinator });
  if (routing) void tellCoordinatorAboutPermission(request, routing.worker);
  return request;
}
