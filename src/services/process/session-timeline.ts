/**
 * SessionTimeline - Unified per-conversation lifecycle observability.
 *
 * Provides a single, chronological timeline of milestones for each conversation,
 * spanning server, client, and daemon events. Designed for live debugging:
 *
 * - "Why did the UI stall for 5 seconds before showing tool blocks?"
 * - "How long between spawn and first client connection?"
 * - "What happened during the session switch?"
 *
 * Unlike ProcessEventLog (per-streaming-id, high-frequency message events) or
 * EventJournal (append-only JSONL on disk), this is keyed by conversationId
 * and captures only significant lifecycle milestones with auto-computed deltas.
 *
 * Any component can stamp a milestone with a single call:
 *   timeline.mark(conversationId, 'server.spawn_completed', { spawnMs: 3095 })
 *
 * For events before conversationId is known (daemon spawn):
 *   timeline.markByStreamingId(streamingId, 'daemon.process_spawned')
 *   // ... later, when conversationId is assigned:
 *   timeline.resolveStreamingId(streamingId, conversationId)
 */

import { createLogger, type Logger } from '../infrastructure/logger.js';

// ============================================================================
// Types
// ============================================================================

export type TimelineSource = 'server' | 'client' | 'daemon';

export interface TimelineMilestone {
  id: number;
  conversationId: string;
  streamingId?: string;
  source: TimelineSource;
  milestone: string;
  timestamp: number;
  deltaFromPrevMs: number | null;
  fields?: Record<string, unknown>;
}

export interface LatencyGap {
  from: string;
  to: string;
  durationMs: number;
}

export interface MarkOptions {
  streamingId?: string;
  source?: TimelineSource;
  fields?: Record<string, unknown>;
  timestamp?: number;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_MILESTONES = 3000;
const MAX_PENDING_PER_STREAMING_ID = 50;
const SLOW_GAP_THRESHOLD_MS = 2000;
const ACTIVE_CONVERSATION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// SessionTimeline
// ============================================================================

export class SessionTimeline {
  private logger: Logger;
  private milestones: TimelineMilestone[] = [];
  private milestoneId = 0;

  // Milestones emitted before conversationId is known, keyed by streamingId
  private pendingByStreamingId: Map<string, TimelineMilestone[]> = new Map();

  // Reverse lookup: streamingId → conversationId (populated by resolveStreamingId)
  private streamingToConversation: Map<string, string> = new Map();

  // Fast per-conversation index: conversationId → milestone IDs
  private conversationIndex: Map<string, number[]> = new Map();

  constructor() {
    this.logger = createLogger('SessionTimeline');
  }

  // ========== Primary API ==========

  /**
   * Record a milestone for a known conversationId.
   */
  mark(conversationId: string, milestone: string, opts?: MarkOptions): void {
    const entry = this.buildMilestone(conversationId, milestone, opts);
    this.pushMilestone(entry);
  }

  /**
   * Record a milestone when only streamingId is available (before conversation creation).
   * If the streamingId has already been resolved, the milestone is filed under the conversation.
   */
  markByStreamingId(streamingId: string, milestone: string, opts?: Omit<MarkOptions, 'streamingId'>): void {
    const resolvedConvId = this.streamingToConversation.get(streamingId);
    if (resolvedConvId) {
      this.mark(resolvedConvId, milestone, { ...opts, streamingId });
      return;
    }

    // Park as pending
    const entry = this.buildMilestone('__pending__', milestone, { ...opts, streamingId });
    let pending = this.pendingByStreamingId.get(streamingId);
    if (!pending) {
      pending = [];
      this.pendingByStreamingId.set(streamingId, pending);
    }
    if (pending.length < MAX_PENDING_PER_STREAMING_ID) {
      pending.push(entry);
    }
  }

  /**
   * Associate a streamingId with a conversationId, adopting any pending milestones.
   * Call this once, right after conversationId is assigned (e.g., after createConversation()).
   */
  resolveStreamingId(streamingId: string, conversationId: string): void {
    this.streamingToConversation.set(streamingId, conversationId);

    const pending = this.pendingByStreamingId.get(streamingId);
    if (!pending || pending.length === 0) return;

    this.pendingByStreamingId.delete(streamingId);

    // Adopt pending milestones into the conversation timeline
    for (const entry of pending) {
      entry.conversationId = conversationId;
      // Recompute delta now that we know the conversation
      entry.deltaFromPrevMs = this.computeDelta(conversationId, entry.timestamp);
      this.pushMilestone(entry);
    }

    this.logger.debug('Resolved streamingId to conversation', {
      streamingId: streamingId.slice(0, 8),
      conversationId: conversationId.slice(0, 12),
      adoptedMilestones: pending.length,
    });
  }

  // ========== Query API ==========

  /**
   * Get all milestones for a conversation, chronological order.
   */
  getTimeline(conversationId: string, limit = 100): TimelineMilestone[] {
    const ids = this.conversationIndex.get(conversationId);
    if (!ids || ids.length === 0) return [];

    const milestones: TimelineMilestone[] = [];
    const targetIds = limit < ids.length ? ids.slice(-limit) : ids;

    for (const id of targetIds) {
      const m = this.milestones.find(m => m.id === id);
      if (m) milestones.push(m);
    }

    return milestones;
  }

