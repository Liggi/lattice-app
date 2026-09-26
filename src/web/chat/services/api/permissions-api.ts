import type {
  PermissionDecisionRequest,
  PermissionDecisionResponse,
  PermissionRequest,
} from '../../types';
import { ConversationApi } from './conversation-api';

export class PermissionsApi extends ConversationApi {
  async getPermissions(params?: {
    streamingId?: string;
    sessionId?: string;
    status?: 'pending' | 'approved' | 'denied';
  }): Promise<{ permissions: PermissionRequest[] }> {
    const searchParams = new URLSearchParams();
    if (params?.streamingId) searchParams.append('streamingId', params.streamingId);
    if (params?.sessionId) searchParams.append('sessionId', params.sessionId);
    if (params?.status) searchParams.append('status', params.status);

    return this.apiCall(`/api/permissions?${searchParams}`);
  }

  async sendPermissionDecision(
    requestId: string,
    decision: PermissionDecisionRequest
  ): Promise<PermissionDecisionResponse> {
    return this.apiCall(`/api/permissions/${requestId}/decision`, {
      method: 'POST',
      body: JSON.stringify(decision),
    });
  }

  async addToAllowlist(
    scope: 'session' | 'global',
    pattern: string,
    streamingId?: string
  ): Promise<{ success: boolean; pattern: string }> {
    const body = scope === 'session'
      ? { pattern, streamingId }
      : { pattern };
    return this.apiCall(`/api/permissions/allowlist/${scope}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getSuggestedPatterns(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<{ patterns: string[] }> {
    return this.apiCall('/api/permissions/suggest-patterns', {
      method: 'POST',
      body: JSON.stringify({ toolName, toolInput }),
    });
  }

}
