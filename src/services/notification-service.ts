import { PermissionRequest } from '@/types/index.js';
import { createLogger, type Logger } from './infrastructure/logger.js';
import { WebPushService } from './web-push-service.js';
import { ViewingPresence } from './viewing-presence.js';
import { ConversationService } from './sessions/conversation-service.js';
import { SessionInfoService } from './sessions/session-info-service.js';
import { InsightsEngine } from './insights/insights-engine.js';
import { readLastTurnReply } from './sessions/worker-report-delivery.js';
import { isQuietTurnMarker } from '@/constants/quiet-turn.js';

/** Encrypted push payloads are capped near 4 KB; the body keeps well under it with room for the rest. */
const MAX_BODY_BYTES = 1500;

export type NotifyResult =
  | { sent: number; failed: number }
  | { skipped: 'watching' | 'disabled' | 'no-devices' };

/**
 * Phone and desktop notifications, sent as web push to every device that
 * turned them on in Settings. Nothing is sent about a conversation someone is
 * looking at on any device (`ViewingPresence`).
 */
export class NotificationService {
  private static instance: NotificationService;
  static getInstance(): NotificationService {
    if (!NotificationService.instance) NotificationService.instance = new NotificationService();
    return NotificationService.instance;
  }

  private logger: Logger = createLogger('NotificationService');
  private webPush = WebPushService.getInstance();
  private presence = ViewingPresence.getInstance();

  /** A permission request waiting on the user. */
  async sendPermissionNotification(request: PermissionRequest, sessionId?: string, summary?: string): Promise<void> {
    const title = sessionId ? await this.sessionTitle(sessionId) : 'Lattice';
    const result = await this.send(sessionId, {
      title,
      message: `Needs your permission: ${summary ? `${summary} - ` : ''}${request.toolName}`,
      kind: 'permission',
    });
    this.logger.info('Permission notification', { requestId: request.id, sessionId, ...result });
  }

  /**
   * A session's turn ended on a reply for the user. Skips sessions an agent
   * dispatched (their reply goes to the session that picked them up), archived
   * ones, and turns that ended without a reply (stopped, compaction, tool call, quiet turn).
   */
  async notifyTurnFinished(sessionId: string): Promise<void> {
    try {
      const conversation = ConversationService.getInstance().getConversation(sessionId);
      if (!conversation || conversation.pickedUpFrom) return;
      if (SessionInfoService.getInstance().getSessionInfoSync(sessionId)?.archived) return;
      const reply = readLastTurnReply(sessionId);
      // A coordinator's quiet turn ends on a marker Lattice hides: nothing to show the user.
      if (!reply || isQuietTurnMarker(reply)) return;
      const result = await this.send(sessionId, {
        title: await this.sessionTitle(sessionId),
        message: openingParagraph(reply),
        kind: 'turn-finished',
      });
      this.logger.info('Turn finished notification', { sessionId, ...result });
    } catch (error) {
      this.logger.error('Turn finished notification failed', error, { sessionId });
    }
  }

  /** An agent asking the user to look at something (`lattice notify`). */
  async notifyFromAgent(sessionId: string, message: string): Promise<NotifyResult> {
    const result = await this.send(sessionId, { title: await this.sessionTitle(sessionId), message, kind: 'agent' });
    this.logger.info('Agent notification', { sessionId, ...result });
    return result;
  }

  private async send(
    sessionId: string | undefined,
    note: { title: string; message: string; kind: string },
  ): Promise<NotifyResult> {
    if (!this.webPush.getEnabled()) return { skipped: 'disabled' };
    if (sessionId && this.presence.isWatched(sessionId)) return { skipped: 'watching' };
    await this.webPush.initialize();
    if (this.webPush.getSubscriptionCount() === 0) return { skipped: 'no-devices' };
    const sentAt = Date.now();
    if (sessionId) this.presence.noteNotified(sessionId, sentAt);
    return this.webPush.broadcast({
      title: note.title,
      message: fitBytes(note.message, MAX_BODY_BYTES),
      tag: sessionId ? `conv-${sessionId}` : 'lattice',
      data: { sessionId, type: note.kind, sentAt, clear: this.presence.clearable(sentAt) },
    });
  }

  /** The name the sidebar shows: the user's own name for it, else the project's, else the generated one. */
  private async sessionTitle(sessionId: string): Promise<string> {
    const info = SessionInfoService.getInstance().getSessionInfoSync(sessionId);
    const mission = (await InsightsEngine.getInstance().getInsightsRecord(sessionId).catch(() => null))?.context?.mission?.trim();
    return info?.custom_name?.trim() || info?.project_name?.trim() || mission || 'Lattice';
  }
}

/** The reply's first paragraph, without markdown marks: replies lead with the result. */
export function openingParagraph(reply: string): string {
  const first = reply.trim().split(/\n\s*\n/)[0] ?? '';
  return first
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts at a word boundary with a visible ellipsis only when the text is over the push size limit. */
function fitBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let cut = text;
  while (Buffer.byteLength(cut) > maxBytes - 3) cut = cut.slice(0, cut.lastIndexOf(' ', cut.length - 2));
  return `${cut}…`;
}
