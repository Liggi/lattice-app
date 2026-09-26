/**
 * Respawn & Idle Exit — Behavioral Tests
 *
 * Tests that sessions recover transparently when the agent process exits
 * after completing a turn (simulating idle timeout or resource cleanup).
 * The user should be able to send a follow-up and get a response from
 * the respawned process without any manual intervention.
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
// Respawn after idle exit
// ============================================================================

test.describe('Respawn After Idle Exit', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('follow-up message works after process exits post-turn', async ({ page }) => {
    // exits-after-turn: responds normally then exits (simulates idle timeout)
    await setScenario('exits-after-turn');
    await startSessionInBrowser(page, 'Tell me something');

    // First response arrives normally
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Here\'s my response to your question' }),
    ).toBeVisible({ timeout: 15000 });

    // Composer re-enables after the process exits
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Send follow-up — should trigger transparent respawn
    await sendMessage(page, 'Follow up question');

    // The respawned process responds (on_stdin handler in exits-after-turn)
    await expect(
      page.getByTestId('assistant-message').nth(1),
    ).toBeVisible({ timeout: 15000 });
  });

  test('composer re-enables after process exits post-turn', async ({ page }) => {
    await setScenario('exits-after-turn');
    await startSessionInBrowser(page, 'Say something then exit');

    // Wait for response to confirm turn completed
    await expect(
      page.getByTestId('assistant-message').first(),
    ).toBeVisible({ timeout: 15000 });

    // Process exits after the turn — composer should re-enable
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });
  });
});

// ============================================================================
// Force-kill respawn (simulates external process death)
// ============================================================================

test.describe('Force-Kill Respawn', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('session recovers after force-kill via test endpoint', async ({ page }) => {
    // Start with a slow response so the process stays alive
    await setScenario('very-slow-response');
    const convId = await startSessionInBrowser(page, 'Do something slow');

    // Wait for streaming to begin
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Working on it' }),
    ).toBeVisible({ timeout: 15000 });

    // Force-kill the session process
    await fetch(`${BASE_URL}/api/test/kill-session/${convId}`, { method: 'POST' });

    // Composer should re-enable after the kill
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Switch to simple-response and send follow-up
    await setScenario('simple-response');
    await sendMessage(page, 'Try again after kill');

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Hello! I can help you with that' }),
    ).toBeVisible({ timeout: 15000 });
  });
});
