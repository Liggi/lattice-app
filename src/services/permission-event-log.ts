/**
 * PermissionEventLog - Structured event logging for permission flow observability.
 *
 * This provides a clear, queryable log of all permission system decisions:
 * - Permission requests from MCP server
 * - Pattern matching decisions (allowed/denied)
 * - Pattern suggestions (LLM vs heuristic)
 * - Allowlist modifications
 *
 * The log is designed for:
 * 1. Debugging: "Why was this tool auto-approved?" / "What pattern matched?"
 * 2. Monitoring: "How many permissions are being requested?"
 * 3. Pattern analysis: "What patterns would reduce permission prompts?"
 */

import { createLogger, type Logger } from './infrastructure/logger.js';
import { appendJsonlRecord, PERMISSION_LOG_PATH } from './infrastructure/structured-log-files.js';

// ============================================================================
// Types
// ============================================================================

export type PermissionEventType =
  | 'request'           // Permission requested from MCP server
  | 'auto_approved'     // Tool auto-approved by pattern match
  | 'pending'           // Permission awaiting user decision
  | 'approved'          // User approved permission
  | 'denied'            // User denied permission
  | 'pattern_suggest'   // Pattern suggestions generated
  | 'allowlist_add'     // Pattern added to allowlist
  | 'auto_denied';      // Auto mode's classifier blocked a tool call

export type PatternSource =
  | 'global'            // Matched global allowlist
  | 'session';          // Matched session allowlist

export type SuggestionSource =
  | 'llm'               // LLM-generated pattern
  | 'heuristic';        // Heuristic-generated pattern

export interface PermissionEvent {
  // Identity
  id: number;
  timestamp: number;

  // Classification
  eventType: PermissionEventType;

  // Context
  toolName: string;
  toolInput?: Record<string, unknown>;
  streamingId?: string;
  sessionId?: string;
  permissionRequestId?: string;

  // Pattern matching details
  matchedPattern?: string;
  patternSource?: PatternSource;
  suggestedPatterns?: string[];
  suggestionSource?: SuggestionSource;

  // Allowlist modification
  addedPattern?: string;
  allowlistScope?: 'session' | 'global';

  // User decision
  decision?: 'approve' | 'deny';
  denyReason?: string;

  // Timing
  durationMs?: number;
}

// ============================================================================
// Event Log Service
// ============================================================================

export class PermissionEventLog {
  private logger: Logger;
  private events: PermissionEvent[] = [];
  private eventId = 0;
  private maxEvents = 500; // Ring buffer size

  constructor() {
    this.logger = createLogger('PermissionEventLog');
  }

  // ========== Logging Methods ==========

  /**
   * Log a permission request from MCP server
   */
  request(params: {
    toolName: string;
    toolInput?: Record<string, unknown>;
    streamingId?: string;
    sessionId?: string;
    permissionRequestId: string;
  }): void {
    this.addEvent({
      eventType: 'request',
      toolName: params.toolName,
      toolInput: params.toolInput,
      streamingId: params.streamingId,
      sessionId: params.sessionId,
      permissionRequestId: params.permissionRequestId,
    });

    this.logger.info('Permission request', {
      tool: params.toolName,
      streamingId: params.streamingId?.slice(0, 8),
      requestId: params.permissionRequestId.slice(0, 8),
    });
  }

  /**
   * Log auto-approval by pattern match
   */
  autoApproved(params: {
    toolName: string;
    toolInput?: Record<string, unknown>;
    streamingId?: string;
    matchedPattern: string;
    patternSource: PatternSource;
  }): void {
    this.addEvent({
      eventType: 'auto_approved',
      toolName: params.toolName,
      toolInput: params.toolInput,
      streamingId: params.streamingId,
      matchedPattern: params.matchedPattern,
      patternSource: params.patternSource,
    });

    this.logger.info('Permission auto-approved', {
      tool: params.toolName,
      pattern: params.matchedPattern,
      source: params.patternSource,
      streamingId: params.streamingId?.slice(0, 8),
    });
  }

  /**
   * Log pattern suggestions
   */
  patternSuggest(params: {
    toolName: string;
    toolInput?: Record<string, unknown>;
    suggestedPatterns: string[];
    suggestionSource: SuggestionSource;
    durationMs?: number;
  }): void {
    this.addEvent({
      eventType: 'pattern_suggest',
      toolName: params.toolName,
      toolInput: params.toolInput,
      suggestedPatterns: params.suggestedPatterns,
      suggestionSource: params.suggestionSource,
      durationMs: params.durationMs,
    });

    this.logger.debug('Pattern suggestions generated', {
      tool: params.toolName,
      patterns: params.suggestedPatterns,
      source: params.suggestionSource,
      durationMs: params.durationMs,
    });
  }

  /**
   * Log user decision
   */
  decision(params: {
    permissionRequestId: string;
    toolName: string;
    decision: 'approve' | 'deny';
    denyReason?: string;
    streamingId?: string;
  }): void {
    this.addEvent({
      eventType: params.decision === 'approve' ? 'approved' : 'denied',
      toolName: params.toolName,
      permissionRequestId: params.permissionRequestId,
      decision: params.decision,
      denyReason: params.denyReason,
      streamingId: params.streamingId,
    });

    this.logger.info('Permission decision', {
      tool: params.toolName,
      decision: params.decision,
      requestId: params.permissionRequestId.slice(0, 8),
      streamingId: params.streamingId?.slice(0, 8),
    });
  }

