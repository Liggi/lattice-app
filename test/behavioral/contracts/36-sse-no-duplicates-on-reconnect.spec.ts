/**
 * SSE No Duplicates After Reconnect — Behavioral Tests
 *
 * Regression test for event duplication when SSE client reconnects.
 *
 * Root cause: SSEClient's visibility handler calls connectLoop() while an
 * existing instance is sleeping in reconnection backoff. Two concurrent
 * loops each establish their own SSE connection, subscribing to the same
 * server-side EventLog. Every event is then delivered twice → duplicate
 * messages in the UI.
 *
 * Trigger sequence:
 *   1. Server restart (destroySession) → SSE connection drops
 *   2. Tab goes hidden → visible (simulated via visibilitychange)
 *   3. Visibility handler starts a second connectLoop
 *   4. Both loops connect → two SSE streams → double events
 *   5. Follow-up message events appear twice in the message list
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

// -- Test helpers (match patterns from 34-resume-after-restart.spec.ts) --

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

async function seedConversation(opts?: { pending?: boolean }): Promise<string> {
  const resp = await fetch(`${BASE_URL}/api/test/seed-conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude', pending: opts?.pending }),
  });
  const data = (await resp.json()) as { conversationId: string };
  return data.conversationId;
}

async function destroySession(sessionId: string) {
  await fetch(`${BASE_URL}/api/test/destroy-session/${sessionId}`, {
    method: 'POST',
  });
}

async function sendMessage(page: Page, text: string) {
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible({ timeout: 15000 });
  await composer.fill(text);
  await page.getByTestId('send-button').click();
}

async function startSessionInBrowser(
  page: Page,
  message: string,
  opts?: { pending?: boolean },
): Promise<string> {
  const convId = await seedConversation(opts);
  await page.goto(`/c/${convId}`);
  await sendMessage(page, message);
  return convId;
}

/**
 * Simulate tab hidden → visible to trigger SSEClient's visibility handler.
 * This is the exact mechanism that causes the concurrent connectLoop bug:
 * when the controller's signal is aborted (from a dropped connection),
 * the visibility handler starts a second connectLoop instance.
 */
async function simulateTabVisibilityChange(page: Page) {
  // Tab goes hidden — SSEClient aborts the controller
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Brief pause — let the abort propagate
  await page.waitForTimeout(200);
  // Tab becomes visible — visibility handler checks controller.signal.aborted
  // and (with the bug) starts a second connectLoop
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

// ============================================================================
// SSE Reconnection — No Duplicate Events
// ============================================================================

test.describe('SSE Reconnection — No Duplicates', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('tab visibility change during reconnect must not duplicate follow-up messages', async ({
    page,
  }) => {
    // Start session and get first response
    await setScenario('sse-reconnect-dedup');
    const convId = await startSessionInBrowser(page, 'Start the session', { pending: true });

    // Wait for first response
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'First turn' }),
    ).toBeVisible({ timeout: 15000 });

    // Wait for process to exit (exit_after_main in scenario)
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Simulate server restart: destroy session from memory.
    // SSE connection will fail on next heartbeat or poll → enters reconnection.
    await destroySession(convId);

    // Simulate tab hidden → visible while SSE is reconnecting.
    // This is the trigger for the concurrent connectLoop bug.
    await simulateTabVisibilityChange(page);

    // Wait for reconnection to settle (both loops need time to connect)
    await page.waitForTimeout(3000);

    // Send follow-up — events from this turn flow through the EventLog.
    // With the bug, both SSE connections deliver each event → duplicate messages.
    await sendMessage(page, 'Follow-up question');

    // Wait for at least one follow-up response to appear
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'should appear exactly once' }).first(),
    ).toBeVisible({ timeout: 15000 });

    // ASSERTION: the follow-up text should appear exactly once.
    // With the bug, the follow-up assistant message appears twice.
    const followUpCount = await page
      .getByTestId('assistant-message')
      .filter({ hasText: 'should appear exactly once' })
      .count();
    expect(followUpCount).toBe(1);

    // Also verify total message counts: 2 user + 2 assistant, not more.
    await expect(page.getByTestId('user-message')).toHaveCount(2);
    await expect(page.getByTestId('assistant-message')).toHaveCount(2);
  });
});
