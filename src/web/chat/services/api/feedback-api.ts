import type {
  FeedbackContext,
  FeedbackDraftView,
  FeedbackInboxResponse,
  FeedbackInboxView,
  FeedbackProposalView,
  FeedbackRegistration,
  FeedbackScreen,
  FeedbackSendResult,
  FeedbackStatus,
} from '@/types/feedback';
import { ConfigApi } from './config-api';

export class FeedbackApi extends ConfigApi {
  async getFeedbackStatus(): Promise<FeedbackStatus> {
    return this.apiCall('/api/feedback/status');
  }

  async updateFeedbackSettings(settings: { enabled?: boolean; collectorUrl?: string | null }): Promise<FeedbackStatus> {
    return this.apiCall('/api/feedback/settings', { method: 'PUT', body: JSON.stringify(settings) });
  }

  async getFeedbackRegistration(): Promise<FeedbackRegistration> {
    return this.apiCall('/api/feedback/registration');
  }

  /** Trades the one-time check's ticket for the install's key, kept by the server; turns feedback on. */
  async registerFeedback(ticket: string): Promise<FeedbackStatus> {
    return this.apiCall('/api/feedback/register', { method: 'POST', body: JSON.stringify({ ticket }), timeout: 30_000 });
  }

  async getFeedbackProposal(id: string): Promise<FeedbackProposalView> {
    return this.apiCall(`/api/feedback/proposals/${encodeURIComponent(id)}`);
  }

  async getFeedbackContext(conversationId: string | null): Promise<FeedbackContext> {
    const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';
    return this.apiCall(`/api/feedback/context${query}`);
  }

  async listFeedbackDrafts(): Promise<{ drafts: FeedbackDraftView[] }> {
    return this.apiCall('/api/feedback/drafts');
  }

  async getFeedbackDraft(id: string): Promise<FeedbackDraftView> {
    return this.apiCall(`/api/feedback/drafts/${encodeURIComponent(id)}`);
  }

  async createFeedbackDraft(draft: {
    category: string;
    message: string;
    conversationId: string | null;
    screen: FeedbackScreen;
  }): Promise<FeedbackDraftView> {
    return this.apiCall('/api/feedback/drafts', { method: 'POST', body: JSON.stringify({ ...draft, source: 'human' }) });
  }

  async updateFeedbackDraft(id: string, changes: { category: string; message: string }): Promise<FeedbackDraftView> {
    return this.apiCall(`/api/feedback/drafts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(changes) });
  }

  async deleteFeedbackDraft(id: string): Promise<void> {
    await this.apiCall(`/api/feedback/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async sendFeedbackDraft(id: string, revision: number): Promise<FeedbackSendResult> {
    return this.apiCall(`/api/feedback/drafts/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
      timeout: 30_000,
    });
  }

  async getFeedbackInbox(view: FeedbackInboxView): Promise<FeedbackInboxResponse> {
    return this.apiCall(`/api/feedback/inbox?view=${view}`, { timeout: 60_000 });
  }

  async refreshFeedbackInbox(): Promise<void> {
    await this.apiCall('/api/feedback/inbox/refresh', { method: 'POST', timeout: 60_000 });
  }

  async getFeedbackInboxUnread(): Promise<{ unread: number }> {
    return this.apiCall('/api/feedback/inbox/unread-count', { timeout: 60_000 });
  }

  async markFeedbackInboxItem(id: string, changes: { read?: boolean; done?: boolean }): Promise<void> {
    await this.apiCall(`/api/feedback/inbox/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) });
  }
}
