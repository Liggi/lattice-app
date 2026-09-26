/**
 * Persistence Across Reload — Behavioral Tests
 *
 * Tests that SSE replay and event persistence work correctly when the
 * user reloads the page mid-stream or navigates back to a streaming session.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

// -- Test helpers --

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
  await expect(composer).toBeVisible({ timeout: 15000 });
  await composer.fill(text);
  await page.getByTestId('send-button').click();
}

async function startSessionInBrowser(page: Page, message: string): Promise<string> {
  const convId = await seedConversation();
  await page.goto(`/c/${convId}`);
  await sendMessage(page, message);
  return convId;
}

// ============================================================================
// Reload during streaming
// ============================================================================

test.describe('Reload During Streaming', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('partial response survives page reload mid-stream', async ({ page }) => {
    // Use very-slow-response (10s) so we can reload while it's still streaming
    await setScenario('very-slow-response');
    const convId = await startSessionInBrowser(page, 'Do something very slow');

    // Wait for partial response to appear
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Working on it' }),
    ).toBeVisible({ timeout: 15000 });

    // Reload while still streaming
    await page.reload();

    // After reload, the partial response should still be visible via SSE replay
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Working on it' }),
    ).toBeVisible({ timeout: 15000 });

    // User message should also persist
    await expect(page.getByTestId('user-message')).toBeVisible({ timeout: 5000 });
  });

  test('reload after completed turn shows full history', async ({ page }) => {
    await setScenario('simple-response');
    const convId = await startSessionInBrowser(page, 'Hello there');

    // Wait for turn to complete
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Hello! I can help you with that' }),
    ).toBeVisible({ timeout: 15000 });

    // Reload
    await page.reload();

    // Both messages should persist
    await expect(page.getByTestId('user-message')).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Hello! I can help you with that' }),
    ).toBeVisible({ timeout: 10000 });

    // Composer should be editable (session is idle)
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 5000 });
  });
});

// ============================================================================
// Navigate away and back during streaming
// ============================================================================

test.describe('Navigate Away During Streaming', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('navigating back to streaming session shows current state', async ({ page }) => {
    await setScenario('very-slow-response');
    const convId = await startSessionInBrowser(page, 'Slow task');

    // Wait for streaming to begin
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Working on it' }),
    ).toBeVisible({ timeout: 15000 });

    // Navigate away
    await page.goto('/');

    // Navigate back
    await page.goto(`/c/${convId}`);

    // Partial response should be visible via SSE replay / event persistence
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Working on it' }),
    ).toBeVisible({ timeout: 15000 });
  });
});
