/**
 * Compact History Replay — Behavioral Tests
 *
 * Reproduces the blank-screen bug after compact + page refresh.
 *
 * Root cause: SSE replay scoping (sse-handler.ts / sse-handler-web.ts) finds
 * the last turn:end, walks backward to the previous turn:end or run:end, and
 * only replays events between those two boundaries. After compact, there are
 * two consecutive turn:end events (compact_boundary + result) with no renderable
 * content between them. The SSE replay delivers only the result turn:end, which
 * produces zero renderable messages.
 *
 * The onConnected fallback in useSession checks "did any SSE events arrive?"
 * but not "did any *renderable* events arrive?" — so it doesn't fire the
 * history fetch. The IntersectionObserver in use-block-budget.ts eventually
 * triggers fetchHistory on scroll-up, recovering the pre-compact messages.
 *
 * Bug observed in a real session, 2026-04-14.
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
  await expect(composer).toBeEditable({ timeout: 10000 });
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
// Compact history replay (blank-screen bug)
// ============================================================================

test.describe('Compact History Replay', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('pre-compact messages survive page refresh', async ({ page }) => {
    await setScenario('compact-history-replay');
    await startSessionInBrowser(page, 'Analyze the codebase');

    // Wait for first turn response
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'analysis you requested' }),
    ).toBeVisible({ timeout: 15000 });

    // Send second message → second turn
    await sendMessage(page, 'Apply the changes');
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Changes applied' }),
    ).toBeVisible({ timeout: 15000 });

    // Verify both pre-compact messages are visible before compact
    await expect(page.getByTestId('assistant-message')).toHaveCount(2, { timeout: 5000 });

    // Trigger compact (third stdin response = compact_boundary + system_init + result)
    await sendMessage(page, '/compact');

    // Wait for compact to settle — composer re-enables after the reinit
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Page refresh — SSE reconnects with afterSeq=0
    await page.reload();

    // After refresh, pre-compact messages should eventually be visible.
    // The SSE replay scoping clips them (delivers only the post-compact
    // turn:end), but the IntersectionObserver triggers fetchHistory which
    // loads them from storage via PREPEND_HISTORY.
    //
    // If this assertion fails, the history recovery path is broken.
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'analysis you requested' }),
    ).toBeVisible({ timeout: 15000 });

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Changes applied' }),
    ).toBeVisible({ timeout: 15000 });
  });

  test('post-compact messages work after refresh', async ({ page }) => {
    await setScenario('compact-history-replay');
    await startSessionInBrowser(page, 'Analyze the codebase');

    // First response
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'analysis you requested' }),
    ).toBeVisible({ timeout: 15000 });

    // Second turn
    await sendMessage(page, 'Apply the changes');
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Changes applied' }),
    ).toBeVisible({ timeout: 15000 });

    // Trigger compact
    await sendMessage(page, '/compact');
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Refresh and send a post-compact message
    await page.reload();
    await sendMessage(page, 'Do something after compact');

    // Post-compact response (fourth on_stdin response)
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Post-compact response' }),
    ).toBeVisible({ timeout: 15000 });
  });

  test('context details triggers compaction without rendering a command bubble', async ({ page }) => {
    await setScenario('compact-history-replay');
    await startSessionInBrowser(page, 'Analyze the codebase');

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'analysis you requested' }),
    ).toBeVisible({ timeout: 15000 });

    // Advance to the scenario's compact response while also proving the control
    // remains available on an established multi-turn conversation.
    await sendMessage(page, 'Apply the changes');
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Changes applied' }),
    ).toBeVisible({ timeout: 15000 });

    const userMessageCount = await page.getByTestId('user-message').count();
    const contextControl = page.getByTestId('token-usage');
    await expect(contextControl).toBeVisible();
    await contextControl.click();

    const contextDetails = page.getByRole('dialog', { name: 'Context details' });
    await expect(contextDetails).toBeVisible();
    await expect(contextDetails).toContainText('Current context');
    await contextDetails.getByTestId('compact-now-button').click();

    await expect(page.getByTestId('compaction-divider')).toContainText(
      'Context Compacted · Manual · 42K → 13K · 2s',
      { timeout: 15000 },
    );
    // The composer's status bar is the one place that names the state — the
    // token control beside it keeps showing the count throughout, so asserting
    // on the control would pass whether or not compaction ever ended.
    await expect(page.getByTestId('composer-status-bar'))
      .not.toContainText('Compacting context', { timeout: 10000 });

    // Compaction is a session command, not something the user said to the model.
    await expect(page.getByTestId('user-message')).toHaveCount(userMessageCount);
    await expect(page.getByTestId('user-message').filter({ hasText: '/compact' })).toHaveCount(0);
  });
});
