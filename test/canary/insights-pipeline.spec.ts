/**
 * Canary: Insights Pipeline
 *
 * Verifies that sending messages into a real session produces computed
 * insights via the Anthropic API. This is the critical path:
 *
 *   browser → harness → turn:end → InsightsTrigger → Anthropic API
 *   → session_insights table → SSE → sidebar mission text
 *
 * Requires ANTHROPIC_API_KEY. Fails hard if missing.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = 'http://localhost:4200';

// ─── Hard gate: no key = no test ───────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    'ANTHROPIC_API_KEY is required for canary tests. ' +
    'These tests call the real Anthropic API — set the key or don\'t run them.',
  );
}

// ─── Test helpers (same pattern as behavioral tests) ───────────────────────

async function resetServer() {
  await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
}

async function setScenario(scenario: string) {
  await fetch(`${BASE_URL}/api/test/set-scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
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

async function sendMessage(page: Page, text: string) {
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeEditable({ timeout: 15_000 });
  await composer.fill(text);
  await page.getByTestId('send-button').click();
}

/** Poll an API endpoint until the predicate returns true, or timeout. */
async function pollUntil<T>(
  url: string,
  predicate: (data: T) => boolean,
  { intervalMs = 2_000, timeoutMs = 45_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await fetch(url);
    if (resp.ok) {
      const data = (await resp.json()) as T;
      if (predicate(data)) return data;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  // One final attempt for the error message
  const resp = await fetch(url);
  const data = await resp.json();
  throw new Error(`pollUntil timed out after ${timeoutMs}ms. Last response: ${JSON.stringify(data)}`);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test.describe('Insights Pipeline', () => {
  test.beforeEach(async () => {
    await resetServer();
    await setScenario('simple-response');
  });

  test('session gets a mission after two messages', async ({ page }) => {
    const convId = await seedConversation();
    await page.goto(`/c/${convId}?tier=pro`);

    // Message 1 — InsightsTrigger fires but skips (MIN_USER_MESSAGES = 2)
    await sendMessage(page, 'Fix the auth middleware to handle expired tokens');
    await expect(
      page.getByTestId('assistant-message').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Message 2 — InsightsTrigger fires, hits the real Anthropic API
    await sendMessage(page, 'Also add tests for the token refresh flow');
    await expect(
      page.getByTestId('assistant-message').nth(1),
    ).toBeVisible({ timeout: 15_000 });

    // Poll the insights API directly — this is the pipeline's output.
    // Pipeline: turn:end → InsightsTrigger → Anthropic API → store
    const insights = await pollUntil<{ context?: { mission?: string } }>(
      `${BASE_URL}/api/insights/${convId}/insights`,
      (data) => !!data?.context?.mission,
    );

    expect(insights.context?.mission).toBeTruthy();
    expect(insights.context!.mission!.length).toBeGreaterThan(0);
    expect(insights.context!.mission!.length).toBeLessThanOrEqual(54);
  });
});
