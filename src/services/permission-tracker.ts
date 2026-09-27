import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { PermissionRequest, asClaudeSessionId, asStreamingId } from '@/types/index.js';
import { logger } from '@/services/infrastructure/logger.js';
import { NotificationService } from './notification-service.js';
import type { ActiveConversationRegistry } from './process/active-conversation-registry.js';
import { ConversationService } from './sessions/conversation-service.js';
import { SessionInfoService } from './sessions/session-info-service.js';

/**
 * Service to track permission requests from Claude CLI via MCP
 *
 * Permissions auto-expire after PERMISSION_TTL_MS (matching Claude Code's
 * PreToolUse hook timeout). Once the hook times out, Claude auto-denies on
 * its side — any permission still "pending" in the tracker is a ghost.
 */
export class PermissionTracker extends EventEmitter {
  private permissionRequests: Map<string, PermissionRequest> = new Map();
  /**
   * When each resolved request became non-pending. Kept beside the request
   * rather than on it so the wire shape of PermissionRequest is unchanged.
   */
  private resolvedAt: Map<string, number> = new Map();
  private notificationService?: NotificationService;
  private activeConversationRegistry?: ActiveConversationRegistry;
  private expiryInterval: NodeJS.Timeout | null = null;

  /** Claude Code PreToolUse hook timeout is 600s. Add 5s buffer. */
  private static readonly PERMISSION_TTL_MS = 605_000;
  private static readonly EXPIRY_CHECK_INTERVAL_MS = 30_000;
  /**
   * How long a resolved (approved/denied) request stays queryable before it is
   * evicted. Nothing needs it after the decision round-trip: `waitForDecision`
   * resolves off the `permission_updated` event, and `usePermissions` only ever
   * polls `status: 'pending'`. The window exists so a late GET
   * /api/permissions?status=approved still sees a recent decision.
   */
  private static readonly RESOLVED_RETENTION_MS = 600_000;

  constructor() {
    super();
    // Two listeners per open activity-stream client on top of the internal
    // waitForDecision listeners; the default cap of 10 warns spuriously.
    this.setMaxListeners(100);
    this.startExpiryCheck();
  }

  private startExpiryCheck(): void {
    this.expiryInterval = setInterval(() => this.expireStalePermissions(), PermissionTracker.EXPIRY_CHECK_INTERVAL_MS);
  }

  /**
   * Auto-deny permissions that have been pending longer than the hook timeout,
   * and evict decisions that nobody can still be waiting on.
   *
   * Without the second half the Map only ever grew: an approved or denied
   * request stayed resident (with its full toolInput) for the life of the
   * server process.
   */
  private expireStalePermissions(): void {
    const now = Date.now();
    let evicted = 0;

    for (const [id, request] of this.permissionRequests.entries()) {
      if (request.status === 'pending') {
        const age = now - new Date(request.timestamp).getTime();
        if (age > PermissionTracker.PERMISSION_TTL_MS) {
          logger.info('Permission expired (hook timeout)', { id, toolName: request.toolName, ageMs: age });
          request.status = 'denied';
          request.denyReason = 'Expired — Claude Code hook timed out';
          this.emit('permission_updated', request);
          // Clean up after emitting so waitForDecision resolves
          this.deletePermission(id);
        }
        continue;
      }

      // Resolved. Adopt any entry that was resolved without a stamp (defensive:
      // every path today goes through updatePermissionStatus).
      const resolvedAt = this.resolvedAt.get(id);
      if (resolvedAt === undefined) {
        this.resolvedAt.set(id, now);
        continue;
      }
      if (now - resolvedAt > PermissionTracker.RESOLVED_RETENTION_MS) {
        this.deletePermission(id);
        evicted++;
      }
    }

    if (evicted > 0) {
      logger.debug('Evicted resolved permission requests', { evicted, remaining: this.permissionRequests.size });
    }
  }

  /** Drop a request and its resolution stamp together. */
  private deletePermission(id: string): void {
    this.permissionRequests.delete(id);
    this.resolvedAt.delete(id);
  }

  /**
   * Stop the expiry check interval (for clean shutdown / testing)
   */
  stopExpiryCheck(): void {
    if (this.expiryInterval) {
      clearInterval(this.expiryInterval);
      this.expiryInterval = null;
    }
  }

  /**
   * Set the notification service
   */
  setNotificationService(service: NotificationService): void {
    this.notificationService = service;
  }

  /**
   * Set the conversation status manager
   */
  setActiveConversationRegistry(registry: ActiveConversationRegistry): void {
    this.activeConversationRegistry = registry;
  }

  /**
   * Resolve the active streaming ID for a Claude session ID.
   */
  resolveStreamingIdForSession(sessionId: string): string | undefined {
    if (!this.activeConversationRegistry || !sessionId) {
      return undefined;
    }
    return this.activeConversationRegistry.getStreamingIdForSession(asClaudeSessionId(sessionId));
  }

  /** The provider session a streaming process belongs to, if the registry knows it. */
  sessionIdForStreaming(streamingId: string): string | undefined {
    return this.activeConversationRegistry?.getSessionIdForStreaming(asStreamingId(streamingId));
  }

