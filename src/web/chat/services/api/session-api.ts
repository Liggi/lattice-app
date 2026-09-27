import type { PendingQuestion } from '../../types';
import { FeedbackApi } from './feedback-api';
import type {
  SessionAuditTrailResponse,
  SessionCostsResponse,
  SessionDiagnostic,
  SessionEventsResponse,
} from './types';

const DEV_NOTES_CACHE_KEY = 'session:dev-notes';
const PENDING_RECOMMENDATIONS_CACHE_KEY = 'session:pending-recommendations';
const SESSION_TURNS_CACHE_KEY_PREFIX = 'session:turns:';
const NAV_METADATA_CACHE_TTL_MS = 15_000;
const SESSION_TURNS_CACHE_TTL_MS = 10_000;

export class SessionApi extends FeedbackApi {
  async getSessionTurns(sessionId: string): Promise<{ turns: import('../../types').Turn[] }> {
    return this.cachedGet(
      `${SESSION_TURNS_CACHE_KEY_PREFIX}${sessionId}`,
      SESSION_TURNS_CACHE_TTL_MS,
      () => this.apiCall(`/api/insights/${sessionId}/turns`)
    );
  }

  async analyzeSessionForReview(sessionId: string, forceRefresh = false): Promise<{
    summary: { goal: string; outcome: string };
    groupedEvents: {
      friction: Array<{ text: string; icon: string }>;
      built: Array<{ text: string; icon: string }>;
      learned: Array<{ text: string; icon: string }>;
    };
    metrics: { duration: string; messages: number; toolUses: number; errors: number; filesEdited: number };
    recommendations: Array<{
      id: string;
      observation: string;
      suggestion: string;
      why: string;
      priorOccurrences: number;
    }>;
    rootCauses: Array<{
      surface: string;
      root: string;
      preventable: string;
    }>;
    claudeAnalysis: {
      strengths: string[];
      weaknesses: string[];
      keyInsight: string;
    };
    userFeedback: {
      effective: string[];
      opportunities: string[];
      keyInsight: string;
    };
    projectPath: string | null;
  }> {
    const queryParam = forceRefresh ? '?force=true' : '';
    return this.apiCall(`/api/insights/${sessionId}/review${queryParam}`, {
      method: 'POST',
      timeout: 120000,
    });
  }

  async dismissRecommendation(id: string): Promise<{ success: boolean; id: string }> {
    const response = await this.apiCall<{ success: boolean; id: string }>(`/api/insights/recommendations/${id}/dismiss`, {
      method: 'POST',
    });
    this.invalidateCachedGet(PENDING_RECOMMENDATIONS_CACHE_KEY);
    return response;
  }

  async completeRecommendation(id: string): Promise<{ success: boolean; id: string }> {
    const response = await this.apiCall<{ success: boolean; id: string }>(`/api/insights/recommendations/${id}/complete`, {
      method: 'POST',
    });
    this.invalidateCachedGet(PENDING_RECOMMENDATIONS_CACHE_KEY);
    return response;
  }

  async getPendingRecommendations(): Promise<{
    recommendations: Array<{
      id: string;
      sessionId: string;
      target: string;
      improvementType?: string;
      friction: string;
      action: string;
      rationale: string;
      status: string;
      createdAt: string;
      projectPath?: string | null;
      sourceProject?: string | null;
      sourceMission?: string | null;
    }>;
  }> {
    return this.cachedGet(
      PENDING_RECOMMENDATIONS_CACHE_KEY,
      NAV_METADATA_CACHE_TTL_MS,
      () => this.apiCall('/api/insights/recommendations/pending')
    );
  }

  async getDevNotes(): Promise<{
    notes: Array<{
      id: string;
      content: string;
      priority: 'low' | 'normal' | 'high';
      status: 'pending' | 'done' | 'dismissed';
      projectPath: string | null;
      createdAt: string;
    }>;
  }> {
    return this.cachedGet(
      DEV_NOTES_CACHE_KEY,
      NAV_METADATA_CACHE_TTL_MS,
      () => this.apiCall('/api/notes')
    );
  }

