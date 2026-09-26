/**
 * Default-redacted event summaries (§1.3 DiagnosticEventSummary).
 *
 * The default response excludes raw payloads, message text, tool inputs, and
 * other content — only structural fields, IDs, and lifecycle reasons.
 */

import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import type { DiagnosticEventSummary } from './types.js';

function inferRole(event: SessionEvent): DiagnosticEventSummary['role'] {
  switch (event.type) {
    case 'input:sent':
      return 'user';
    case 'content':
      return 'assistant';
    case 'result':
      return 'tool';
    default:
      return null;
  }
}

function payloadBytes(event: SessionEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event.data ?? null), 'utf8');
  } catch {
    return 0;
  }
}

function lifecycle(event: SessionEvent): DiagnosticEventSummary['lifecycle'] {
  if (event.type !== 'run:end' && event.type !== 'run:error') return undefined;
  const data = event.data as
    | { reason?: string; code?: number | null; signal?: string | null }
    | undefined;
  return {
    reason: data?.reason ?? null,
    exitCode: data?.code ?? null,
    signal: data?.signal ?? null,
  };
}

export function summarizeEvent(
  event: SessionEvent,
  opts: { includeRaw: boolean },
): DiagnosticEventSummary {
  const summary: DiagnosticEventSummary = {
    seq: event.seq,
    type: event.type,
    timestampMs: event.timestamp,
    role: inferRole(event),
    payloadBytes: payloadBytes(event),
  };
  const meta = event.meta as { inferred?: boolean; synthetic?: boolean } | undefined;
  if (meta?.inferred) summary.inferred = true;
  if (meta?.synthetic) summary.synthetic = true;
  const lifecycleData = lifecycle(event);
  if (lifecycleData) summary.lifecycle = lifecycleData;
  if (opts.includeRaw) summary.raw = event.data;
  return summary;
}
