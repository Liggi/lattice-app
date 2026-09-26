/**
 * Error States — Behavioral Tests
 *
 * Tests what users see when sessions fail: mid-turn crashes, early exits,
 * and recovery via follow-up messages.
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
// Mid-turn crash
// ============================================================================

test.describe('Mid-turn Crash', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('partial response remains visible after process crashes', async ({ page }) => {
    await setScenario('error-crash');
    await startSessionInBrowser(page, 'Do something that crashes');

    // The stub emits a partial text response ("Let me work on that...") then exits with code 1
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Let me work on that' }),
    ).toBeVisible({ timeout: 15000 });
  });

  test('composer re-enables after mid-turn crash', async ({ page }) => {
    await setScenario('error-crash');
    await startSessionInBrowser(page, 'Do something that crashes');

    // Wait for partial response (crash has happened)
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Let me work on that' }),
    ).toBeVisible({ timeout: 15000 });

    // Composer should re-enable after the process dies
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });
  });

  test('can send follow-up after crash — session respawns', async ({ page }) => {
    // Start with a crash scenario, then switch to simple-response for the respawn
    await setScenario('error-crash');
    await startSessionInBrowser(page, 'Do something that crashes');

    // Wait for crash to complete
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Let me work on that' }),
    ).toBeVisible({ timeout: 15000 });

    // Wait for composer to re-enable
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Switch scenario so the respawned process responds normally
    await setScenario('simple-response');

    // Send follow-up — this should trigger a respawn
    await sendMessage(page, 'Try again');

    // Second response arrives from the respawned process
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Hello! I can help you with that' }),
    ).toBeVisible({ timeout: 15000 });
  });
});

// ============================================================================
// Early exit
// ============================================================================

test.describe('Early Exit', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('composer re-enables after process exits immediately', async ({ page }) => {
    await setScenario('error-immediate-exit');
    await startSessionInBrowser(page, 'This will fail immediately');

    // Process exits right after system_init with code 1
    // Composer should re-enable since the session is no longer active
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });
  });

  test('can start a new turn after early exit', async ({ page }) => {
    await setScenario('error-immediate-exit');
    await startSessionInBrowser(page, 'This will fail immediately');

    // Wait for composer to re-enable
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Switch to working scenario and try again
    await setScenario('simple-response');
    await sendMessage(page, 'Try again');

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Hello! I can help you with that' }),
    ).toBeVisible({ timeout: 15000 });
  });
});
