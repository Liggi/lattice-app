/**
 * Event Visibility After Restart — Behavioral Tests
 *
 * Regression tests for bugs where messages disappear after a server restart.
 *
 * Root cause: EventLog.since(0) in the harness. After recoverFromStorage()
 * injects a synthetic `run:end` at a high seq (closing an interrupted session),
 * the in-memory log contains only that one event. The old condition
 * `afterSeq >= earliest || afterSeq === 0` caused since(0) to enter the
 * in-memory fast path, returning only [run:end]. The client received a
 * seq > 0, so the history fallback didn't trigger, and users saw no messages.
 *
 * Secondary issue: the history fallback fetched from the BEGINNING (oldest
 * first), so even when it fired, long conversations showed only the first
 * ~200 events — typically ending at an early message.
 *
 * The fix removes `|| afterSeq === 0`, so since(0) falls through to the
 * storage + memory merge path and returns all events.
 *
 * These tests verify:
 * 1. After mid-stream interruption, messages are visible on navigation
 *    WITHOUT sending a new message (the core "no messages" bug)
 * 2. After restart with many stored events, recent messages are visible
 * 3. Earlier messages are accessible via scroll-up pagination
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

async function injectPaddingEvents(sessionId: string, count: number) {
  await fetch(`${BASE_URL}/api/test/inject-events/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
}

async function injectMessage(sessionId: string, role: string, content: string) {
  await fetch(`${BASE_URL}/api/test/inject-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, role, content }),
  });
}

async function sendMessage(page: Page, text: string) {
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible({ timeout: 15000 });
  await composer.fill(text);
  await page.getByTestId('send-button').click();
}

async function startSessionInBrowser(page: Page, message: string, opts?: { pending?: boolean }): Promise<string> {
  const convId = await seedConversation(opts);
  await page.goto(`/c/${convId}`);
  await sendMessage(page, message);
  return convId;
}

// ============================================================================
// Event visibility after simulated server restart
// ============================================================================

test.describe('Event Visibility After Server Restart', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('messages visible after server crash mid-stream (no turn:end in storage)', async ({ page }) => {
    // Core regression for "sessions appearing with no messages."
    //
    // In a real server crash, the Node process dies without writing turn:end
    // or run:end. Storage has partial events only. On recovery,
    // recoverFromStorage() sees non-idle status → injects a synthetic run:end
    // at a high seq into the in-memory EventLog.
    //
    // Note: destroySession() does NOT reproduce this because the process exit
    // handler holds a reference to the EventLog and writes run:end to storage
    // before the async cleanup notices the session is gone. Direct injection
    // is the only reliable way to simulate a true server crash.
    const convId = await seedConversation({ pending: true });
    await injectMessage(convId, 'user', 'Interrupted question');
    await injectMessage(convId, 'assistant', 'Partial response that was streaming when server crashed.');

    // Navigate — no in-memory session exists, so SSE handler calls
    // recoverFromStorage(), which:
    //   1. Reads storage: [input:sent, content] — no turn:end
    //   2. deriveStatus → 'streaming'
    //   3. Injects synthetic run:end at seq 3 into in-memory EventLog
    //
    // BUG: since(0) entered the in-memory fast path (afterSeq===0 matched
    // the old `|| afterSeq === 0` condition), returned only [run:end at seq 3].
    // Client received seq > 0, so the history fallback didn't trigger,
    // and users saw an empty session.
    //
    // FIX: since(0) falls through to storage + memory merge.
    await page.goto(`/c/${convId}`);
    await page.waitForLoadState('domcontentloaded');

    // The assistant message from before the crash should be visible.
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Partial response' }),
    ).toBeVisible({ timeout: 10000 });

    // The user message should also be visible.
    await expect(page.getByText('Interrupted question')).toBeVisible();
  });

  test('most recent messages are visible after restart with many events', async ({ page }) => {
    // Use restart-visibility scenario:
    //   fresh → "Alpha response — this is the first turn."
    //   resumed → "Beta response — this is after the restart."
    // pending: true to match production behavior (pending- providerSessionId)
    await setScenario('restart-visibility');
    const convId = await startSessionInBrowser(page, 'Initial question', { pending: true });

    // Wait for first turn to complete
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Alpha response' }),
    ).toBeVisible({ timeout: 15000 });

    // Wait for process to exit (exit_after_main)
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Inject 300 padding events — enough to push the first turn's events
    // way beyond the default 200-event history limit. Without the fix,
    // the client would fetch events 1-200 (which includes the first turn)
    // and show "Alpha response" as the last message, missing everything
    // after event 200.
    await injectPaddingEvents(convId, 300);

    // Simulate server restart: destroy session from memory, preserve DB.
    await destroySession(convId);

    // Reload — browser reconnects to the restarted server.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Send a follow-up — triggers auto-resume.
    await sendMessage(page, 'Follow-up after restart');

    // The resumed response should be visible (most recent turn).
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Beta response' }),
    ).toBeVisible({ timeout: 15000 });

    // The follow-up user message should also be visible.
    await expect(page.getByText('Follow-up after restart')).toBeVisible();
  });

  test('first turn messages reachable via scroll-up after restart', async ({ page }) => {
    await setScenario('restart-visibility');
    const convId = await startSessionInBrowser(page, 'Initial question', { pending: true });

    // Wait for first turn
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Alpha response' }),
    ).toBeVisible({ timeout: 15000 });

    // Wait for process to exit
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Inject padding + destroy session
    await injectPaddingEvents(convId, 300);
    await destroySession(convId);

    // Reload
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Send follow-up
    await sendMessage(page, 'Follow-up after restart');
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Beta response' }),
    ).toBeVisible({ timeout: 15000 });

    // Now scroll to the top of the message list to trigger history loading.
    // The MessageList should have a "load more" mechanism.
    // Scroll up repeatedly to trigger fetchHistory pagination.
    const messageContainer = page.getByTestId('message-list-container');
    if (await messageContainer.isVisible()) {
      // Scroll to top to trigger pagination
      for (let i = 0; i < 5; i++) {
        await messageContainer.evaluate((el) => el.scrollTo(0, 0));
        await page.waitForTimeout(500);
      }
    }

    // After scrolling up, the original first-turn messages should be loaded.
    // This verifies the full event chain is accessible via pagination.
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Alpha response' }),
    ).toBeVisible({ timeout: 15000 });

    // The original user message should also be visible
    await expect(page.getByText('Initial question')).toBeVisible();
  });
});
