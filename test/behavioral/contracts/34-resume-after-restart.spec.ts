/**
 * Resume After Restart — Behavioral Tests
 *
 * Tests that conversations are fully resumable after a server restart.
 * When the server restarts, the in-memory SessionManager state is lost,
 * but all conversation data persists in SQLite. The next user message
 * should trigger auto-resume with --resume pointing to the correct
 * provider session ID, so Claude has full conversation context.
 *
 * The agent stub differentiates fresh vs. resumed starts via the
 * `resume_events` scenario field. If --resume is passed, it plays
 * resume_events; otherwise it plays events. The test asserts which
 * response text appears in the UI.
 *
 * BUG UNDER TEST: conversation_segments.provider_session_id is created
 * as `pending-*` and never updated to the real session ID from run:ready.
 * After a restart, resolveResumeSessionId reads the stale `pending-*`,
 * filters it out, and the new process starts without --resume.
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

/** Inject N padding events into harness event storage for a session.
 *  Pushes early events (run:ready) outside the recovery window (last 50). */
async function injectPaddingEvents(sessionId: string, count: number) {
  await fetch(`${BASE_URL}/api/test/inject-events/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
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
// Resume after simulated server restart
// ============================================================================

test.describe('Resume After Server Restart', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('follow-up after restart resumes with conversation context', async ({ page }) => {
    // Use resume-context scenario: fresh start → "First turn — fresh session"
    //                               resumed    → "Resumed — I have context"
    // Use pending: true to match production behavior (pending- providerSessionId)
    await setScenario('resume-context');
    const convId = await startSessionInBrowser(page, 'Tell me about my project', { pending: true });

    // First response should be the fresh-start text
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'First turn — fresh session' }),
    ).toBeVisible({ timeout: 15000 });

    // Process exits after turn (exit_after_main in scenario).
    // Wait for composer to re-enable (confirms process exited).
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Simulate a LONG session by injecting padding events into harness storage.
    // This pushes the run:ready event (which contains the real provider session ID)
    // outside the last-50-event recovery window. Without this, recoverFromStorage
    // would find run:ready and the test would pass on the in-memory path alone.
    await injectPaddingEvents(convId, 100);

    // Simulate server restart: destroy the session from memory.
    // Database (harness_events, conversations, conversation_segments) is preserved.
    // On SSE reconnect, recoverFromStorage reads the last 50 events — but run:ready
    // is now at seq ~3, buried under 100 padding events. resumeId will be null.
    await destroySession(convId);

    // Reload the page — in a real restart, the browser reconnects to the server.
    // Without reload, the SSE connection is stale (subscribed to the destroyed
    // session's EventLog), so new events wouldn't be delivered.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Send follow-up — should auto-resume with --resume <providerSessionId>
    await sendMessage(page, 'What were we just discussing?');

    // If --resume was correctly passed, the stub plays resume_events:
    //   "Resumed — I have context from our previous conversation."
    // If --resume was NOT passed (the bug), the stub plays events:
    //   "First turn — fresh session, no prior context."
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Resumed — I have context' }),
    ).toBeVisible({ timeout: 15000 });
  });

  test('previous messages remain visible after restart and follow-up', async ({ page }) => {
    await setScenario('resume-context');
    const convId = await startSessionInBrowser(page, 'Tell me about my project', { pending: true });

    // Wait for first response
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'First turn — fresh session' }),
    ).toBeVisible({ timeout: 15000 });

    // Wait for process to exit
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEditable({ timeout: 10000 });

    // Simulate long session + restart
    await injectPaddingEvents(convId, 100);
    await destroySession(convId);

    // Reload — simulate browser reconnecting after restart
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Send follow-up
    await sendMessage(page, 'Continue please');

    // Wait for a second assistant message to appear (the follow-up response)
    await expect(
      page.getByTestId('assistant-message').nth(1),
    ).toBeVisible({ timeout: 15000 });

    // The original user message and first response should still be visible
    await expect(page.getByText('Tell me about my project')).toBeVisible();
    await expect(page.getByText('First turn — fresh session').first()).toBeVisible();

    // The follow-up response should be a resumed response, not another fresh start.
    // If the bug is present, we'd see TWO "First turn — fresh session" messages.
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Resumed — I have context' }),
    ).toBeVisible();
  });
});
