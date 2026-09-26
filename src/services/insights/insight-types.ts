/**
 * Canonical insight-domain types.
 */

// All LLM-costed operations across insights + related analysis flows
export type LLMOperationType =
  | 'GENERATE'
  | 'PATCH'
  | 'REFRESH'
  | 'QUICK_CHECK'
  | 'MERGE_DECISION'
  | 'FAST_PATCH'
  | 'METADATA_EVAL'
  | 'CURRENT_WORK'
  | 'THREAD_TAG'
  | 'THREAD_REFLECT'
  | 'SESSION_REVIEW'
  | 'WALKTHROUGH_GEN'
  | 'WALKTHROUGH_SCOPE'
  | 'TURN_CAPTURE'
  | 'PERMISSION_PATTERNS'
  | 'SESSION_SUMMARY'
  | 'COORDINATOR_FAST_REPLY'
  | 'WORKER_ACTIVITY'
  | 'WORKER_REPORT_SUMMARY'
  | 'PROJECT_NAME'
  // Non-Anthropic spenders, added 2026-08-28. These billed real money for
  // months while writing nothing here, which is why every cost figure Lattice
  // produced before today was Anthropic-only and read like the whole bill.
  | 'VOICE_ACT'
  | 'GEMINI_CONSULT'
  | 'GEMINI_IMAGE'
  | 'AMBIENT_SCAN';

// Canonical trigger vocabulary
export type InsightTrigger =
  | 'file_change'
  | 'initial'
  | 'user_message'
  | 'completion'
  | 'tool_use'
  | 'scheduled'
  | 'manual'
  | 'missing_fields'
  | 'cold_start'
  | 'stale_refresh'
  | 'api_request'
  | 'pulse'
  | 'background_stale_refresh';
