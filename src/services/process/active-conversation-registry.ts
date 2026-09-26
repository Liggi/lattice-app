import { EventEmitter } from 'events';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import type { Provider } from '../sessions/conversation-service.js';
import { truncateId } from '@/types/index.js';

// ---------------------------------------------------------------------------
// Types
//
// The registry holds process/segment METADATA for live conversations only.
// It deliberately holds no run-status state machine: status is derived from
// the event log (deriveSessionStatusFromEvents), the single source of truth.
// A parallel status copy here desynced three separate times on 2026-08-28
// alone (follow-up sends, task:notification revivals, bare run:ready wakeup
// revivals) because every code path that starts a turn had to remember to
// poke both stores. Lifecycle *pushes* (session-idle / session-started) are
// still emitted through the registry, but they are driven directly by
// harness events via notifyIdle()/notifyActive() — see
// harness/event-side-effects.ts.
// ---------------------------------------------------------------------------

export type TransitionReason =
  | 'conversation_start'
  | 'resume'
  | 'provider_switch'
  | 'recovery';

export interface ActiveRun {
  streamingId: string;
  runVersion: number;
  startedAt: string;
}

export interface ActiveConversation {
  conversationId: string;
  segment: {
    segmentId: string;
    provider: Provider;
    providerSessionId: string;
    model?: string;
    transitionReason: TransitionReason;
    contextTransfer?: {
      fromSegmentId: string;
      fromProvider: Provider;
      sampledMessageCount: number;
      injectedCharCount: number;
    };
  };
  run: ActiveRun | null;
  workingDirectory: string;
  permissionMode: string;
  traceId?: string;
}

// ---------------------------------------------------------------------------
// Events (same shape CSM emitted, so existing listeners don't change)
// ---------------------------------------------------------------------------

export interface RegistrySessionStartedEvent {
  streamingId: string;
  claudeSessionId: string;
  logicalSessionId?: string;
  runVersion: number;
}

export interface RegistrySessionEndedEvent {
  streamingId: string;
  claudeSessionId: string;
  logicalSessionId?: string;
  runVersion?: number;
}