  async createDevNote(note: {
    content: string;
    priority?: 'low' | 'normal' | 'high';
    projectPath?: string;
  }): Promise<{ id: string }> {
    const response = await this.apiCall<{ id: string }>('/api/notes', {
      method: 'POST',
      body: JSON.stringify(note),
    });
    this.invalidateCachedGet(DEV_NOTES_CACHE_KEY);
    return response;
  }

  async updateDevNote(id: string, updates: {
    content?: string;
    priority?: 'low' | 'normal' | 'high';
    status?: 'pending' | 'done' | 'dismissed';
  }): Promise<{ success: boolean }> {
    const response = await this.apiCall<{ success: boolean }>(`/api/notes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    this.invalidateCachedGet(DEV_NOTES_CACHE_KEY);
    return response;
  }

  async updateDevNoteStatus(id: string, status: 'done' | 'dismissed'): Promise<{ success: boolean }> {
    return this.updateDevNote(id, { status });
  }

  async deleteDevNote(id: string): Promise<{ success: boolean }> {
    const response = await this.apiCall<{ success: boolean }>(`/api/notes/${id}`, {
      method: 'DELETE',
    });
    this.invalidateCachedGet(DEV_NOTES_CACHE_KEY);
    return response;
  }

  async getPendingQuestions(sessionId?: string): Promise<{ questions: PendingQuestion[] }> {
    const searchParams = new URLSearchParams();
    if (sessionId) {
      searchParams.append('sessionId', sessionId);
    }
    const query = searchParams.toString();
    return this.apiCall(`/api/pending-questions${query ? `?${query}` : ''}`);
  }

  async answerPendingQuestion(
    questionId: string,
    answers: Record<string, string>
  ): Promise<{
    success: boolean;
    streamingId: string;
    sessionId: string;
    message: string;
  }> {
    return this.apiCall(`/api/pending-questions/${questionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    });
  }

  async expirePendingQuestion(questionId: string): Promise<{ success: boolean }> {
    return this.apiCall(`/api/pending-questions/${questionId}/expire`, {
      method: 'POST',
    });
  }

  async getSessionDiagnostic(sessionId: string): Promise<SessionDiagnostic> {
    return this.apiCall(`/api/debug/sessions/${sessionId}/diagnostic`);
  }

  async getSessionEvents(
    sessionId: string,
    params?: {
      traceId?: string;
      limit?: number;
      since?: string;
      types?: string[];
    }
  ): Promise<SessionEventsResponse> {
    const searchParams = new URLSearchParams();
    if (params?.traceId) searchParams.append('traceId', params.traceId);
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    if (params?.since) searchParams.append('since', params.since);
    if (params?.types) searchParams.append('types', params.types.join(','));
    const query = searchParams.toString();
    return this.apiCall(`/api/debug/sessions/${sessionId}/events${query ? `?${query}` : ''}`);
  }

  async getSessionAuditTrail(
    sessionId: string,
    params?: {
      limit?: number;
      eventTypes?: string[];
      triggers?: string[];
      since?: string;
    }
  ): Promise<SessionAuditTrailResponse> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    if (params?.eventTypes) searchParams.append('eventTypes', params.eventTypes.join(','));
    if (params?.triggers) searchParams.append('triggers', params.triggers.join(','));
    if (params?.since) searchParams.append('since', params.since);
    const query = searchParams.toString();
    return this.apiCall(`/api/debug/sessions/${sessionId}/audit-trail${query ? `?${query}` : ''}`);
  }

  async getSessionCosts(sessionId: string): Promise<SessionCostsResponse> {
    return this.apiCall(`/api/debug/sessions/${sessionId}/costs`);
  }

}
