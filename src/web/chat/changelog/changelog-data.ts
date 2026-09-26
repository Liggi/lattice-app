export interface ChangelogMilestone {
  version: string;
  date: string;
  title: string;
  summary: string;
  highlights: string[];
}

export interface ChangelogVersionEntry {
  version: string;
  date: string;
  summary: string;
}

export const changelogStart = {
  date: '2026-01-02',
  title: 'Initial Lattice Orchestrator Baseline',
  summary:
    'History starts from the initial baseline commit and tracks all Lattice Orchestrator versions from there forward.',
};

export const changelogMilestones: ChangelogMilestone[] = [
  {
    version: 'v1.0.0',
    date: '2026-02-22',
    title: '1.0 Launch Hardening',
    summary:
      'Stability and platform-control release that finalized proxy-first AI routing and tightened unified session reliability.',
    highlights: [
      'Centralized Anthropic routing with proxy/BYOK fallback selection.',
      'Fixed pending-session redirect loops and stale-active reconciliation edges.',
      'Added provider-switch divider guards and launch-mode settings controls.',
    ],
  },
  {
    version: 'v0.13.0',
    date: '2026-02-21',
    title: 'Codex Next Steps + Branch Reliability',
    summary:
      'Expanded Codex parity and branch correctness while adding stronger release validation coverage.',
    highlights: [
      'Added NEXT_STEPS proposal flow support for Codex sessions.',
      'Fixed branch history carryover and branch-lineage persistence regressions.',
      'Introduced Playwright preflight E2E infrastructure for regression gates.',
    ],
  },
  {
    version: 'v0.12.1',
    date: '2026-02-19',
    title: 'Unified Sidebar + Branching Fixes',
    summary:
      'Focused bugfix release for conversation visibility and branch context consistency.',
    highlights: [
      'Fixed unified-created sessions not appearing in the sidebar.',
      'Resolved branching context loss and shared-message resolution edge cases.',
      'Removed walkthrough UI runtime path and deprecated the backend surface.',
    ],
  },
  {
    version: 'v0.11.23',
    date: '2026-02-16',
    title: 'Queue Session + Mobile Controls',
    summary:
      'Large integration pass across queueing, mobile controls, and provider-auth workflows.',
    highlights: [
      'Unified queue-session launches under the createConversation API path.',
      'Added mobile pause/resume controls and header state polish.',
      'Added Codex integration scaffolding and in-workspace provider auth updates.',
    ],
  },
  {
    version: 'v0.11.0',
    date: '2026-02-12',
    title: 'Unified Conversation Foundation',
    summary:
      'Major architecture cutover from legacy session routes to unified conversation flows.',
    highlights: [
      'Added unified conversation backend routes and session controls.',
      'Wired unified conversation flows through the chat interface.',
      'Improved mixed-provider attribution and expanded regression test coverage.',
    ],
  },
  {
    version: 'v0.10.0',
    date: '2026-02-07',
    title: 'Next Steps + Codex Daemon Mode',
    summary:
      'Feature release centered on guided follow-up flows and Codex runtime support.',
    highlights: [
      'Added Next Steps proposal generation and UI rendering.',
      'Added daemon-mode support for Codex process execution.',
      'Improved test isolation and singleton hygiene safeguards.',
    ],
  },
  {
    version: 'v0.8.10',
    date: '2026-02-05',
    title: 'Review UX Stabilization',
    summary:
      'Reliability pass for review surfaces, sidebar behavior, and interaction polish.',
    highlights: [
      'Added missing ReviewContext provider and stabilized review rendering paths.',
      'Improved sidebar behavior for hidden/retry edge cases.',
      'Cleaned dead tests and resolved failing test paths.',
    ],
  },
  {
    version: 'v0.7.0',
    date: '2026-01-28',
    title: 'Lattice Orchestrator Identity Baseline',
    summary:
      'Identity and UX baseline that established the modern Lattice direction.',
    highlights: [
      'Set Lattice Orchestrator naming and visual baseline.',
      'Added migration and onboarding support for existing environments.',
      'Laid groundwork for recommendation and plugin-era improvements.',
    ],
  },
  {
    version: 'v0.1.1',
    date: '2026-01-09',
    title: 'First Versioned Lattice Release',
    summary:
      'Initial versioned release cycle focused on packaging, runtime detection, and session stability.',
    highlights: [
      'Added daemon/direct mode auto-detection for fresh installs.',
      'Improved packaging/install behavior for CLI usage.',
      'Stabilized early SSE and insights update behavior.',
    ],
  },
];

