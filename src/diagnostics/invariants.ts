/**
 * Runtime invariants (§2).
 *
 * Move 1 (additive diagnostics foundation) ships only the
 * `runtime_authority_consensus` invariant. Other invariants are placeholders
 * that report `skipped` until later moves wire up the comparison sources and
 * the specific checks. Each Move that ships will demote the placeholder into
 * a real check, paired with the demotion/deletion that move requires.
 */

import type {
  DiagnosticInvariantResult,
  DiagnosticSeverity,
  DiagnosticSourceSnapshot,
  RuntimeFactSource,
  RuntimeInvariantId,
} from './types.js';

const PLACEHOLDER_IDS: RuntimeInvariantId[] = [
  'single_live_run',
  'daemon_manager_process_consistency',
  'seq_integrity',
  'resume_id_consistency',
  'event_recovery_visibility',
  'stop_semantics',
  'sse_reconnect_no_duplicates',
  'hydration_completion',
  'pending_message_injection',
  'permission_question_visibility',
  'background_task_consensus',
];

export function evaluateInvariants(
  sources: Partial<Record<RuntimeFactSource, DiagnosticSourceSnapshot>>,
  checkedAtMs: number,
): DiagnosticInvariantResult[] {
  const results: DiagnosticInvariantResult[] = [];
  results.push(evaluateRuntimeAuthorityConsensus(sources, checkedAtMs));
  for (const id of PLACEHOLDER_IDS) {
    results.push(placeholder(id, checkedAtMs));
  }
  return results;
}

function placeholder(
  id: RuntimeInvariantId,
  checkedAtMs: number,
): DiagnosticInvariantResult {
  return {
    id,
    severity: 'skipped',
    ok: true,
    checkedAtMs,
    title: titleFor(id),
    summary: 'Not yet implemented — placeholder until later move lands.',
    skippedReason: 'pending_move',
  };
}

function titleFor(id: RuntimeInvariantId): string {
  switch (id) {
    case 'single_live_run':
      return 'At most one live run per conversation';
    case 'daemon_manager_process_consistency':
      return 'Daemon and harness manager agree on process state';
    case 'seq_integrity':
      return 'Event seq numbers are monotonic and gap-free';
    case 'resume_id_consistency':
      return 'Resume identity is consistent across sources';
    case 'event_recovery_visibility':
      return 'Recovery preserves visibility of stored events';
    case 'stop_semantics':
      return 'Stop transitions follow the documented protocol';
    case 'sse_reconnect_no_duplicates':
      return 'SSE delivery is seq-idempotent on reconnect';
    case 'hydration_completion':
      return 'Cold-load hydration completes in bounded time';
    case 'pending_message_injection':
      return 'Pending mid-turn input is consumed before turn:end';
    case 'permission_question_visibility':
      return 'Pending permission/question state matches harness';
    case 'background_task_consensus':
      return 'Background task state matches harness derivation';
    case 'runtime_authority_consensus':
      return 'Runtime authorities agree';
  }
}

/**
 * `runtime_authority_consensus` — primary invariant (§2.1).
 *
 * Move 1 ships the harness_events anchor only. Once additional sources are
 * wired in (Move 4 will add public_status, Move 7 demotes registry, etc.),
 * this function will compare normalized RuntimeFacts across them under the
 * grace windows in §2.1. For the additive foundation, the anchor's presence
 * with no comparison sources passes trivially.
 */
function evaluateRuntimeAuthorityConsensus(
  sources: Partial<Record<RuntimeFactSource, DiagnosticSourceSnapshot>>,
  checkedAtMs: number,
): DiagnosticInvariantResult {
  const anchor = pickAnchor(sources);

  if (!anchor) {
    return {
      id: 'runtime_authority_consensus',
      severity: 'skipped',
      ok: true,
      checkedAtMs,
      title: titleFor('runtime_authority_consensus'),
      summary: 'No anchor source available (no harness/manager/database facts).',
      skippedReason: 'no_anchor',
    };
  }

  return {
    id: 'runtime_authority_consensus',
    severity: 'pass' as DiagnosticSeverity,
    ok: true,
    checkedAtMs,
    title: titleFor('runtime_authority_consensus'),
    summary:
      'No comparison sources yet — Move 1 ships the harness_events anchor only.',
    anchorSource: anchor,
  };
}

function pickAnchor(
  sources: Partial<Record<RuntimeFactSource, DiagnosticSourceSnapshot>>,
): RuntimeFactSource | undefined {
  // §2.1: harness_events first, harness_manager next, database last.
  const order: RuntimeFactSource[] = [
    'harness_events',
    'harness_manager',
    'database',
  ];
  for (const source of order) {
    const snapshot = sources[source];
    if (snapshot?.available && snapshot.facts) return source;
  }
  return undefined;
}
