/**
 * Background Task — Behavioral Test
 *
 * When Claude runs a command with `run_in_background: true`, the CLI:
 * 1. Returns immediately with the output file path
 * 2. Emits a `system:task_started` event
 * 3. Claude may end its turn (session goes idle)
 * 4. When the task completes: `system:task_updated` + `system:task_notification`
 * 5. CLI wakes up (second `system:init` → `run:ready`)
 * 6. Claude checks the output and reports
 *
 * The frontend should:
 * - Render the BashTool card with background task indicator
 * - Show the session going idle between turns
 * - Resume streaming when the CLI wakes up for the completion check
 * - Show the final output
 *
 * Uses a real cassette recording of a 30-second background task:
 *   - Turn 1: Bash(run_in_background) → text → turn:end
 *   - ~30s gap: task_started → task_updated → task_notification
 *   - Turn 2: run:ready (wake-up) → Read output → text → turn:end
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

// -- Test helpers --

async function resetServer() {
  await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
}

async function setCassette(cassette: string, opts?: { timescale?: number }) {
  const resp = await fetch(`${BASE_URL}/api/test/set-cassette`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cassette, timescale: opts?.timescale ?? 0.01 }),
  });
  if (!resp.ok) throw new Error(`set-cassette failed: ${await resp.text()}`);
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

// -- Tests --

test.describe('Background Task', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('background Bash command renders with run_in_background indicator', async ({ page }) => {
    // The cassette is ~45s real time. At 0.01x timescale, the whole thing
    // replays in under 1 second. Use a slightly higher timescale to let
    // the UI settle between events.
    await setCassette('background-task', { timescale: 0.02 });
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    await sendMessage(page, 'run in background');

    // The first Bash tool card should appear with the background command
    const bashCard = page.locator('[data-testid="tool-Bash"]').first();
    await expect(bashCard).toBeVisible({ timeout: 30000 });

    // The tool result should mention "running in background" or the output path
    await expect(bashCard.getByText(/background|Output is being written/i)).toBeVisible({ timeout: 10000 });
  });

  test('session completes both turns — background task wake-up produces output', async ({ page }) => {
    await setCassette('background-task', { timescale: 0.02 });
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    await sendMessage(page, 'run in background');

    // Wait for the final text — Claude reports the completed output after
    // waking up and reading the file. The cassette's final message contains
    // "Completed successfully" or "ALL_DONE".
    const messageList = page.getByTestId('message-list');
    await expect(messageList.getByText(/Completed successfully|ALL_DONE/i)).toBeVisible({ timeout: 30000 });

    // There should be a Read tool card from the wake-up turn (Claude reads the output file)
    const readCard = page.locator('[data-testid="tool-Read"]');
    await expect(readCard.first()).toBeVisible({ timeout: 5000 });
  });

  test('status shows "Waiting for background task" between turns', async ({ page }) => {
    // The ~30s gap between turns must play out slowly enough that the
    // SSEClient has connected and the UI has rendered before the gap ends.
    // At 0.1x the gap is only 3s — easily missed if the SSE connect takes
    // a few hundred ms. At 0.3x, the gap is ~9s — comfortable margin.
    await setCassette('background-task', { timescale: 0.3 });
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    await sendMessage(page, 'run in background');

    // Wait for the Bash tool card (turn 1 is streaming)
    const bashCard = page.locator('[data-testid="tool-Bash"]').first();
    await expect(bashCard).toBeVisible({ timeout: 30000 });

    // After turn 1 ends and the task is still running, status should
    // show "Waiting for background task" instead of "Ready"
    const statusText = page.getByText('Waiting for background task');
    await expect(statusText).toBeVisible({ timeout: 15000 });

    // Eventually the task completes and Claude wakes up — status should
    // transition away from "Waiting" (back to Working, then Ready)
    await expect(statusText).not.toBeVisible({ timeout: 15000 });
  });

  test('assistant text appears in both turns', async ({ page }) => {
    await setCassette('background-task', { timescale: 0.02 });
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    await sendMessage(page, 'run in background');

    const messageList = page.getByTestId('message-list');

    // Turn 1: Claude acknowledges the background task launch
    await expect(messageList.getByText(/background|running|started/i).first()).toBeVisible({ timeout: 30000 });

    // Turn 2: Claude reports the completed task
    await expect(messageList.getByText(/Completed|finished|ALL_DONE/i).first()).toBeVisible({ timeout: 30000 });
  });
});
