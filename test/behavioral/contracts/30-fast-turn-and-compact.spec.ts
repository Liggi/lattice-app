/**
 * Fast Turn & Compact — Behavioral Tests
 *
 * Tests edge cases around near-instant responses and the compact/reinit
 * sequence. These are timing-sensitive scenarios where the UI can get
 * confused by rapid state transitions.
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
// Fast turn (near-instant response)
// ============================================================================

test.describe('Fast Turn', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('instant response renders and composer re-enables', async ({ page }) => {
    await setScenario('fast-turn');
    await startSessionInBrowser(page, 'Do something fast');

    // Response should appear despite 50ms turn duration
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Done.' }),
    ).toBeVisible({ timeout: 10000 });

    // Composer should be ready for next input
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 5000 });
  });

  test('thinking indicator clears after fast turn', async ({ page }) => {
    await setScenario('fast-turn');
    await startSessionInBrowser(page, 'Quick task');

    // Wait for the response to appear
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Done.' }),
    ).toBeVisible({ timeout: 10000 });

    // Thinking block should NOT be visible after the turn completes
    // (fast turns can leave thinking indicators stuck if cleanup is race-y)
    await expect(page.getByTestId('thinking-block')).not.toBeVisible({ timeout: 5000 });
  });

  test('can send multiple fast turns back-to-back', async ({ page }) => {
    await setScenario('fast-turn');
    await startSessionInBrowser(page, 'First fast task');

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Done.' }),
    ).toBeVisible({ timeout: 10000 });

    // Wait for composer to re-enable, then send another
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 5000 });

    await sendMessage(page, 'Second fast task');

    // Second response should appear (on_stdin produces "Done again.")
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Done again.' }),
    ).toBeVisible({ timeout: 10000 });
  });
});

// ============================================================================
// Compact / reinit sequence
// ============================================================================

test.describe('Compact Reinit', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('response visible after compact reinit sequence', async ({ page }) => {
    // compact-reinit: emits turn:end then a new system_init (simulates /compact)
    await setScenario('compact-reinit');
    await startSessionInBrowser(page, 'Compact please');

    // First response from the compact sequence
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Context compacted' }),
    ).toBeVisible({ timeout: 15000 });

    // Composer should re-enable after the reinit settles
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });
  });

  test('can send message after compact reinit completes', async ({ page }) => {
    await setScenario('compact-reinit');
    await startSessionInBrowser(page, 'Compact my context');

    // Wait for compact to complete
    await expect(
      page.getByTestId('assistant-message').first(),
    ).toBeVisible({ timeout: 15000 });

    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Send a follow-up after compact — should work with the reinitialized session
    await sendMessage(page, 'Now do something else');

    // Second response from the on_stdin handler
    await expect(
      page.getByTestId('assistant-message').nth(1),
    ).toBeVisible({ timeout: 15000 });
  });
});
