/**
 * useRenderOrderDetector — detects when the visual DOM order of messages
 * diverges from the expected data order.
 *
 * The MessageList uses flex-col-reverse: items are rendered in reversed DOM
 * order but displayed bottom-to-top. A rendering glitch can cause a message
 * to briefly appear at the wrong visual position even when the data array
 * is correctly ordered.
 *
 * This hook reads `[data-message-id]` elements from the DOM after each render
 * and compares their order against the expected data order. When a mismatch
 * is detected, it classifies the root cause:
 *
 * - **rendering_glitch**: Data order is correct (seqs monotonic) but DOM
 *   order diverges. Caused by flex-col-reverse + React reconciliation.
 * - **data_ordering_bug**: The data itself is out of order (seqs not
 *   monotonic). A bug in the event pipeline or reducer.
 *
 * Telemetry includes the recent reducer action trace so we can see exactly
 * what sequence of events/resets/prepends led to the current state.
 */

import { useEffect, useRef } from 'react';
import { sendClientTelemetry } from '../services/client-telemetry.js';

interface ActionTraceEntry {
  action: string;
  ts: number;
  detail?: string;
}

interface RenderOrderDetectorOptions {
  conversationId: string | null;
  /** Expected message IDs in display order (oldest first). */
  expectedOrder: string[];
  /** Ref to the scroll container that holds [data-message-id] elements. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  isStreaming?: boolean;
  /** Recent reducer actions — included in telemetry for causal tracing. */
  actionTrace?: ActionTraceEntry[];
}

const COOLDOWN_MS = 10_000;

/**
 * Extract a numeric ordering key from a render item ID.
 * - `h-<seq>` → seq number (event-based items)
 * - `group-<timestamp>` → timestamp (collapsed tool groups)
 * Returns null if the ID doesn't match either pattern.
 */
function extractOrderingKey(id: string): { kind: 'seq'; value: number } | { kind: 'timestamp'; value: number } | null {
  const seqMatch = id.match(/^h-(\d+)$/);
  if (seqMatch) return { kind: 'seq', value: Number(seqMatch[1]) };

  const groupMatch = id.match(/^group-(\d+)$/);
  if (groupMatch) return { kind: 'timestamp', value: Number(groupMatch[1]) };

  return null;
}

/**
 * Check if a list of IDs has monotonically non-decreasing ordering keys.
 * Returns the first violation (if any) with the index and the two IDs involved.
 */
function findDataOrderingViolation(ids: string[]): {
  index: number;
  prevId: string;
  prevKey: number;
  currId: string;
  currKey: number;
} | null {
  let lastKey = -Infinity;
  let lastId = '';

  for (let i = 0; i < ids.length; i++) {
    const parsed = extractOrderingKey(ids[i]);
    if (!parsed) continue; // skip unparseable IDs

    if (parsed.value < lastKey) {
      return {
        index: i,
        prevId: lastId,
        prevKey: lastKey,
        currId: ids[i],
        currKey: parsed.value,
      };
    }
    lastKey = parsed.value;
    lastId = ids[i];
  }

  return null;
}

export function useRenderOrderDetector({
  conversationId,
  expectedOrder,
  containerRef,
  isStreaming,
  actionTrace,
}: RenderOrderDetectorOptions): void {
  const lastReportRef = useRef<{ sessionId: string; ts: number } | null>(null);

  useEffect(() => {
    if (!conversationId || expectedOrder.length < 2 || !containerRef.current) return;

    // Read DOM order of message elements.
    // flex-col-reverse means DOM order is reversed from visual order:
    // first child in DOM = visually at the bottom (newest).
    const elements = containerRef.current.querySelectorAll<HTMLElement>('[data-message-id]');
    if (elements.length < 2) return;

    // DOM order is reversed (first = newest), so reverse to get visual order (oldest first)
    const domIds: string[] = [];
    for (let i = elements.length - 1; i >= 0; i--) {
      const id = elements[i].getAttribute('data-message-id');
      if (id) domIds.push(id);
    }

    // The expected order may be longer than the visible DOM (block budget truncation).
    // Only compare the IDs that appear in both.
    const domSet = new Set(domIds);
    const expectedVisible = expectedOrder.filter(id => domSet.has(id));

    if (expectedVisible.length < 2 || expectedVisible.length !== domIds.length) return;

    // Find the first divergence point
    let divergenceIndex = -1;
    for (let i = 0; i < expectedVisible.length; i++) {
      if (expectedVisible[i] !== domIds[i]) {
        divergenceIndex = i;
        break;
      }
    }

    if (divergenceIndex === -1) return; // No divergence

    // Cooldown
    const now = Date.now();
    const last = lastReportRef.current;
    if (last && last.sessionId === conversationId && now - last.ts < COOLDOWN_MS) return;
    lastReportRef.current = { sessionId: conversationId, ts: now };

    // ── Root cause classification ──
    // Check if the DATA itself is out of order (seqs not monotonic).
    // If data is ordered but DOM isn't → rendering glitch (flex-col-reverse).
    // If data is NOT ordered → data ordering bug (event pipeline/reducer).
    const dataViolation = findDataOrderingViolation(expectedVisible);
    const rootCause: 'rendering_glitch' | 'data_ordering_bug' = dataViolation
      ? 'data_ordering_bug'
      : 'rendering_glitch';

    // Build diagnostic payload — show a window around the divergence
    const windowStart = Math.max(0, divergenceIndex - 2);
    const windowEnd = Math.min(expectedVisible.length, divergenceIndex + 5);
    const expectedWindow = expectedVisible.slice(windowStart, windowEnd);
    const domWindow = domIds.slice(windowStart, windowEnd);

    // Extract ordering keys for the divergence window (helps see the actual seq/ts values)
    const expectedKeys = expectedWindow.map(id => {
      const key = extractOrderingKey(id);
      return key ? `${key.kind}=${key.value}` : id;
    });
    const domKeys = domWindow.map(id => {
      const key = extractOrderingKey(id);
      return key ? `${key.kind}=${key.value}` : id;
    });

    // Trim action trace to last 30 entries for telemetry payload size
    const recentTrace = actionTrace?.slice(-30);

    const payload = {
      conversationId,
      rootCause,
      divergenceIndex,
      expectedWindow,
      expectedKeys,
      domWindow,
      domKeys,
      totalExpected: expectedVisible.length,
      totalDom: domIds.length,
      isStreaming: !!isStreaming,
      dataViolation: dataViolation ?? undefined,
      actionTrace: recentTrace,
    };

    sendClientTelemetry({
      component: 'RenderOrderDetector',
      event: 'dom-order-mismatch',
      severity: rootCause === 'data_ordering_bug' ? 'error' : 'warn',
      details: payload,
    });

    const label = rootCause === 'data_ordering_bug'
      ? '🔴 DATA ORDERING BUG — events array has wrong seq order'
      : '⚠️ Rendering glitch — data is correct but DOM order diverges';
    console.warn(`[RenderOrderDetector] ${label}`, payload);
  });
}
