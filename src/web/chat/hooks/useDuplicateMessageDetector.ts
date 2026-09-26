/**
 * useDuplicateMessageDetector — detects when the rendered messages array
 * contains duplicate or misordered entries and ships a diagnostic telemetry event.
 *
 * Detection strategies:
 * 1. Same messageId appearing more than once (event-level duplication)
 * 2. Consecutive assistant messages with identical text content
 *    (rendering-level duplication from different events)
 * 3. User message appearing after an assistant message with an earlier timestamp
 *    (ordering anomaly — e.g., user message rendered below the response it prompted)
 *
 * When triggered, captures:
 * - Which messages are duplicated/misordered (ids, content preview)
 * - The reducer action trace (last N actions leading to this state)
 * - Connection state and session metadata
 */

import { useEffect, useRef } from 'react';
import type { ActionTraceEntry } from '@liggi/agent-ui-harness/client';
import type { ChatMessage } from '../types/index.js';
import { sendClientTelemetry } from '../services/client-telemetry.js';

interface DuplicateDetectorOptions {
  conversationId: string | null;
  messages: ChatMessage[];
  actionTrace: ActionTraceEntry[];
  connected: boolean;
  status: string;
}

/** Debounce: don't fire more than once per this window for the same session. */
const COOLDOWN_MS = 30_000;

function getTextPreview(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content.slice(0, 120);
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        return (b.text as string).slice(0, 120);
      }
    }
  }
  return '[non-text]';
}

function getFullText(msg: ChatMessage): string | null {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        texts.push(b.text as string);
      }
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

export function useDuplicateMessageDetector({
  conversationId,
  messages,
  actionTrace,
  connected,
  status,
}: DuplicateDetectorOptions): void {
  const lastReportRef = useRef<{ sessionId: string; ts: number } | null>(null);

  useEffect(() => {
    if (!conversationId || messages.length < 2) return;

    // Strategy 1: Same messageId appearing more than once
    const idCounts = new Map<string, number>();
    const duplicateIds: Array<{ id: string; count: number; preview: string }> = [];

    for (const msg of messages) {
      const id = msg.messageId || msg.id;
      const prev = idCounts.get(id) ?? 0;
      idCounts.set(id, prev + 1);
      if (prev + 1 === 2) {
        duplicateIds.push({ id, count: 2, preview: getTextPreview(msg) });
      } else if (prev + 1 > 2) {
        const existing = duplicateIds.find(d => d.id === id);
        if (existing) existing.count = prev + 1;
      }
    }

    // Strategy 2: Consecutive assistant messages with identical text
    const consecutiveDupes: Array<{ index: number; id: string; preview: string }> = [];
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1];
      const curr = messages[i];
      if (prev.type === 'assistant' && curr.type === 'assistant') {
        const prevText = getFullText(prev);
        const currText = getFullText(curr);
        if (prevText && currText && prevText === currText && prevText.length > 20) {
          consecutiveDupes.push({
            index: i,
            id: curr.messageId || curr.id,
            preview: currText.slice(0, 120),
          });
        }
      }
    }

    // Strategy 3: User message following an assistant message with an earlier timestamp
    // (ordering anomaly — user's prompt rendered after the response it triggered).
    //
    // Scoped to user messages that carry text. Tool results are user-ROLE
    // messages too, and they legitimately sit after an assistant message whose
    // timestamp postdates them — the assistant message is stamped when it
    // finishes streaming, while the tool results it triggered were recorded
    // mid-stream. Before this guard, every dense agentic conversation fired
    // this warning (plus a telemetry event) on each load: measured 2026-08-28,
    // nine "anomalies" on one conversation, all `[non-text]` tool results.
    const orderingAnomalies: Array<{ index: number; userId: string; assistantId: string; userTs: string; assistantTs: string; userPreview: string }> = [];
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1];
      const curr = messages[i];
      if (prev.type === 'assistant' && curr.type === 'user' && getFullText(curr) !== null) {
        const prevTs = prev.timestamp ? new Date(prev.timestamp).getTime() : 0;
        const currTs = curr.timestamp ? new Date(curr.timestamp).getTime() : 0;
        // User message has an earlier timestamp than the preceding assistant message
        if (currTs > 0 && prevTs > 0 && currTs < prevTs) {
          orderingAnomalies.push({
            index: i,
            userId: curr.messageId || curr.id,
            assistantId: prev.messageId || prev.id,
            userTs: curr.timestamp || '',
            assistantTs: prev.timestamp || '',
            userPreview: getTextPreview(curr),
          });
        }
      }
    }

    if (duplicateIds.length === 0 && consecutiveDupes.length === 0 && orderingAnomalies.length === 0) return;

    // Cooldown check — don't spam telemetry for the same session
    const now = Date.now();
    const last = lastReportRef.current;
    if (last && last.sessionId === conversationId && now - last.ts < COOLDOWN_MS) return;
    lastReportRef.current = { sessionId: conversationId, ts: now };

    // Build diagnostic payload
    const payload = {
      conversationId,
      duplicateIds,
      consecutiveDupes,
      orderingAnomalies,
      messageCount: messages.length,
      connected,
      status,
      // Trim action trace to last 30 entries and format for readability
      actionTrace: actionTrace.slice(-30).map(e => ({
        action: e.action,
        ts: new Date(e.ts).toISOString(),
        detail: e.detail,
      })),
    };

    const eventName = orderingAnomalies.length > 0 && duplicateIds.length === 0 && consecutiveDupes.length === 0
      ? 'ordering-anomaly'
      : orderingAnomalies.length > 0
        ? 'duplicate-and-ordering-anomaly'
        : 'duplicate-detected';

    sendClientTelemetry({
      component: 'DuplicateMessageDetector',
      event: eventName,
      severity: 'warn',
      details: payload,
    });

    // Also log to console for immediate visibility during development
    const label = orderingAnomalies.length > 0 ? 'Message ordering anomaly' : 'Duplicate messages';
    console.warn(`[DuplicateMessageDetector] ${label} detected`, payload);
  }, [conversationId, messages, actionTrace, connected, status]);
}
