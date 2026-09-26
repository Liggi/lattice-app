/**
 * Sidebar — Behavioral Tests
 *
 * Tests sidebar behavior: session cards appear after sending messages,
 * clicking cards navigates between sessions.
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

async function injectMessage(sessionId: string, role: string, content: string) {
  await fetch(`${BASE_URL}/api/test/inject-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, role, content }),
  });
}

// ============================================================================
// Session Card Appearance
// ============================================================================

test.describe('Session Card Appearance', () => {
  test.beforeEach(async () => {
    await resetServer();
    await setScenario('simple-response');
  });

  test('session card appears in sidebar after sending a message', async ({ page }) => {
    const convId = await startSessionInBrowser(page, 'Hello from sidebar test');

    // Wait for response to confirm session is live
    await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 15000 });

    // Session card should appear in the sidebar without a page reload
    const sessionCard = page.getByTestId(`session-${convId}`);
    await expect(sessionCard).toBeVisible({ timeout: 15000 });
  });
});

// ============================================================================
// Session Card Navigation
// ============================================================================

test.describe('Session Card Navigation', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('clicking a different session card navigates to that session', async ({ page }) => {
    // Create two sessions with injected content
    const conv1 = await seedConversation();
    await injectMessage(conv1, 'user', 'First session question');
    await injectMessage(conv1, 'assistant', 'First session answer');

    const conv2 = await seedConversation();
    await injectMessage(conv2, 'user', 'Second session question');
    await injectMessage(conv2, 'assistant', 'Second session answer');

    // Navigate to session 1
    await page.goto(`/c/${conv1}`);
    await expect(page.getByText('First session question')).toBeVisible({ timeout: 10000 });

    // Wait for sidebar to show both sessions
    const card2 = page.getByTestId(`session-${conv2}`);
    await expect(card2).toBeVisible({ timeout: 15000 });

    // Click session 2's card
    await card2.click();

    // URL should change
    await expect(page).toHaveURL(`/c/${conv2}`, { timeout: 5000 });

    // Session 2's messages should be visible
    await expect(page.getByText('Second session question')).toBeVisible({ timeout: 10000 });

    // Session 1's messages should not be visible
    await expect(page.getByText('First session question')).not.toBeVisible();
  });

  test('clicking back to original session preserves its messages', async ({ page }) => {
    const conv1 = await seedConversation();
    await injectMessage(conv1, 'user', 'Remember me');
    await injectMessage(conv1, 'assistant', 'I will remember you');

    const conv2 = await seedConversation();
    await injectMessage(conv2, 'user', 'Other session');
    await injectMessage(conv2, 'assistant', 'Other answer');

    // Start at session 1
    await page.goto(`/c/${conv1}`);
    await expect(page.getByText('Remember me')).toBeVisible({ timeout: 10000 });

    // Navigate to session 2 via sidebar
    const card2 = page.getByTestId(`session-${conv2}`);
    await expect(card2).toBeVisible({ timeout: 15000 });
    await card2.click();
    await expect(page).toHaveURL(`/c/${conv2}`, { timeout: 5000 });
    await expect(page.getByText('Other session')).toBeVisible({ timeout: 10000 });

    // Navigate back to session 1 via sidebar
    const card1 = page.getByTestId(`session-${conv1}`);
    await card1.click();
    await expect(page).toHaveURL(`/c/${conv1}`, { timeout: 5000 });

    // Original messages still there
    await expect(page.getByText('Remember me')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('I will remember you')).toBeVisible({ timeout: 10000 });
  });
});
