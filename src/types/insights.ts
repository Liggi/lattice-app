// ============================================================
// Session Insights Types (Canonical Source)
// ============================================================
// All insight-related types consolidated here. Do NOT duplicate
// these in service files or frontend - import from @/types instead.
//
// Simplified 2026-01-31: Removed deprecated V8/V9 fields that were
// computed but never displayed. See git history for old types.

/** Todo item extracted from Claude's TodoWrite tool calls */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/** Identity & Context - What is this session about? */
export interface SessionContext {
  project: string;                     // Codebase/repo name
  area: string | null;                 // Component/module/domain (optional)
  mission: string;                     // The overarching goal
  scope: 'minor' | 'feature' | 'major'; // How big is this?
}

/** Tags for categorization */
export interface SessionTags {
  /** Session difficulty indicator - the only tag displayed in UI */
  complexity: 'routine' | 'tricky' | 'gnarly';
}

import type { SessionCategorySet } from './session-categories.js';

/** Session insights as stored and returned by API */
export interface SessionInsights {
  sessionId: string;

  // Rich context (from initial LLM generation)
  context: SessionContext | null;

  // Evocative free-text theme (e.g., "bug-swatting", "rabbit-holing") —
  // display flavor only; the closed-enum `categories` drives iconography
  theme: string | null;

  // Closed-enum work-type classification (primary + up to 2 secondaries)
  categories?: SessionCategorySet | null;

  // Tags for categorization
  tags: SessionTags | null;

  // Evolving purpose - what this session has become (updated on pivots)
  // Distinct from context.mission which is frozen at session start
  purpose?: string;

  // Timestamp when insights were computed (from cache)
  computedAt?: string;

  // Timestamp when insights were last patched (event-driven system)
  patchedAt?: string;
}
