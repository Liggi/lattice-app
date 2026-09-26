import { LatticeError } from '@/types/index.js';
import type { ClaudeHistoryReader } from './claude-history-reader.js';
import type { ActiveConversationRegistry } from '../process/active-conversation-registry.js';
import type { SessionInfoService } from './session-info-service.js';
import type { ConversationService, Provider, Conversation } from './conversation-service.js';
type ResolutionSource = 'conversationId' | 'sessionInfoLink' | 'providerSessionId' | 'sessionPrefix';

interface LegacySessionInfo {
  conversation_id?: string | null;
  workspace?: string | null;
  branched_from_session_id?: string | null;
  branched_at_turn?: number | null;
}

interface ExistingConversationResolution {
  conversationId: string;
  conversation: Conversation;
  resolvedFrom: 'conversationId' | 'sessionInfoLink' | 'providerSessionId';
  resolvedId: string;
}

export interface ResolveConversationIdResult {
  requestedId: string;
  resolvedId: string;
  conversationId: string;
  created: boolean;
  resolvedFrom: ResolutionSource;
  provider: Provider | null;
  workingDirectory: string;
  workspace: string;
}

export interface ConversationIdResolutionServiceDeps {
  conversationService: ConversationService;
  sessionInfoService: SessionInfoService;
  historyReader: ClaudeHistoryReader;
  activeConversationRegistry: ActiveConversationRegistry;
}

export class ConversationIdResolutionService {
  private readonly resolveInFlight = new Map<string, Promise<ResolveConversationIdResult>>();

  constructor(private readonly deps: ConversationIdResolutionServiceDeps) {}

  async resolveConversationId(params: {
    requestedId: string;
    traceId: string;
  }): Promise<ResolveConversationIdResult> {
    const { requestedId, traceId } = params;

    const existing = this.resolveInFlight.get(requestedId);
    if (existing) {
      return existing;
    }

    const resolve = this.resolveConversationIdInternal({ requestedId, traceId });
    this.resolveInFlight.set(requestedId, resolve);

    try {
      return await resolve;
    } finally {
      this.resolveInFlight.delete(requestedId);
    }
  }

  private async resolveConversationIdInternal(params: {
    requestedId: string;
    traceId: string;
  }): Promise<ResolveConversationIdResult> {
    const { requestedId, traceId: _traceId } = params;
    const {
      sessionInfoService,
      historyReader: _historyReader,
      activeConversationRegistry: _activeConversationRegistry,
    } = this.deps;

    const direct = await this.resolveExistingConversation(requestedId);
    if (direct) {
      return {
        requestedId,
        resolvedId: direct.resolvedId,
        conversationId: direct.conversationId,
        created: false,
        resolvedFrom: direct.resolvedFrom,
        provider: this.getConversationProvider(direct.conversation),
        workingDirectory: direct.conversation.workingDirectory,
        workspace: direct.conversation.workspace,
      };
    }

    if (requestedId.length === 8) {
      const full = await sessionInfoService.resolveSessionId(requestedId);
      if (full && full !== requestedId) {
        const resolved = await this.resolveExistingConversation(full);
        if (resolved) {
          return {
            requestedId,
            resolvedId: full,
            conversationId: resolved.conversationId,
            created: false,
            resolvedFrom: 'sessionPrefix',
            provider: this.getConversationProvider(resolved.conversation),
            workingDirectory: resolved.conversation.workingDirectory,
            workspace: resolved.conversation.workspace,
          };
        }
      }
    }

    throw new LatticeError(
      'CONVERSATION_NOT_FOUND',
      `Session ${requestedId} not found`,
      404,
    );
  }

  private async resolveExistingConversation(id: string): Promise<ExistingConversationResolution | null> {
    const { conversationService, sessionInfoService } = this.deps;

    const asConversation = conversationService.getConversation(id);
    if (asConversation) {
      return {
        conversationId: asConversation.conversationId,
        conversation: asConversation,
        resolvedFrom: 'conversationId',
        resolvedId: id,
      };
    }

    const sessionInfo = sessionInfoService.getSessionInfoSync(id) as LegacySessionInfo | null;
    const linkedConversationId = sessionInfo?.conversation_id?.trim();
    if (linkedConversationId && linkedConversationId.startsWith('conv-')) {
      const linked = conversationService.getConversation(linkedConversationId);
      if (linked) {
        return {
          conversationId: linked.conversationId,
          conversation: linked,
          resolvedFrom: 'sessionInfoLink',
          resolvedId: id,
        };
      }
    }

    const byProvider = conversationService.getConversationByProviderSession(id);
    if (byProvider) {
      return {
        conversationId: byProvider.conversation.conversationId,
        conversation: byProvider.conversation,
        resolvedFrom: 'providerSessionId',
        resolvedId: id,
      };
    }

    return null;
  }

  private getConversationProvider(conversation: Conversation): Provider | null {
    return (conversation.latestProvider || conversation.segments.at(-1)?.provider || null) as Provider | null;
  }
}
