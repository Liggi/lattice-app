// ============================================================
// Session Category Taxonomy (Canonical Source)
// ============================================================
// The closed nine-category grammar for classifying what kind of work a
// session is. Validated 2026-08-08 against an 80-session Opus 5 judge run:
// every category earned its keep as a primary, and 84% of sessions carry
// 2-3 genuine threads — hence primary + secondary, not a single label.
//
// This file is imported by both server (insights extraction prompt,
// persistence) and web (card iconography), so it must stay free of
// UI dependencies. Icons/colors live in
// src/web/chat/components/shared/session-category-visuals.ts.

export const SESSION_CATEGORIES = [
  'exploration',
  'research',
  'investigation',
  'design',
  'implementation',
  'debugging',
  'testing',
  'synthesis',
  'operations',
] as const;

export type SessionCategory = (typeof SESSION_CATEGORIES)[number];

/** Primary thread of the session plus up to two substantial side threads. */
export interface SessionCategorySet {
  primary: SessionCategory;
  secondary: SessionCategory[];
}

/**
 * One-line definitions, shared verbatim between the extraction prompt and
 * tooltips so the model and the human learn the same vocabulary.
 */
export const SESSION_CATEGORY_DEFINITIONS: Record<SessionCategory, string> = {
  exploration: 'Open-ended poking at a space to see what’s there — "what if", prototypes, playing with an idea',
  research: 'Gathering existing knowledge — reading docs/code/data/history to learn something already known somewhere',
  investigation: 'Establishing what happened or why — diagnosis of a specific question with a findable answer',
  design: 'Deciding what to build and how — architecture, UX shape, plans, weighing approaches',
  implementation: 'Writing or changing code/artifacts to build something decided',
  debugging: 'Making a specific broken thing work again',
  testing: 'Evals, verification runs, benchmarks — checking whether something works or holds',
  synthesis: 'Producing understanding for humans — writeups, reviews, retros, documentation, explaining',
  operations: 'Running the machinery — deploys, config, migrations, publishing, housekeeping, coordination',
};

/** Friendly gerund labels for tooltips and filters ("Exploring", not "exploration"). */
export const SESSION_CATEGORY_LABELS: Record<SessionCategory, string> = {
  exploration: 'Exploring',
  research: 'Researching',
  investigation: 'Investigating',
  design: 'Designing',
  implementation: 'Building',
  debugging: 'Debugging',
  testing: 'Testing',
  synthesis: 'Writing up',
  operations: 'Ops',
};

export function isSessionCategory(value: unknown): value is SessionCategory {
  return typeof value === 'string' && (SESSION_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Legacy fallback: maps the historical free-text `theme` vocabulary onto the
 * closed set, so sessions classified before categories existed still get an
 * icon. New sessions get `categories` directly from extraction and never
 * consult this table.
 */
export const SESSION_THEME_CATEGORY: Record<string, SessionCategory> = {
  // Exploration
  exploring: 'exploration',
  searching: 'exploration',
  prototyping: 'exploration',
  experimenting: 'exploration',
  navigating: 'exploration',
  'soul-searching': 'exploration',

  // Research
  researching: 'research',
  mining: 'research',
  retrieving: 'research',
  recalling: 'research',
  evaluating: 'research',
  learning: 'research',

  // Investigation
  investigating: 'investigation',
  triaging: 'investigation',
  analyzing: 'investigation',
  auditing: 'investigation',

  // Design
  designing: 'design',
  planning: 'design',
  strategizing: 'design',
  scoping: 'design',
  architecting: 'design',

  // Implementation
  building: 'implementation',
  refactoring: 'implementation',
  polishing: 'implementation',
  integrating: 'implementation',
  upgrading: 'implementation',
  updating: 'implementation',
  importing: 'implementation',
  visualizing: 'implementation',
  refining: 'implementation',
  optimizing: 'implementation',
  bootstrapping: 'implementation',
  iterating: 'implementation',
  tuning: 'implementation',
  automating: 'implementation',
  connecting: 'implementation',
  enabling: 'implementation',
  packaging: 'implementation',

  // Debugging
  firefighting: 'debugging',
  debugging: 'debugging',
  troubleshooting: 'debugging',
  untangling: 'debugging',
  fixing: 'debugging',
  correcting: 'debugging',

  // Testing
  testing: 'testing',
  verifying: 'testing',
  verification: 'testing',
  calibrating: 'testing',
  validating: 'testing',
  benchmarking: 'testing',
  checking: 'testing',
  hardening: 'testing',

  // Synthesis
  documenting: 'synthesis',
  explaining: 'synthesis',
  reviewing: 'synthesis',
  reflecting: 'synthesis',
  retrospecting: 'synthesis',
  synthesizing: 'synthesis',
  writing: 'synthesis',
  teaching: 'synthesis',
  reporting: 'synthesis',
  consolidating: 'synthesis',

  // Operations
  deploying: 'operations',
  configuring: 'operations',
  shipping: 'operations',
  coordinating: 'operations',
  orchestrating: 'operations',
  monitoring: 'operations',
  maintenance: 'operations',
  organizing: 'operations',
  resuming: 'operations',
  preparing: 'operations',
  processing: 'operations',
  executing: 'operations',
  housekeeping: 'operations',
  maintaining: 'operations',
  routine: 'operations',
  'setting-up': 'operations',
  setup: 'operations',
  acknowledging: 'operations',
  administering: 'operations',
  archiving: 'operations',
  cleaning: 'operations',
  continuing: 'operations',
  engaging: 'operations',
  initiating: 'operations',
  multitasking: 'operations',
  provisioning: 'operations',
  publishing: 'operations',
  releasing: 'operations',
  sanitizing: 'operations',
  starting: 'operations',
  syncing: 'operations',
  waiting: 'operations',
};

/**
 * Resolve a session's categories: prefer the stored closed-enum set, fall
 * back to mapping the legacy free-text theme, else null (no icon shown).
 */
export function resolveSessionCategories(
  categories: SessionCategorySet | null | undefined,
  theme: string | null | undefined,
): SessionCategorySet | null {
  if (categories && isSessionCategory(categories.primary)) {
    return {
      primary: categories.primary,
      secondary: (categories.secondary ?? []).filter(isSessionCategory).slice(0, 2),
    };
  }
  const mapped = theme ? SESSION_THEME_CATEGORY[theme.trim().toLowerCase()] : undefined;
  return mapped ? { primary: mapped, secondary: [] } : null;
}