export const changelogVersionLedger: ChangelogVersionEntry[] = [
  { version: 'v1.0.0', date: '2026-02-22', summary: 'Partner plan, proxy-first routing, settings lockdown; Add @types/semver' },
  { version: 'v0.13.0', date: '2026-02-21', summary: 'Fix archived filter bypass from queryParser boolean coercion; Recommendation batch: CLAUDE.md guardrails and regression tests' },
  { version: 'v0.12.1', date: '2026-02-19', summary: 'Remove walkthrough UI, mark backend deprecated; Fix branching context loss and shared message resolution' },
  { version: 'v0.12.0', date: '2026-02-19', summary: 'Include API endpoints in queue session prompt so agents can check off notes and recommendations; Align queue-session test with updated dev-note prompt format' },
  { version: 'v0.11.23', date: '2026-02-16', summary: 'Add Codex integration scaffolding and credential injection; Add deploy, release, and diagnostic skill definitions' },
  { version: 'v0.11.22', date: '2026-02-15', summary: 'Guard against empty hydration wipes; Add Claude OAuth PKCE login flow' },
  { version: 'v0.11.16', date: '2026-02-15', summary: 'Remove Codex credential export from setup transfer' },
  { version: 'v0.11.15', date: '2026-02-15', summary: 'Add in-workspace provider auth for Claude and Codex' },
  { version: 'v0.11.13', date: '2026-02-14', summary: 'Refine tooltips and permission labels; Update hygiene and archived defaults' },
  { version: 'v0.11.12', date: '2026-02-14', summary: 'Version bump and maintenance updates' },
  { version: 'v0.11.11', date: '2026-02-14', summary: 'Version bump and maintenance updates' },
  { version: 'v0.11.10', date: '2026-02-14', summary: 'Version bump and maintenance updates' },
  { version: 'v0.11.8', date: '2026-02-14', summary: 'Version bump and maintenance updates' },
  { version: 'v0.11.7', date: '2026-02-14', summary: 'Rollover codex thread after context-window exhaustion; Finalize cloud setup export and session stability fixes' },
  { version: 'v0.11.6', date: '2026-02-13', summary: 'Make default model configurable' },
  { version: 'v0.11.5', date: '2026-02-13', summary: 'Preserve sidebar active state during codex status lag; Add codex sidebar active-state regression coverage' },
  { version: 'v0.11.4', date: '2026-02-13', summary: 'Default new sessions to unarchived' },
  { version: 'v0.11.3', date: '2026-02-13', summary: 'Remove legacy empty sections + fix unified conv insights lookup; Resolve conv-* IDs at data access layer for insights lookups' },
  { version: 'v0.11.2', date: '2026-02-12', summary: 'AskUserQuestion UI: resolve conv-* IDs for pending questions + preserve is_error' },
  { version: 'v0.11.1', date: '2026-02-12', summary: 'Split conversation details hydration helpers; Fix spam: single owner + suppress when user is watching' },
  { version: 'v0.11.0', date: '2026-02-12', summary: 'Expand unified conversation coverage and tooling; Fix singleton mock timing and stale test assertions' },
  { version: 'v0.10.1', date: '2026-02-08', summary: 'Add artifacts explorer, design system, and session org modes prototypes; Add message extraction block composition and spawn tools response tests' },
  { version: 'v0.10.0', date: '2026-02-07', summary: 'Improve test isolation and add hygiene checks; Expand singleton hygiene check coverage' },
  { version: 'v0.8.8', date: '2026-02-02', summary: 'Improve debugging for permission hangs and log export; Dynamic plugin loading from config' },
  { version: 'v0.8.10', date: '2026-02-05', summary: 'Fix all test failures and remove dead tests; Remove duplicate sidebar toggle button' },
  { version: 'v0.8.6', date: '2026-01-29', summary: 'Version bump and maintenance updates' },
  { version: 'v0.8.5', date: '2026-01-29', summary: 'Fix MCP server name mismatch in runtime configuration' },
  { version: 'v0.8.4', date: '2026-01-29', summary: 'Fix RecommendationsCard to match prototype exactly; Capture projectPath when accepting recommendations' },
  { version: 'v0.8.1', date: '2026-01-29', summary: 'Version bump and maintenance updates' },
  { version: 'v0.8.0', date: '2026-01-29', summary: 'Migrate to target-based schema; Update UI to minimal card style' },
  { version: 'v0.7.2', date: '2026-01-28', summary: 'Improve tab title to show session mission/purpose' },
  { version: 'v0.7.1', date: '2026-01-28', summary: 'Version bump and maintenance updates' },
  { version: 'v0.7.0', date: '2026-01-28', summary: 'Apply font-display across UI components; Establish Lattice Orchestrator project naming baseline' },
  { version: 'v0.5.0', date: '2026-01-25', summary: 'Fix integration tests and add stdin timing test; Add DB fast path for archived sessions + responsive header buttons' },
  { version: 'v0.2.10', date: '2026-01-22', summary: 'Add copy button and show actions on mobile without hover; Preserve messageIds when replacing optimistic messages' },
  { version: 'v0.2.9', date: '2026-01-21', summary: 'Add prototype scaffolding script' },
  { version: 'v0.2.8', date: '2026-01-21', summary: 'Add typed session marks with turn context capture' },
  { version: 'v0.2.7', date: '2026-01-21', summary: 'Simplify banner generation with randomized style seeds; Add banner generation gallery endpoint for style testing' },
  { version: 'v0.2.6', date: '2026-01-21', summary: 'Type-ahead message queue with optimistic display; Enable send button during active sessions' },
  { version: 'v0.2.5', date: '2026-01-18', summary: 'Fix ASK mode being converted to YOLO in frontend' },
  { version: 'v0.2.4', date: '2026-01-18', summary: 'Enable ASK mode permission prompts on resume operations' },
  { version: 'v0.2.3', date: '2026-01-18', summary: 'Fix working directory resolution for paths containing hyphens' },
  { version: 'v0.2.2', date: '2026-01-18', summary: 'Fix resume crash when ASK mode used without MCP config' },
  { version: 'v0.2.1', date: '2026-01-18', summary: 'Always use CLI invocation directory as default working directory' },
  { version: 'v0.2.0', date: '2026-01-18', summary: 'Version bump and maintenance updates' },
  { version: 'v0.1.15', date: '2026-01-18', summary: "Add MCP permission prompt tool for 'default' permission mode" },
  { version: 'v0.1.14', date: '2026-01-18', summary: 'Use CLI invocation directory as default working directory' },
  { version: 'v0.1.13', date: '2026-01-18', summary: 'Fix permission mode handling and turn capture JSON parsing' },
  { version: 'v0.1.12', date: '2026-01-18', summary: 'Fix loading skeleton to match current SessionCard banner layout; Improve session review with git-aware recommendations' },
  { version: 'v0.1.11', date: '2026-01-12', summary: 'Retry identity image generation on patch if mission now exists; Fix sessions briefly appearing active before moving to archive' },
  { version: 'v0.1.10', date: '2026-01-12', summary: 'Fix spawn-helper permissions for npx installs on macOS' },
  { version: 'v0.1.9', date: '2026-01-12', summary: 'Fix stale insights and improve active session detection; Fix repeated input focus, add limitations to README' },
  { version: 'v0.1.8', date: '2026-01-11', summary: 'Add feedback widget, update banner, and UI prototypes' },
  { version: 'v0.1.7', date: '2026-01-11', summary: 'Add V9 accumulative fields to database layer; Add heartbeat timeout to detect stale connections' },
  { version: 'v0.1.6', date: '2026-01-09', summary: 'Handle both npm and pnpm paths for spawn-helper chmod' },
  { version: 'v0.1.5', date: '2026-01-09', summary: 'Default new sessions to archived, unarchive when started from Lattice' },
  { version: 'v0.1.4', date: '2026-01-09', summary: 'Make dist/server.js executable in postinstall' },
  { version: 'v0.1.3', date: '2026-01-09', summary: 'Misc UI polish and fixes; Rebrand to Lattice + misc polish' },
  { version: 'v0.1.2', date: '2026-01-09', summary: 'Improve error message when Claude CLI is not installed' },
  { version: 'v0.1.1', date: '2026-01-09', summary: 'Add bundle analysis files to gitignore; Auto-detect daemon vs direct mode for fresh installs' },
];