  /**
   * Add a new permission request.
   *
   * Resolves the Claude provider-session UUID via the registry's
   * streamingId index. Follow-up spawns from `agent-ui-harness`'s
   * SessionManager update that index through the harness's
   * `onFollowUpSpawn` callback (see harness/setup.ts), so the registry
   * stays current across stdin-write turns and respawn turns alike.
   *
   * A request with a `coordinator` is that coordinator's to decide, so the
   * user is not notified until it escalates (`escalatePermission`).
   */
  addPermissionRequest(
    toolName: string,
    toolInput: Record<string, unknown>,
    streamingId?: string,
    options?: { reason?: string; coordinator?: string; sessionId?: string },
  ): PermissionRequest {
    const id = randomUUID();
    // A hook names its provider session itself; after a server restart the
    // registry no longer maps a surviving process's streaming ID to it.
    const sessionId = (streamingId ? this.sessionIdForStreaming(streamingId) : undefined) ?? options?.sessionId;
    const request: PermissionRequest = {
      id,
      streamingId: streamingId || 'unknown',
      sessionId,
      toolName,
      toolInput,
      timestamp: new Date().toISOString(),
      status: 'pending',
      ...(options?.reason ? { reason: options.reason } : {}),
      ...(options?.coordinator ? { coordinator: options.coordinator } : {}),
    };

    this.permissionRequests.set(id, request);
    logger.info('Permission request added', { id, toolName, streamingId, coordinator: options?.coordinator });

    // Emit event for new permission request
    this.emit('permission_request', request);

    if (!request.coordinator) this.notify(request);

    return request;
  }

  /**
   * The coordinator handed a pending request to the user. The request stays
   * pending; it now shows to the user and notifies them as an unrouted one would.
   */
  escalatePermission(id: string, why: string): PermissionRequest | undefined {
    const request = this.permissionRequests.get(id);
    if (!request || request.status !== 'pending') return undefined;
    request.escalation = { why, at: new Date().toISOString() };
    logger.info('Permission request escalated to the user', { id, coordinator: request.coordinator });
    this.emit('permission_updated', request);
    this.notify(request);
    return request;
  }

  private notify(request: PermissionRequest): void {
    if (!this.notificationService) return;
    const sessionId = request.sessionId;
    if (sessionId) {
      let summary: string | undefined;
      try {
        summary = this.notificationSummary(sessionId);
      } catch (error) {
        logger.error('Failed to look up conversation for notification', error);
      }
      this.notificationService.sendPermissionNotification(request, sessionId, summary)
        .catch(err => logger.error('Failed to send permission notification', err));
    } else {
      // No session ID available, send without session info
      this.notificationService.sendPermissionNotification(request)
        .catch(error => {
          logger.error('Failed to send permission notification', error);
        });
    }
  }

  /**
   * What the notification calls the session: the conversation's name, else its
   * first prompt cut to 100 characters, as the transcript-derived summary was.
   * Read from the database; the transcript can run past a gigabyte.
   */
  private notificationSummary(sessionId: string): string | undefined {
    const conversations = ConversationService.getInstance();
    const conversation = conversations.getConversation(sessionId)
      ?? conversations.getConversationByProviderSession(sessionId)?.conversation;
    if (!conversation) return undefined;

    const name = SessionInfoService.getInstance().getSessionInfoSync(conversation.conversationId)?.custom_name?.trim();
    if (name) return name;
    const prompt = conversation.initialPrompt?.trim();
    if (!prompt) return undefined;
    return prompt.length > 100 ? prompt.substring(0, 100) + '...' : prompt;
  }

  /**
   * Get all permission requests
   */
  getAllPermissionRequests(): PermissionRequest[] {
    return Array.from(this.permissionRequests.values());
  }

  /**
   * Get permission requests filtered by criteria
   */
  getPermissionRequests(filter?: { streamingId?: string; sessionId?: string; status?: 'pending' | 'approved' | 'denied' }): PermissionRequest[] {
    let requests = Array.from(this.permissionRequests.values());

    if (filter?.streamingId) {
      requests = requests.filter(req => req.streamingId === filter.streamingId);
    }

    if (filter?.sessionId) {
      requests = requests.filter(req => req.sessionId === filter.sessionId);
    }

    if (filter?.status) {
      requests = requests.filter(req => req.status === filter.status);
    }

    return requests;
  }

  /**
   * Get a specific permission request by ID
   */
  getPermissionRequest(id: string): PermissionRequest | undefined {
    return this.permissionRequests.get(id);
  }

  /**
   * Update permission request status (for future use when we implement approval/denial)
   */
  updatePermissionStatus(
    id: string, 
    status: 'approved' | 'denied', 
    options?: { modifiedInput?: Record<string, unknown>; denyReason?: string }
  ): boolean {
    const request = this.permissionRequests.get(id);
    if (!request) {
      logger.warn('Permission request not found', { id });
      return false;
    }

    request.status = status;
    if (status === 'approved' && options?.modifiedInput) {
      request.modifiedInput = options.modifiedInput;
    }
    if (status === 'denied' && options?.denyReason) {
      request.denyReason = options.denyReason;
    }
    this.resolvedAt.set(id, Date.now());

    logger.info('Permission request updated', { id, status });
    this.emit('permission_updated', request);

    return true;
  }

  /**
   * Clear all permission requests (for testing)
   */
  clear(): void {
    this.permissionRequests.clear();
    this.resolvedAt.clear();
  }

  /**
   * Run the expiry + eviction sweep once (for testing).
   */
  runExpirySweep(): void {
    this.expireStalePermissions();
  }

  /**
   * Get the number of permission requests
   */
  size(): number {
    return this.permissionRequests.size;
  }

  /**
   * Remove all permissions for a specific streaming ID
   * Used for cleanup when a conversation ends
   */
  removePermissionsByStreamingId(streamingId: string): number {
    const toRemove: string[] = [];
    
    // Find all permissions with this streamingId
    for (const [id, request] of this.permissionRequests.entries()) {
      if (request.streamingId === streamingId) {
        toRemove.push(id);
      }
    }
    
    // Remove them
    toRemove.forEach(id => this.deletePermission(id));
    
    if (toRemove.length > 0) {
      logger.info('Removed permissions for streaming session', { 
        streamingId, 
        removedCount: toRemove.length 
      });
    }
    
    return toRemove.length;
  }
}