  /**
   * Get latency gaps between consecutive milestones.
   */
  getGaps(conversationId: string): LatencyGap[] {
    const timeline = this.getTimeline(conversationId);
    const gaps: LatencyGap[] = [];

    for (let i = 1; i < timeline.length; i++) {
      gaps.push({
        from: timeline[i - 1].milestone,
        to: timeline[i].milestone,
        durationMs: timeline[i].timestamp - timeline[i - 1].timestamp,
      });
    }

    return gaps;
  }

  /**
   * Human-readable formatted timeline with deltas and slow-gap flags.
   */
  getFormattedTimeline(conversationId: string, limit = 100): string[] {
    const timeline = this.getTimeline(conversationId, limit);
    if (timeline.length === 0) return [];

    const baseTime = timeline[0].timestamp;
    const lines: string[] = [];

    for (const m of timeline) {
      const elapsed = m.timestamp - baseTime;
      const mins = Math.floor(elapsed / 60000);
      const secs = Math.floor((elapsed % 60000) / 1000);
      const ms = elapsed % 1000;
      const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;

      let deltaStr: string;
      if (m.deltaFromPrevMs === null) {
        deltaStr = ''.padEnd(22);
      } else {
        const slow = m.deltaFromPrevMs >= SLOW_GAP_THRESHOLD_MS ? '  <- SLOW' : '';
        deltaStr = `+${m.deltaFromPrevMs}ms${slow}`.padEnd(22);
      }

      const fieldsStr = m.fields && Object.keys(m.fields).length > 0
        ? `  ${JSON.stringify(m.fields)}`
        : '';

      lines.push(`[${timeStr}] ${deltaStr} ${m.source.padEnd(7)} ${m.milestone}${fieldsStr}`);
    }

    return lines;
  }

  /**
   * Get conversations with milestones in the last N minutes.
   */
  getActiveConversations(): string[] {
    const cutoff = Date.now() - ACTIVE_CONVERSATION_WINDOW_MS;
    const active = new Set<string>();

    // Walk backwards through milestones for efficiency
    for (let i = this.milestones.length - 1; i >= 0; i--) {
      const m = this.milestones[i];
      if (m.timestamp < cutoff) break;
      if (m.conversationId !== '__pending__') {
        active.add(m.conversationId);
      }
    }

    return Array.from(active);
  }

  /**
   * Get the number of pending (unresolved) milestones across all streaming IDs.
   */
  getPendingCount(): number {
    let count = 0;
    for (const pending of this.pendingByStreamingId.values()) {
      count += pending.length;
    }
    return count;
  }

  // ========== Internal ==========

  private buildMilestone(
    conversationId: string,
    milestone: string,
    opts?: MarkOptions,
  ): TimelineMilestone {
    const timestamp = opts?.timestamp ?? Date.now();
    const delta = conversationId !== '__pending__'
      ? this.computeDelta(conversationId, timestamp)
      : null;

    return {
      id: ++this.milestoneId,
      conversationId,
      streamingId: opts?.streamingId,
      source: opts?.source ?? 'server',
      milestone,
      timestamp,
      deltaFromPrevMs: delta,
      fields: opts?.fields,
    };
  }

  private computeDelta(conversationId: string, timestamp: number): number | null {
    const ids = this.conversationIndex.get(conversationId);
    if (!ids || ids.length === 0) return null;

    // Find the last milestone for this conversation
    const lastId = ids[ids.length - 1];
    const lastMilestone = this.milestones.find(m => m.id === lastId);
    if (!lastMilestone) return null;

    return timestamp - lastMilestone.timestamp;
  }

  private pushMilestone(entry: TimelineMilestone): void {
    // Ring buffer eviction
    if (this.milestones.length >= MAX_MILESTONES) {
      const evicted = this.milestones.shift()!;
      // Clean up conversation index for evicted entry
      const evictedIds = this.conversationIndex.get(evicted.conversationId);
      if (evictedIds) {
        const idx = evictedIds.indexOf(evicted.id);
        if (idx !== -1) evictedIds.splice(idx, 1);
        if (evictedIds.length === 0) {
          this.conversationIndex.delete(evicted.conversationId);
        }
      }
    }

    this.milestones.push(entry);

    // Update conversation index
    if (entry.conversationId !== '__pending__') {
      let ids = this.conversationIndex.get(entry.conversationId);
      if (!ids) {
        ids = [];
        this.conversationIndex.set(entry.conversationId, ids);
      }
      ids.push(entry.id);
    }

    // Log to structured logger
    this.logger.debug('milestone', {
      id: entry.id,
      conversationId: entry.conversationId.slice(0, 12),
      streamingId: entry.streamingId?.slice(0, 8),
      source: entry.source,
      milestone: entry.milestone,
      deltaMs: entry.deltaFromPrevMs,
    });
  }

  /**
   * Clear all state (for testing).
   */
  clear(): void {
    this.milestones = [];
    this.milestoneId = 0;
    this.pendingByStreamingId.clear();
    this.streamingToConversation.clear();
    this.conversationIndex.clear();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: SessionTimeline | null = null;

export function getSessionTimeline(): SessionTimeline {
  if (!instance) {
    instance = new SessionTimeline();
  }
  return instance;
}
