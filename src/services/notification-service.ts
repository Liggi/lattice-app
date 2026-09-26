import os from 'os';
import { PermissionRequest } from '@/types/index.js';
import { createLogger, type Logger } from './infrastructure/logger.js';
import { ConfigService } from './infrastructure/config-service.js';
import { WebPushService } from './web-push-service.js';

export interface Notification {
  title: string;
  message: string;
  priority: 'min' | 'low' | 'default' | 'high' | 'urgent';
  tags: string[];
  sessionId: string;
  streamingId: string;
  permissionRequestId?: string;
}

export interface CompletionNotificationDetails {
  sessionName?: string;
  turnHeadline?: string;
  turnAction?: string;
}

/**
 * Service for sending push notifications via ntfy.sh
 */
export class NotificationService {
  private logger: Logger;
  private configService: ConfigService;
  private hostname: string;
  private webPushService: WebPushService;

  constructor() {
    this.logger = createLogger('NotificationService');
    this.configService = ConfigService.getInstance();
    this.webPushService = WebPushService.getInstance();
    // Use hostname for ntfy topic
    this.hostname = os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Get hostname for topic identification
   */
  private getHostname(): string {
    return this.hostname;
  }

  /**
   * Check if notifications are enabled
   */
  private async isEnabled(): Promise<boolean> {
    const config = this.configService.getConfig();
    return config.interface.notifications?.enabled ?? false;
  }

  /**
   * Get the ntfy URL from preferences
   */
  private async getNtfyUrl(): Promise<string> {
    const config = this.configService.getConfig();
    return config.interface.notifications?.ntfyUrl || 'https://ntfy.sh';
  }

  /**
   * Send a notification for a permission request
   */
  async sendPermissionNotification(
    request: PermissionRequest,
    sessionId?: string,
    summary?: string
  ): Promise<void> {
    if (!(await this.isEnabled())) {
      this.logger.debug('Notifications disabled, skipping permission notification');
      return;
    }

    try {
      const hostname = this.getHostname();
      const topic = `lattice-${hostname}`;
      const ntfyUrl = await this.getNtfyUrl();

      const notification: Notification = {
        title: 'Claudia Permission Request',
        message: summary
          ? `${summary} - ${request.toolName}`
          : `${request.toolName} tool: ${JSON.stringify(request.toolInput).substring(0, 100)}...`,
        priority: 'default',
        tags: ['claudia-permission'],
        sessionId: sessionId || 'unknown',
        streamingId: request.streamingId,
        permissionRequestId: request.id
      };

      let ntfyError: Error | undefined;
      try {
        // Send via ntfy (best-effort)
        await this.sendNotification(ntfyUrl, topic, notification);
      } catch (err) {
        ntfyError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn('Ntfy permission notification failed (continuing with web push)', {
          requestId: request.id,
          error: ntfyError.message,
        });
      }

      // Also broadcast via native web push (best-effort, independent of ntfy result)
      let webPushError: Error | undefined;
      try {
        await this.webPushService.initialize();
        if (this.webPushService.getEnabled()) {
          const result = await this.webPushService.broadcast({
            title: notification.title,
            message: notification.message,
            tag: notification.tags[0],
            data: {
              sessionId: notification.sessionId,
              streamingId: notification.streamingId,
              permissionRequestId: notification.permissionRequestId,
              type: 'permission',
            },
          });
          this.logger.debug('Permission web push broadcast completed', {
            requestId: request.id,
            sent: result.sent,
            failed: result.failed,
          });
        }
      } catch (err) {
        webPushError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn('Permission web push broadcast failed', {
          requestId: request.id,
          error: webPushError.message,
        });
      }
      
      this.logger.info('Permission notification dispatched', {
        requestId: request.id,
        toolName: request.toolName,
        topic,
        ntfyOk: !ntfyError,
        webPushOk: !webPushError,
      });
    } catch (error) {
      this.logger.error('Failed to send permission notification', error, {
        requestId: request.id
      });
    }
  }

  /**
   * Send a notification when a conversation ends
   */
  async sendConversationEndNotification(
    streamingId: string,
    sessionId: string,
    summary?: string,
    details?: CompletionNotificationDetails
  ): Promise<void> {
    if (!(await this.isEnabled())) {
      this.logger.debug('Notifications disabled, skipping conversation end notification');
      return;
    }

    try {
      const hostname = this.getHostname();
      const topic = `lattice-${hostname}`;
      const ntfyUrl = await this.getNtfyUrl();
      const message = this.composeConversationCompletionMessage(summary, details);

      const notification: Notification = {
        title: 'Task Finished',
        message,
        priority: 'default',
        tags: ['claudia-complete'],
        sessionId,
        streamingId
      };

      let ntfyError: Error | undefined;
      try {
        // Send via ntfy (best-effort)
        await this.sendNotification(ntfyUrl, topic, notification);
      } catch (err) {
        ntfyError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn('Ntfy conversation end notification failed (continuing with web push)', {
          sessionId,
          streamingId,
          error: ntfyError.message,
        });
      }

      // Also broadcast via native web push (best-effort, independent of ntfy result)
      let webPushError: Error | undefined;
      try {
        await this.webPushService.initialize();
        if (this.webPushService.getEnabled()) {
          const result = await this.webPushService.broadcast({
            title: notification.title,
            message: notification.message,
            tag: notification.tags[0],
            data: {
              sessionId: notification.sessionId,
              streamingId: notification.streamingId,
              type: 'conversation-end',
            },
          });
          this.logger.debug('Conversation end web push broadcast completed', {
            sessionId,
            streamingId,
            sent: result.sent,
            failed: result.failed,
          });
        }
      } catch (err) {
        webPushError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn('Conversation end web push broadcast failed', {
          sessionId,
          streamingId,
          error: webPushError.message,
        });
      }
      
      this.logger.info('Conversation end notification dispatched', {
        sessionId,
        streamingId,
        topic,
        usedSummary: !!summary,
        usedSessionName: !!details?.sessionName,
        usedTurnDetail: !!details?.turnAction || !!details?.turnHeadline,
        ntfyOk: !ntfyError,
        webPushOk: !webPushError,
      });
    } catch (error) {
      this.logger.error('Failed to send conversation end notification', error, {
        sessionId,
        streamingId
      });
    }
  }

  /**
   * Build a richer completion notification message.
   */
  private composeConversationCompletionMessage(
    summary?: string,
    details?: CompletionNotificationDetails
  ): string {
    const cleanedSummary = this.compactMessage(summary);
    const sessionName = this.compactMessage(details?.sessionName);
    const turnAction = this.compactMessage(details?.turnAction);
    const turnHeadline = this.compactMessage(details?.turnHeadline);
    const turnDetail = turnAction || turnHeadline;

    if (cleanedSummary && !this.isGenericCompletionSummary(cleanedSummary)) {
      return this.truncateMessage(cleanedSummary, 180);
    }

    if (sessionName && turnDetail) {
      return this.truncateMessage(`${sessionName}: ${turnDetail}`, 180);
    }

    if (turnDetail) {
      return this.truncateMessage(turnDetail, 180);
    }

    if (sessionName) {
      return this.truncateMessage(`${sessionName} finished`, 180);
    }

    return 'Task completed';
  }

  private isGenericCompletionSummary(summary: string): boolean {
    const normalized = summary.toLowerCase();
    return normalized === 'task completed'
      || normalized === 'task finished'
      || normalized === 'completed'
      || normalized === 'done'
      || normalized === 'success';
  }

  private compactMessage(value?: string): string {
    if (!value) return '';
    return value.replace(/\s+/g, ' ').trim();
  }

  private truncateMessage(value: string, maxLen: number): string {
    if (value.length <= maxLen) return value;
    return value.slice(0, maxLen - 3) + '...';
  }

  /**
   * Send a notification to ntfy
   */
  private async sendNotification(
    ntfyUrl: string,
    topic: string,
    notification: Notification
  ): Promise<void> {
    const url = `${ntfyUrl}/${topic}`;
    
    const headers: Record<string, string> = {
      'Title': notification.title,
      'Priority': notification.priority,
      'Tags': notification.tags.join(',')
    };

    // Add custom headers for CUI metadata
    headers['X-CUI-SessionId'] = notification.sessionId;
    headers['X-CUI-StreamingId'] = notification.streamingId;
    if (notification.permissionRequestId) {
      headers['X-CUI-PermissionRequestId'] = notification.permissionRequestId;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: notification.message
    });

    if (!response.ok) {
      throw new Error(`Ntfy returned ${response.status}: ${await response.text()}`);
    }
  }
}
