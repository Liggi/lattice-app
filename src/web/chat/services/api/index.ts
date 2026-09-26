import { SessionApi } from './session-api';

export { ApiRequestError, isApiTimeoutError, resolveConversationDetailsFallbackLimit } from './core';
export type {
  ActiveSessionsOverview,
  AppConfig,
  AppConfigInterface,
  SessionAuditTrailResponse,
  SessionCostsResponse,
  SessionDiagnostic,
  SessionEventsResponse,
  TeamAgentCompletion,
  TeamInboxSummary,
  TeamInfoResponse,
  TeamMemberSummary,
  UnifiedStopConversationOptions,
  UnifiedStopInFlightMessage,
} from './types';

export class ApiService extends SessionApi {}

export const api = new ApiService();
