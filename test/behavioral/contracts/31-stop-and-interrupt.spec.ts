/**
 * Stop & Interrupt — Behavioral Tests
 *
 * Tests that users can stop a streaming response mid-turn and that the
 * session recovers cleanly: composer re-enables, follow-up messages work.
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
// Stop mid-stream
// ============================================================================

test.describe('Stop Mid-Stream', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('stop button is visible during streaming', async ({ page }) => {
    // Use very-slow-response so we have plenty of time to see the stop button
    await setScenario('very-slow-response');
    await startSessionInBrowser(page, 'Do something very slow');

    // Wait for streaming to begin (partial response visible)
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Working on it' }),
    ).toBeVisible({ timeout: 15000 });

    // Stop button should be visible during streaming
    await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 5000 });
  });

  test('clicking stop re-enables composer', async ({ page }) => {
    await setScenario('very-slow-response');
    await startSessionInBrowser(page, 'Do something very slow');

    // Wait for streaming to begin
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Working on it' }),
    ).toBeVisible({ timeout: 15000 });

    // Click stop
    await page.getByTestId('stop-button').click();

    // Composer should re-enable after stop is processed
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });
  });

  test('can send follow-up after stopping mid-stream', async ({ page }) => {
    // Use very-slow-response (10s delay) to verify the stop flow works even
    // when the CLI would have been streaming for a long time. Before the fix,
    // the UI incorrectly treated 'idle' (successful SIGINT) as "not terminated"
    // and escalated to force-kill, leaving the session in a broken state.
    await setScenario('very-slow-response');
    await startSessionInBrowser(page, 'Do something very slow');

    // Wait for streaming to begin
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Working on it' }),
    ).toBeVisible({ timeout: 15000 });

    // Stop the stream — SIGINT handler emits a result after 1.5s, ending the turn.
    // The process stays alive (like real Claude CLI), so the session transitions
    // from stopping → connected/idle, not stopping → dead.
    await page.getByTestId('stop-button').click();

    // Wait for the stop to take effect. The session transitions from Working
    // to Ready — the stop button hides (nothing to stop in Ready state) and
    // the composer becomes editable.
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Send follow-up — process is still alive, no respawn needed
    await sendMessage(page, 'Now try something else');

    // New response arrives from the still-alive process (on_stdin echo)
    await expect(
      page.getByTestId('assistant-message').nth(1),
    ).toBeVisible({ timeout: 15000 });
  });

  test('partial response preserved after stop', async ({ page }) => {
    await setScenario('very-slow-response');
    await startSessionInBrowser(page, 'Something slow');

    // Wait for partial content
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Working on it' }),
    ).toBeVisible({ timeout: 15000 });

    // Stop
    await page.getByTestId('stop-button').click();

    // Wait for stop to take effect
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Partial response should still be visible (not cleared)
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Working on it' }),
    ).toBeVisible();
  });
});
