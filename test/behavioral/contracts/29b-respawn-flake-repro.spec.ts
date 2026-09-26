/**
 * Reproduction test for the `29-respawn-and-idle-exit` flake.
 *
 * Reproduces the failure mode of the original
 * `29-respawn-and-idle-exit › follow-up message works after process exits
 * post-turn` test, which fails ~50–100% of the time depending on how the
 * test runner is invoked (~62% across 8 isolated runs of the original;
 * 100% across 10 runs of this version).
 *
 * Behavioral contract being tested: after the agent stub process exits
 * post-turn (`exits-after-turn` scenario), a follow-up message must
 * trigger a respawn and produce a second assistant message.
 *
 * Mirrors the original test's timing exactly (no extra evaluate/wait calls
 * between composer-fill and send-button-click — those mask the race).
 * Adds only passive page listeners. On failure, snapshots
 * `__latticeDebug`, captured requests, and the DOM-level state at the
 * timeout point so the failure message is self-contained for diagnosis.
 *
 * Diagnosed root cause (see investigation notes elsewhere):
 *   The respawned agent stub process emits its system_init / run:ready
 *   then hangs — the child's main() coroutine never advances past the
 *   `await sleep(100)` that should precede the assistant content event.
 *   No further stdout, no exit. The hang is consistent (server log shows
 *   stderr stops at "Received stdin #1" and never logs
 *   "exit_after_main: exiting"). It only reproduces on the second spawn
 *   inside the same test, when respawn happens ~400ms after the previous
 *   stub exited.
 *
 *   Net effect on the original test: events 9–12 of turn 2 never appear,
 *   so the second `assistant-message` element never renders, and the
 *   `nth(1)` assertion times out at 15s.
 *
 * No fix lands here — diagnose only. The original test (29) is left in
 * place; this test exists to prove the failure deterministically.
 */

import { test, expect, type Page, type Request } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

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
  return ((await resp.json()) as { conversationId: string }).conversationId;
}

async function snapshotLatticeDebug(page: Page): Promise<unknown> {
  return page
    .evaluate(() => (window as unknown as { __latticeDebug?: unknown }).__latticeDebug ?? null)
    .catch(() => null);
}

test.describe('29-respawn-and-idle-exit flake — diagnostic repro', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('follow-up after exit_after_main produces second assistant message', async ({ page }) => {
    const harnessRequests: Array<{ method: string; url: string; postData: string | null; ts: number }> = [];
    const consoleErrors: string[] = [];
    const failedRequests: Array<{ url: string; error: string; ts: number }> = [];
    const startTs = Date.now();

    page.on('request', (req: Request) => {
      const url = req.url();
      if (url.includes('/api/harness/') || url.includes('/api/sessions/status')) {
        harnessRequests.push({
          method: req.method(),
          url: url.replace(BASE_URL, ''),
          postData: req.postData(),
          ts: Date.now() - startTs,
        });
      }
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    page.on('requestfailed', (req) => {
      const url = req.url();
      if (url.includes('/api/harness/')) {
        failedRequests.push({
          url: url.replace(BASE_URL, ''),
          error: req.failure()?.errorText ?? 'unknown',
          ts: Date.now() - startTs,
        });
      }
    });

    await setScenario('exits-after-turn');

    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    // Turn 1 — same flow as the original test.
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeVisible({ timeout: 15000 });
    await composer.fill('Tell me something');
    await page.getByTestId('send-button').click();

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: "Here's my response to your question" }),
    ).toBeVisible({ timeout: 15000 });

    await expect(composer).toBeEditable({ timeout: 10000 });

    // Critical: no waits/evaluates here — match original timing exactly.
    await composer.fill('Follow up question');
    await page.getByTestId('send-button').click();

    // Same assertion as original `29-respawn-and-idle-exit` test. Use
    // expect.toBeVisible because Locator.isVisible() is an immediate snapshot
    // and does not wait for the timeout option.
    try {
      await expect(page.getByTestId('assistant-message').nth(1)).toBeVisible({
        timeout: 15000,
      });
    } catch {
      const harnessAtTimeout = await snapshotLatticeDebug(page);
      const assistantMessageCount = await page.getByTestId('assistant-message').count();
      const userMessageCount = await page.getByTestId('user-message').count();
      const composerValue = await composer.inputValue().catch(() => 'unreadable');

      throw new Error(
        `assistant-message[1] not visible within 15s.\n` +
          `assistantMessageCount=${assistantMessageCount}, userMessageCount=${userMessageCount}\n` +
          `composer value at timeout=${JSON.stringify(composerValue)}\n\n` +
          `__latticeDebug at timeout:\n${JSON.stringify(harnessAtTimeout, null, 2)}\n\n` +
          `Harness/status requests (full timeline, ts=ms since test start):\n${JSON.stringify(harnessRequests, null, 2)}\n\n` +
          `Failed requests:\n${JSON.stringify(failedRequests, null, 2)}\n\n` +
          `Console errors:\n${consoleErrors.join('\n')}`,
      );
    }
  });
});