export interface RegistryRunSupersededEvent {
  /** The old streamingId that was replaced */
  supersededStreamingId: string;
  /** The new streamingId that replaced it */
  newStreamingId: string;
  conversationId: string;
  providerSessionId: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ActiveConversationRegistry extends EventEmitter {
  /** Primary store: conversationId → ActiveConversation */
  private conversations = new Map<string, ActiveConversation>();
  /** Secondary index: streamingId → conversationId */
  private byStreamingId = new Map<string, string>();
  /** Secondary index: providerSessionId → conversationId */
  private byProviderSessionId = new Map<string, string>();
  /** RunVersion counter per conversation key (monotonically increasing) */
  private runVersionByKey = new Map<string, number>();
  /**
   * Last lifecycle push per conversation, so notifyActive/notifyIdle stay
   * edge-triggered: a spawn produces input:sent AND run:ready, and a finished
   * run produces turn:end AND run:end — each pair is one client-visible
   * transition, not two pushes.
   */
  private lastPush = new Map<string, 'active' | 'idle'>();

  private logger: Logger;

  constructor() {
    super();
    this.setMaxListeners(50);
    this.logger = createLogger('ActiveConversationRegistry');
  }

  // -----------------------------------------------------------------------
  // RunVersion allocation
  // -----------------------------------------------------------------------

  allocateRunVersion(conversationId: string): number {
    const next = (this.runVersionByKey.get(conversationId) || 0) + 1;
    this.runVersionByKey.set(conversationId, next);
    return next;
  }

  // -----------------------------------------------------------------------
  // Mutations
  // -----------------------------------------------------------------------

  register(ac: ActiveConversation): void {
    const { conversationId } = ac;

    const existingConversationIdForProvider = this.byProviderSessionId.get(ac.segment.providerSessionId);
    if (existingConversationIdForProvider && existingConversationIdForProvider !== conversationId) {
      const existingForProvider = this.conversations.get(existingConversationIdForProvider);
      // When a canonical conv-* registration arrives, always replace the
      // provisional entry (recovery or CPM fallback). This prevents phantom
      // duplicate entries that never receive idle transitions.
      const isCanonicalReplacement = conversationId.startsWith('conv-')
        && !existingConversationIdForProvider.startsWith('conv-');

      if (isCanonicalReplacement || existingForProvider?.segment.transitionReason === 'recovery') {
        this.removeIndexEntries(existingForProvider!);
        this.conversations.delete(existingConversationIdForProvider);

        this.logger.info('[REGISTRY] Promoted provisional registration to canonical conversation', {
          provisionalConversationId: truncateId(existingConversationIdForProvider),
          conversationId: truncateId(conversationId),
          providerSessionId: truncateId(ac.segment.providerSessionId),
          provisionalStreamingId: existingForProvider?.run ? truncateId(existingForProvider.run.streamingId) : null,
          streamingId: ac.run ? truncateId(ac.run.streamingId) : null,
          reason: isCanonicalReplacement ? 'canonical-replacement' : 'recovery-promotion',
        });
      } else {
        this.logger.warn('[REGISTRY] Re-registering providerSessionId for a different conversation', {
          existingConversationId: truncateId(existingConversationIdForProvider),
          conversationId: truncateId(conversationId),
          providerSessionId: truncateId(ac.segment.providerSessionId),
          existingTransitionReason: existingForProvider?.segment.transitionReason ?? null,
        });
      }
    }

    // Clean up any stale index entries from a previous registration
    const existing = this.conversations.get(conversationId);
    if (existing) {
      const supersededStreamingId = existing.run?.streamingId;
      const newStreamingId = ac.run?.streamingId;

      this.removeIndexEntries(existing);

      // If the old run had a different streamingId, it's now orphaned —
      // emit so the process lifecycle can kill it.
      if (supersededStreamingId && newStreamingId && supersededStreamingId !== newStreamingId) {
        this.logger.info('[REGISTRY] Run superseded — old process may be orphaned', {
          conversationId: truncateId(conversationId),
          supersededStreamingId: truncateId(supersededStreamingId),
          newStreamingId: truncateId(newStreamingId),
        });
        this.emit('run-superseded', {
          supersededStreamingId,
          newStreamingId,
          conversationId,
          providerSessionId: existing.segment.providerSessionId,
        } satisfies RegistryRunSupersededEvent);
      }
    }

    this.conversations.set(conversationId, ac);
    this.addIndexEntries(ac);

    this.logger.info('[REGISTRY] Registered', {
      conversationId: truncateId(conversationId),
      segmentId: truncateId(ac.segment.segmentId),
      provider: ac.segment.provider,
      providerSessionId: truncateId(ac.segment.providerSessionId),
      streamingId: ac.run ? truncateId(ac.run.streamingId) : null,
      transitionReason: ac.segment.transitionReason,
      totalActive: this.conversations.size,
    });

    if (ac.run) {
      this.lastPush.set(conversationId, 'active');
      this.emit('session-started', {
        streamingId: ac.run.streamingId,
        claudeSessionId: ac.segment.providerSessionId,
        logicalSessionId: conversationId,
        runVersion: ac.run.runVersion,
      } satisfies RegistrySessionStartedEvent);
    } else {
      this.lastPush.delete(conversationId);
    }
  }

  deregister(conversationId: string): ActiveConversation | undefined {
    const ac = this.conversations.get(conversationId);
    if (!ac) return undefined;

    this.removeIndexEntries(ac);
    this.conversations.delete(conversationId);
    this.lastPush.delete(conversationId);

    this.logger.info('[REGISTRY] Deregistered', {
      conversationId: truncateId(conversationId),
      remainingActive: this.conversations.size,
    });

    this.emit('session-ended', {
      streamingId: ac.run?.streamingId ?? '',
      claudeSessionId: ac.segment.providerSessionId,
      logicalSessionId: conversationId,
      runVersion: ac.run?.runVersion,
    } satisfies RegistrySessionEndedEvent);

    return ac;
  }

  /**
   * Deregister by streamingId. Convenience for callers that only have the streamingId.
   */
  deregisterByStreamingId(streamingId: string): ActiveConversation | undefined {
    const ac = this.getByStreamingId(streamingId);
    if (!ac) {
      this.logger.debug('[REGISTRY] Attempted to deregister unknown streamingId', {
        streamingId: truncateId(streamingId),
      });
      return undefined;
    }
    return this.deregister(ac.conversationId);
  }

  /**
   * Replace the active run for a conversation (e.g. on resume with new streamingId).
   * Keeps the segment unchanged.
   */
  updateRun(conversationId: string, run: ActiveRun | null): void {
    const ac = this.conversations.get(conversationId);
    if (!ac) {
      this.logger.warn('[REGISTRY] updateRun called for unknown conversation', {
        conversationId: truncateId(conversationId),
      });
      return;
    }

    // Remove old streamingId index
    if (ac.run?.streamingId) {
      this.byStreamingId.delete(ac.run.streamingId);
    }

    ac.run = run;

    // Add new streamingId index
    if (run?.streamingId) {
      this.byStreamingId.set(run.streamingId, conversationId);
    }
  }

  /**
   * Push "this session finished a turn / its run ended" to SSE listeners.
   * Called from the harness event side effects on turn:end / run:end /
   * run:error — the event log drives the push; the registry only supplies
   * the payload metadata.
   */
  notifyIdle(conversationId: string): void {
    const ac = this.conversations.get(conversationId);
    if (!ac) return;
    if (this.lastPush.get(conversationId) === 'idle') return;
    this.lastPush.set(conversationId, 'idle');
    this.emit('session-idle', {
      streamingId: ac.run?.streamingId ?? '',
      claudeSessionId: ac.segment.providerSessionId,
      logicalSessionId: ac.conversationId,
      runVersion: ac.run?.runVersion,
    });
  }

  /**
   * Push "this session started (or resumed) doing work" to SSE listeners, so
   * clients invalidate any cached idle status. Driven by input:sent /
   * task:notification / run:ready in the harness event side effects.
   */
  notifyActive(conversationId: string): void {
    const ac = this.conversations.get(conversationId);
    if (!ac?.run) return;
    if (this.lastPush.get(conversationId) === 'active') return;
    this.lastPush.set(conversationId, 'active');
    this.emit('session-started', {
      streamingId: ac.run.streamingId,
      claudeSessionId: ac.segment.providerSessionId,
      logicalSessionId: ac.conversationId,
      runVersion: ac.run.runVersion,
    } satisfies RegistrySessionStartedEvent);
  }

  /**
   * Update the segment on an already-registered conversation (e.g. provider switch
   * creates a new segment without deregistering the conversation).
   */
  updateSegment(conversationId: string, segment: ActiveConversation['segment']): void {
    const ac = this.conversations.get(conversationId);
    if (!ac) {
      this.logger.warn('[REGISTRY] updateSegment called for unknown conversation', {
        conversationId: truncateId(conversationId),
      });
      return;
    }

    // Remove old providerSessionId index
    this.byProviderSessionId.delete(ac.segment.providerSessionId);

    ac.segment = segment;

    // Add new providerSessionId index
    this.byProviderSessionId.set(segment.providerSessionId, conversationId);
  }

  // -----------------------------------------------------------------------
  // Lookups
  // -----------------------------------------------------------------------

  get(conversationId: string): ActiveConversation | undefined {
    return this.conversations.get(conversationId);
  }

  getByStreamingId(streamingId: string): ActiveConversation | undefined {
    const conversationId = this.byStreamingId.get(streamingId);
    return conversationId ? this.conversations.get(conversationId) : undefined;
  }

  getByProviderSessionId(providerSessionId: string): ActiveConversation | undefined {
    const conversationId = this.byProviderSessionId.get(providerSessionId);
    return conversationId ? this.conversations.get(conversationId) : undefined;
  }

  has(conversationId: string): boolean {
    return this.conversations.has(conversationId);
  }

  getAll(): ActiveConversation[] {
    return Array.from(this.conversations.values());
  }

  get size(): number {
    return this.conversations.size;
  }

  // -----------------------------------------------------------------------
  // CSM-compatible convenience methods (eases migration)
  // -----------------------------------------------------------------------

  isSessionActive(providerSessionId: string): boolean {
    return this.byProviderSessionId.has(providerSessionId);
  }

  getStreamingIdForSession(providerSessionId: string): string | undefined {
    return this.getByProviderSessionId(providerSessionId)?.run?.streamingId;
  }

  getSessionIdForStreaming(streamingId: string): string | undefined {
    return this.getByStreamingId(streamingId)?.segment.providerSessionId;
  }

  getRunVersionForSession(providerSessionId: string): number | undefined {
    return this.getByProviderSessionId(providerSessionId)?.run?.runVersion;
  }

  getRunVersionForStreamingId(streamingId: string): number | undefined {
    return this.getByStreamingId(streamingId)?.run?.runVersion;
  }

  getActiveProviderSessionIds(): string[] {
    return Array.from(this.byProviderSessionId.keys());
  }

  getActiveStreamingIds(): string[] {
    return Array.from(this.byStreamingId.keys());
  }

  // -----------------------------------------------------------------------
  // Debug / serialization
  // -----------------------------------------------------------------------

  toJSON(conversationId: string): ActiveConversation | null {
    return this.conversations.get(conversationId) ?? null;
  }

  toDebugSummary(): Array<{
    conversationId: string;
    segmentId: string;
    provider: Provider;
    streamingId: string | null;
    transitionReason: TransitionReason;
    runVersion: number | null;
  }> {
    return this.getAll().map(ac => ({
      conversationId: ac.conversationId,
      segmentId: ac.segment.segmentId,
      provider: ac.segment.provider,
      streamingId: ac.run?.streamingId ?? null,
      transitionReason: ac.segment.transitionReason,
      runVersion: ac.run?.runVersion ?? null,
    }));
  }

  getStats(): {
    activeCount: number;
    activeSessions: Array<{
      claudeSessionId: string;
      streamingId: string | null;
      runVersion: number | null;
    }>;
  } {
    return {
      activeCount: this.conversations.size,
      activeSessions: this.getAll().map(ac => ({
        claudeSessionId: ac.segment.providerSessionId,
        streamingId: ac.run?.streamingId ?? null,
        runVersion: ac.run?.runVersion ?? null,
      })),
    };
  }

  clear(): void {
    this.conversations.clear();
    this.byStreamingId.clear();
    this.byProviderSessionId.clear();
    this.runVersionByKey.clear();
    this.lastPush.clear();
  }

  // -----------------------------------------------------------------------
  // Index management
  // -----------------------------------------------------------------------

  private addIndexEntries(ac: ActiveConversation): void {
    if (ac.run?.streamingId) {
      this.byStreamingId.set(ac.run.streamingId, ac.conversationId);
    }
    this.byProviderSessionId.set(ac.segment.providerSessionId, ac.conversationId);
  }

  private removeIndexEntries(ac: ActiveConversation): void {
    if (ac.run?.streamingId) {
      this.byStreamingId.delete(ac.run.streamingId);
    }
    this.byProviderSessionId.delete(ac.segment.providerSessionId);
  }
}