  /**
   * Log a tool call auto mode blocked (Claude Code's PermissionDenied hook).
   * `reason` is the classifier's, usually the matched rule in brackets.
   */
  autoDenied(params: {
    toolName: string;
    toolInput?: Record<string, unknown>;
    sessionId?: string;
    reason?: string;
  }): void {
    this.addEvent({
      eventType: 'auto_denied',
      toolName: params.toolName,
      toolInput: params.toolInput,
      sessionId: params.sessionId,
      denyReason: params.reason,
    });

    this.logger.info('Auto mode blocked a tool call', {
      tool: params.toolName,
      reason: params.reason,
      sessionId: params.sessionId?.slice(0, 8),
    });
  }

  /**
   * Log pattern added to allowlist
   */
  allowlistAdd(params: {
    pattern: string;
    scope: 'session' | 'global';
    streamingId?: string;
  }): void {
    this.addEvent({
      eventType: 'allowlist_add',
      toolName: '', // Not applicable for allowlist add
      addedPattern: params.pattern,
      allowlistScope: params.scope,
      streamingId: params.streamingId,
    });

    this.logger.info('Pattern added to allowlist', {
      pattern: params.pattern,
      scope: params.scope,
      streamingId: params.streamingId?.slice(0, 8),
    });
  }

  // ========== Internal ==========

  private addEvent(params: Omit<PermissionEvent, 'id' | 'timestamp'>): void {
    const event: PermissionEvent = {
      id: ++this.eventId,
      timestamp: Date.now(),
      ...params,
    };

    // Ring buffer for in-memory
    if (this.events.length >= this.maxEvents) {
      this.events.shift();
    }
    this.events.push(event);

    // Persist to disk (async, fire-and-forget)
    this.persistEvent(event);
  }

  /**
   * Persist event to JSONL file for debugging
   */
  private persistEvent(event: PermissionEvent): void {
    appendJsonlRecord(PERMISSION_LOG_PATH, {
      ...event,
      timestampIso: new Date(event.timestamp).toISOString(),
    });
  }

  // ========== Query Methods ==========

  /**
   * Get all events (most recent first)
   */
  getAll(limit = 100): PermissionEvent[] {
    return this.events.slice(-limit).reverse();
  }

  /**
   * Get events for a specific streaming session
   */
  getForSession(streamingId: string, limit = 50): PermissionEvent[] {
    return this.events
      .filter(e => e.streamingId === streamingId)
      .slice(-limit)
      .reverse();
  }

  /**
   * Get events for a specific tool
   */
  getForTool(toolName: string, limit = 50): PermissionEvent[] {
    return this.events
      .filter(e => e.toolName === toolName)
      .slice(-limit)
      .reverse();
  }

  /**
   * Get auto-approved events (useful for understanding pattern coverage)
   */
  getAutoApproved(limit = 50): PermissionEvent[] {
    return this.events
      .filter(e => e.eventType === 'auto_approved')
      .slice(-limit)
      .reverse();
  }

  /**
   * Get pending/denied events (useful for identifying missing patterns)
   */
  getManualDecisions(limit = 50): PermissionEvent[] {
    return this.events
      .filter(e => e.eventType === 'approved' || e.eventType === 'denied')
      .slice(-limit)
      .reverse();
  }

  /**
   * Get pattern match statistics
   */
  getPatternStats(): {
    totalRequests: number;
    autoApproved: number;
    manualApproved: number;
    denied: number;
    patternHitRate: number;
    topMatchedPatterns: Array<{ pattern: string; count: number }>;
  } {
    const requests = this.events.filter(e => e.eventType === 'request').length;
    const autoApproved = this.events.filter(e => e.eventType === 'auto_approved').length;
    const approved = this.events.filter(e => e.eventType === 'approved').length;
    const denied = this.events.filter(e => e.eventType === 'denied').length;

    // Count pattern matches
    const patternCounts = new Map<string, number>();
    for (const event of this.events) {
      if (event.eventType === 'auto_approved' && event.matchedPattern) {
        patternCounts.set(
          event.matchedPattern,
          (patternCounts.get(event.matchedPattern) || 0) + 1
        );
      }
    }

    const topPatterns = Array.from(patternCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([pattern, count]) => ({ pattern, count }));

    const total = autoApproved + approved + denied;
    return {
      totalRequests: requests,
      autoApproved,
      manualApproved: approved,
      denied,
      patternHitRate: total > 0 ? autoApproved / total : 0,
      topMatchedPatterns: topPatterns,
    };
  }

  /**
   * Get a human-readable timeline
   */
  getTimeline(limit = 30): string[] {
    const events = this.getAll(limit);
    return events.map(e => {
      const time = new Date(e.timestamp).toISOString().slice(11, 19);
      const duration = e.durationMs ? ` (${e.durationMs}ms)` : '';

      switch (e.eventType) {
        case 'request':
          return `${time} 📋 Request: ${e.toolName}`;
        case 'auto_approved':
          return `${time} ✅ AutoApproved: ${e.toolName} [${e.matchedPattern}] (${e.patternSource})`;
        case 'approved':
          return `${time} 👍 Approved: ${e.toolName}`;
        case 'denied':
          return `${time} 👎 Denied: ${e.toolName}${e.denyReason ? ` - ${e.denyReason}` : ''}`;
        case 'pattern_suggest':
          return `${time} 💡 Suggest: ${e.toolName} → [${e.suggestedPatterns?.join(', ')}]${duration}`;
        case 'allowlist_add':
          return `${time} ➕ Allowlist: ${e.addedPattern} (${e.allowlistScope})`;
        default:
          return `${time} ❓ ${e.eventType}: ${e.toolName}`;
      }
    });
  }

  /**
   * Clear all events (for testing)
   */
  clear(): void {
    this.events = [];
    this.eventId = 0;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: PermissionEventLog | null = null;

export function getPermissionEventLog(): PermissionEventLog {
  if (!instance) {
    instance = new PermissionEventLog();
  }
  return instance;
}
