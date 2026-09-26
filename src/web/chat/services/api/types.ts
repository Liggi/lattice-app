import type { DisplayContentBlock } from '../../types';
import type { Provider } from '@/types/unified-messages';

import type { CoordinatorConfig } from '@/types/config';

export interface AppConfigInterface {
  colorScheme?: 'light' | 'dark' | 'system';
  language?: string;
  devMode?: boolean;
  voice?: boolean;
  notifications?: {
    enabled: boolean;
    ntfyUrl?: string;
  };
}

/**
 * A saved key is never read back: GET says whether one is set, PUT takes a
 * string to replace it, `null` to remove it, and nothing to keep it.
 */
export interface SecretKeyConfig {
  apiKey?: string | null;
  apiKeyConfigured?: boolean;
}

export interface AppConfig {
  anthropic?: SecretKeyConfig;
  coordinator?: CoordinatorConfig;
  gemini?: SecretKeyConfig;
  server?: {
    systemPrompt?: string;
    host?: string;
    port?: number;
    /** How Claude conversations are billed: the CLI's own sign-in, or the saved Anthropic key. */
    claudeAuthMode?: 'cli' | 'api-key';
    defaultPermissionMode?: string;
    defaultModel?: string;
    defaultWorkingDirectory?: string;
    tailscaleIp?: string;
    tailscaleCli?: string;
    /** Runtime-only: the `tailscale serve` command for this port, or its address if already served */
    tailscaleServe?: TailscaleServeAdvice;
    /** Runtime-only: an ambient watcher has written a scan on this machine */
    ambientScan?: boolean;
    /** Runtime-only: directory where lattice was invoked from */
    cwd?: string;
  };
  interface?: AppConfigInterface;
}

export interface TailscaleServeAdvice {
  command: string | null;
  url: string | null;
}

export interface TeamMemberSummary {
  agentId: string;
  name: string;
  agentType: string;
  model: string;
  joinedAt: number;
  tmuxPaneId: string;
  cwd: string;
  subscriptions: string[];
  color?: string;
  backendType?: string;
  prompt?: string;
  planModeRequired?: boolean;
}

export interface TeamInboxSummary {
  agentName: string;
  messageCount: number;
  unreadCount: number;
  latestTimestamp: string | null;
}

export interface TeamAgentCompletion {
  agentName: string;
  deliveredToLead: boolean;
  messagesDelivered: number;
}

export interface TeamInfoResponse {
  teamName: string;
  leadSessionId: string;
  memberCount: number;
  tasks: {
    pending: number;
    in_progress: number;
    completed: number;
  };
  config: {
    name: string;
    description?: string;
    createdAt: number;
    leadAgentId: string;
    leadSessionId: string;
    members: TeamMemberSummary[];
  };
  inboxSummaries?: TeamInboxSummary[];
  agentCompletions?: TeamAgentCompletion[];
  timestamp: number;
}

export interface UnifiedConversationResolutionResponse {
  requestedId: string;
  resolvedId: string;
  conversationId: string;
  created: boolean;
  resolvedFrom: 'conversationId' | 'sessionInfoLink' | 'providerSessionId' | 'sessionPrefix' | 'adopted';
  provider: Provider | null;
  workingDirectory: string;
  workspace: string;
}

export interface UnifiedStopInFlightMessage {
  id: string;
  timestamp: string;
  content: DisplayContentBlock[];
}

export interface UnifiedStopConversationOptions {
  inFlightMessage?: UnifiedStopInFlightMessage;
}

export interface SessionDiagnostic {
  sessionId: string;
  sessionIdShort: string;
  checkedAt: string;
  statusManager: {
    isActive: boolean;
    streamingId: string | null;
    hasContext: boolean;
    contextModel: string | null;
    contextTraceId: string | null;
  } | null;
  database: {
    exists: true;
    archived: boolean;
    pinned: boolean;
    customName: string | null;
    workspace: string;
    createdAt: string;
    updatedAt: string;
  } | { exists: false } | null;
  daemon: {
    hasActiveProcess: boolean;
    streamingId: string | null;
    totalActiveProcesses: number;
  } | { error: string } | null;
  recentEvents: Array<{
    type: string;
    timestamp: string;
    provider?: string;
    streamingId?: string;
  }>;
  diagnosis: Array<{
    level: 'info' | 'warning' | 'error';
    message: string;
  }>;
}

export interface SessionEventsResponse {
  sessionId: string;
  traceId: string | null;
  summary: {
    traceId: string | null;
    eventCount: number;
    providers: string[];
    traceIds: string[];
    firstEventAt: string | null;
    lastEventAt: string | null;
    counts: Record<string, number>;
    durationsMs: {
      toStreamConnect: number | null;
      toFirstMessage: number | null;
      toSessionEnd: number | null;
    };
    anomalies: {
      overlappingStreams: number;
      duplicateMessageCompletes: number;
      missingContextTransfer: boolean;
    };
  };
  events: Array<{
    eventType: string;
    timestamp: string;
    provider?: string;
    streamingId?: string;
    traceId?: string;
    messageId?: string;
  }>;
}

export interface SessionAuditTrailResponse {
  sessionId: string;
  sessionIdShort: string;
  eventCount: number;
  events: Array<{
    traceId: string;
    sessionId: string;
    eventType: string;
    trigger: string;
    actionContent: string[] | null;
    beforeState: Record<string, unknown> | null;
    afterState: Record<string, unknown> | null;
    llmResponse: string | null;
    patchedFields: string[] | null;
    durationMs: number | null;
    skippedReason: string | null;
    createdAt: string;
  }>;
}

export interface SessionCostsResponse {
  sessionId: string;
  sessionIdShort: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  recentCalls: Array<{
    operation: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
    createdAt: string;
  }>;
}

export interface ActiveSessionsOverview {
  checkedAt: string;
  statusManager: {
    count: number;
    sessions: Array<{ sessionId: string; streamingId: string }>;
  } | null;
  daemon: {
    count: number;
    sessions: Array<{ sessionId: string | null; streamingId: string }>;
  } | { error: string } | null;
}
