/**
 * Core UI Behavioral Suite
 *
 * Pure browser tests. Assert ONLY what a user sees. Zero implementation
 * details — no API event types, no storage checks, no source code inspection.
 *
 * If the entire backend is rewritten and these tests pass, the app works.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

// -- Test infrastructure helpers (not implementation details — just test setup) --

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

async function injectMessage(sessionId: string, role: string, content: string) {
  await fetch(`${BASE_URL}/api/test/inject-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, role, content }),
  });
}

/** Send a message via the browser composer and wait for send to complete. */
async function sendMessage(page: Page, text: string) {
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible({ timeout: 15000 });
  await composer.fill(text);
  await page.getByTestId('send-button').click();
}

/** Start a session (seed + navigate + send first message). Returns convId. */
async function startSessionInBrowser(page: Page, message: string): Promise<string> {
  const convId = await seedConversation();
  await page.goto(`/c/${convId}`);
  await sendMessage(page, message);
  return convId;
}

// ============================================================================
// Message Display
// ============================================================================

test.describe('Message Display', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('navigating to a session with history shows its messages', async ({ page }) => {
    const convId = await seedConversation();
    await injectMessage(convId, 'user', 'What is the meaning of life?');
    await injectMessage(convId, 'assistant', 'The meaning of life is 42.');

    await page.goto(`/c/${convId}`);

    await expect(
      page.getByTestId('user-message').filter({ hasText: 'What is the meaning of life?' }),
    ).toBeVisible({ timeout: 10000 });

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'The meaning of life is 42.' }),
    ).toBeVisible({ timeout: 10000 });
  });

  test('sending a message shows user message and assistant response', async ({ page }) => {
    await setScenario('simple-response');
    const convId = await startSessionInBrowser(page, 'Hello, can you help me?');

    await expect(
      page.getByTestId('user-message').filter({ hasText: 'Hello, can you help me?' }),
    ).toBeVisible({ timeout: 10000 });

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Hello! I can help you with that' }),
    ).toBeVisible({ timeout: 15000 });
  });

  test('user message appears exactly once — no duplicates', async ({ page }) => {
    await setScenario('simple-response');
    await startSessionInBrowser(page, 'Testing for duplicates');

    await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('user-message')).toHaveCount(1, { timeout: 5000 });
  });

  test('tool use blocks render during a session', async ({ page }) => {
    await setScenario('response-with-tool');
    await startSessionInBrowser(page, 'Read a file for me');

    // Tool name visible somewhere in the response
    await expect(page.getByText('Read').first()).toBeVisible({ timeout: 15000 });

    // Final text response also appears
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Based on the file contents' }),
    ).toBeVisible({ timeout: 15000 });
  });
});

// ============================================================================
// Persistence
// ============================================================================

test.describe('Persistence', () => {
  test.beforeEach(async () => {
    await resetServer();
    await setScenario('simple-response');
  });

  test('messages survive page refresh', async ({ page }) => {
    await startSessionInBrowser(page, 'Remember this message');

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Hello! I can help you with that' }),
    ).toBeVisible({ timeout: 15000 });

    await page.reload();

    await expect(
      page.getByTestId('user-message').filter({ hasText: 'Remember this message' }),
    ).toBeVisible({ timeout: 10000 });

    await expect(
      page.getByTestId('assistant-message').first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test('navigating away and back preserves messages', async ({ page }) => {
    await startSessionInBrowser(page, 'First session message');

    await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 15000 });

    // Navigate away to home
    await page.goto('/');
    await page.waitForTimeout(500);

    // Navigate back
    await page.goBack();

    await expect(
      page.getByTestId('user-message').filter({ hasText: 'First session message' }),
    ).toBeVisible({ timeout: 10000 });
  });
});

// ============================================================================
// Multi-turn
// ============================================================================

test.describe('Multi-turn', () => {
  test.beforeEach(async () => {
    await resetServer();
    await setScenario('response-with-tool'); // supports on_stdin follow-ups
  });

  test('follow-up message produces a second response', async ({ page }) => {
    await startSessionInBrowser(page, 'Read a file for me');

    // Wait for first response to complete
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Based on the file contents' }),
    ).toBeVisible({ timeout: 15000 });

    // Send follow-up
    await sendMessage(page, 'Now read another file');

    // Second response appears
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'second file contains' }),
    ).toBeVisible({ timeout: 15000 });

    // Both user messages visible
    await expect(page.getByTestId('user-message')).toHaveCount(2, { timeout: 5000 });
  });
});

// ============================================================================
// Session Lifecycle (UI indicators)
// ============================================================================

test.describe('Session Lifecycle', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('composer re-enables after turn completes', async ({ page }) => {
    await setScenario('simple-response');
    await startSessionInBrowser(page, 'Quick test');

    await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 15000 });

    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeVisible({ timeout: 5000 });
    await expect(composer).toBeEditable({ timeout: 5000 });
  });

  test('thinking block appears during streaming', async ({ page }) => {
    await setScenario('slow-response');
    await startSessionInBrowser(page, 'Think about something');

    // During streaming, a thinking block should appear
    await expect(page.getByTestId('thinking-block').first()).toBeVisible({ timeout: 10000 });

    // Turn completes — final response visible
    await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 20000 });
  });
});

// ============================================================================
// Session Isolation
// ============================================================================

test.describe('Session Isolation', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('different sessions show different messages', async ({ page }) => {
    // Create two sessions with different injected content
    const conv1 = await seedConversation();
    await injectMessage(conv1, 'user', 'Session ONE question');
    await injectMessage(conv1, 'assistant', 'Session ONE answer');

    const conv2 = await seedConversation();
    await injectMessage(conv2, 'user', 'Session TWO question');
    await injectMessage(conv2, 'assistant', 'Session TWO answer');

    // Navigate to session 1
    await page.goto(`/c/${conv1}`);
    await expect(page.getByText('Session ONE question')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Session TWO question')).not.toBeVisible();

    // Navigate to session 2
    await page.goto(`/c/${conv2}`);
    await expect(page.getByText('Session TWO question')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Session ONE question')).not.toBeVisible();
  });
});
