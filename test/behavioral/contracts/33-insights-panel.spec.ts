/**
 * Insights Panel — Behavioral Tests
 *
 * Tests the insights panel (session history sidebar): mission display,
 * turn timeline rendering, turn expansion, and panel toggle.
 *
 * The insights panel is a Pro feature that shows:
 * - Mission context from computed insights
 * - Turn-by-turn timeline with headlines, tags, and icons
 * - Expandable turn outcomes
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

// -- Test helpers --

async function resetServer() {
  await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
}

async function seedConversation(): Promise<string> {
  const resp = await fetch(`${BASE_URL}/api/test/seed-conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude' }),
  });
  const data = (await resp.json()) as { conversationId: string };
  return data.conversationId;
}

async function injectMessage(sessionId: string, role: string, content: string) {
  await fetch(`${BASE_URL}/api/test/inject-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, role, content }),
  });
}

async function seedInsights(sessionId: string, opts: {
  mission?: string;
  project?: string;
  theme?: string;
}) {
  await fetch(`${BASE_URL}/api/test/seed-insights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      context: {
        project: opts.project ?? 'Test Project',
        area: null,
        mission: opts.mission ?? 'Fix the widget tests',
        scope: 'feature',
      },
      theme: opts.theme ?? 'debugging',
      tags: { complexity: 'routine' },
      purpose: opts.mission ?? 'Fix the widget tests',
    }),
  });
}

async function seedTurns(sessionId: string, turns: Array<{
  turnNumber: number;
  headline: string;
  actions?: string[];
  tag?: string;
  icon?: string;
}>) {
  await fetch(`${BASE_URL}/api/test/seed-turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, turns }),
  });
}

/** Set up a conversation with messages, insights, and turns. */
async function seedFullSession(opts?: {
  mission?: string;
  turns?: Array<{ turnNumber: number; headline: string; actions?: string[]; tag?: string; icon?: string }>;
}): Promise<string> {
  const convId = await seedConversation();

  // Inject some messages so the conversation has content
  await injectMessage(convId, 'user', 'Help me refactor the auth module');
  await injectMessage(convId, 'assistant', 'I will analyze the auth module and suggest improvements.');

  // Seed insights
  await seedInsights(convId, {
    mission: opts?.mission ?? 'Refactor auth module for better separation of concerns',
  });

  // Seed turns
  const turns = opts?.turns ?? [
    { turnNumber: 1, headline: 'Analyzed auth module structure', tag: 'discovery', icon: '🔍', actions: ['Mapped 12 files in auth module'] },
    { turnNumber: 2, headline: 'Extracted token validation into dedicated service', tag: 'build', icon: '🔧', actions: ['Created token-validator.ts with 3 methods'] },
    { turnNumber: 3, headline: 'Fixed circular dependency between auth and user services', tag: 'fix', icon: '🐛', actions: ['Broke cycle by introducing AuthContext interface'] },
  ];
  await seedTurns(convId, turns);

  return convId;
}

// ============================================================================
// Insights Panel Rendering
// ============================================================================

test.describe('Insights Panel Rendering', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('insights panel shows turn timeline with headlines', async ({ page }) => {
    const convId = await seedFullSession();

    // Navigate with ?tier=pro so insights panel is available
    await page.goto(`/c/${convId}?tier=pro`);

    // The insights panel should be visible on desktop (default open for wide viewports)
    const panel = page.getByTestId('insights-panel');
    await expect(panel).toBeVisible({ timeout: 15000 });

    // Turn headlines should appear in the panel
    await expect(panel.getByText('Analyzed auth module structure')).toBeVisible({ timeout: 10000 });
    await expect(panel.getByText('Extracted token validation into dedicated service')).toBeVisible();
    await expect(panel.getByText('Fixed circular dependency between auth and user services')).toBeVisible();
  });

  test('insights panel shows mission when no turns exist', async ({ page }) => {
    const convId = await seedConversation();
    await injectMessage(convId, 'user', 'Start the migration');
    await injectMessage(convId, 'assistant', 'Beginning migration work.');

    // Seed insights but NO turns
    await seedInsights(convId, { mission: 'Migrate database from Postgres to SQLite' });

    await page.goto(`/c/${convId}?tier=pro`);

    const panel = page.getByTestId('insights-panel');
    await expect(panel).toBeVisible({ timeout: 15000 });

    // Mission text should appear in the empty state
    await expect(panel.getByText('Migrate database from Postgres to SQLite')).toBeVisible({ timeout: 10000 });
  });

  test('turn expansion shows outcome details', async ({ page }) => {
    const convId = await seedFullSession({
      turns: [
        {
          turnNumber: 1,
          headline: 'Investigated failing test suite',
          tag: 'debug',
          icon: '🐛',
          actions: ['Found root cause: stale mock data in test fixtures'],
        },
      ],
    });

    await page.goto(`/c/${convId}?tier=pro`);

    const panel = page.getByTestId('insights-panel');
    await expect(panel).toBeVisible({ timeout: 15000 });

    // Click the turn to expand it
    const turnRow = panel.getByText('Investigated failing test suite');
    await expect(turnRow).toBeVisible({ timeout: 10000 });
    await turnRow.click();

    // Outcome should appear after expansion
    await expect(panel.getByText('Found root cause: stale mock data in test fixtures')).toBeVisible({ timeout: 5000 });
  });
});
