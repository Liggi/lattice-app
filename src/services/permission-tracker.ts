import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { PermissionRequest, asClaudeSessionId, asStreamingId } from '@/types/index.js';
import { logger } from '@/services/infrastructure/logger.js';
import { NotificationService } from './notification-service.js';
import type { ActiveConversationRegistry } from './process/active-conversation-registry.js';
import { ClaudeHistoryReader } from './sessions/claude-history-reader.js';

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
  private historyReader?: ClaudeHistoryReader;
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
   * Set the history reader
   */
  setHistoryReader(reader: ClaudeHistoryReader): void {
    this.historyReader = reader;
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

  /**
   * Add a new permission request.
   *
   * Resolves the Claude provider-session UUID via the registry's
   * streamingId index. Follow-up spawns from `agent-ui-harness`'s
   * SessionManager update that index through the harness's
   * `onFollowUpSpawn` callback (see harness/setup.ts), so the registry
   * stays current across stdin-write turns and respawn turns alike.
   */
  addPermissionRequest(
    toolName: string,
    toolInput: Record<string, unknown>,
    streamingId?: string,
  ): PermissionRequest {
    const id = randomUUID();
    const sessionId = streamingId && this.activeConversationRegistry
      ? this.activeConversationRegistry.getSessionIdForStreaming(asStreamingId(streamingId))
      : undefined;
    const request: PermissionRequest = {
      id,
      streamingId: streamingId || 'unknown',
      sessionId,
      toolName,
      toolInput,
      timestamp: new Date().toISOString(),
      status: 'pending',
    };

    this.permissionRequests.set(id, request);
    logger.info('Permission request added', { id, toolName, streamingId });

    // Emit event for new permission request
    this.emit('permission_request', request);

    // Send notification if services are available
    if (this.notificationService && this.activeConversationRegistry && this.historyReader) {
      // Get session ID from streaming ID
      const sessionId = this.activeConversationRegistry.getSessionIdForStreaming(asStreamingId(streamingId || ''));
      
      if (sessionId) {
        // Try to get conversation summary
        this.historyReader.fetchConversationDirect(sessionId)
          .then(({ metadata }) => {
            if (this.notificationService) {
              return this.notificationService.sendPermissionNotification(
                request,
                sessionId,
                metadata?.summary
              );
            }
          })
          .catch(error => {
            logger.error('Failed to fetch conversation metadata for notification', error);
            // Fall back to sending without summary
            if (this.notificationService) {
              this.notificationService.sendPermissionNotification(request, sessionId)
                .catch(err => logger.error('Failed to send permission notification', err));
            }
          });
      } else {
        // No session ID available, send without session info
        this.notificationService.sendPermissionNotification(request)
          .catch(error => {
            logger.error('Failed to send permission notification', error);
          });
      }
    }

    return request;
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
