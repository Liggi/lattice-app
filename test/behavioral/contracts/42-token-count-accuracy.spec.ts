/**
 * Token Count Accuracy — Behavioral Test
 *
 * The token counter in the Composer should show the actual context window
 * size (from the last API call's usage), NOT the inflated per-turn sum
 * across all agentic iterations.
 *
 * Uses the real plan-mode cassette which has known usage data:
 *   - Turn 1: 11 agentic iterations, last API call context = 39,197 tokens
 *     Per-turn sum (wrong) = 339,061 tokens
 *   - Turn 2: 3 iterations, last API call context = 42,553 tokens
 *     Per-turn sum (wrong) = 123,017 tokens
 *
 * The test asserts that the displayed number matches the last API call's
 * context (39K or 42K), not the inflated turn sum (339K or 123K).
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
    body: JSON.stringify({ cassette, timescale: opts?.timescale ?? 0.05 }),
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

test.describe('Token Count Accuracy', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('displays context window size from last API call, not inflated turn sum', async ({ page }) => {
    // Plan-mode cassette: turn 1 has 11 agentic iterations
    // Last API call context: 39,197 tokens → displays as "39K"
    // Per-turn sum (old, wrong): 339,061 → would display as "339K"
    await setCassette('plan-mode', { timescale: 0.02 });

    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);
    await sendMessage(page, 'plan the refactor');

    // Wait for the token usage display to appear after turn 1 completes
    const tokenUsage = page.getByTestId('token-usage');
    await expect(tokenUsage).toBeVisible({ timeout: 15000 });

    // Read the raw token count from data-tokens attribute
    const tokensAttr = await tokenUsage.locator('span[data-tokens]').getAttribute('data-tokens');
    const tokenCount = Number(tokensAttr);

    // The context window size from the last API call should be 25-42K
    // (depends on how many cassette events have replayed at check time).
    // The CRITICAL assertion: it must NOT be 339,061 (the inflated per-turn
    // sum across all 11 agentic iterations), nor anywhere above ~50K.
    expect(tokenCount).toBeGreaterThan(20000);
    expect(tokenCount).toBeLessThan(50000);

    // Verify displayed text is a reasonable K-range, not the inflated 339K
    await expect(tokenUsage).toContainText(/\d+K tokens/);
    const displayText = await tokenUsage.textContent();
    expect(displayText).not.toContain('339K');
    expect(displayText).not.toContain('123K');
  });

  test('normal context uses a neutral tone rather than a warning state', async ({ page }) => {
    // The compacting and failed states own amber/red. A normal token reading
    // stays neutral because Lattice does not know every model's context limit.
    await setCassette('plan-mode', { timescale: 0.02 });

    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);
    await sendMessage(page, 'plan the refactor');

    const tokenUsage = page.getByTestId('token-usage');
    await expect(tokenUsage).toBeVisible({ timeout: 15000 });

    const span = tokenUsage.locator('span[data-tokens]');

    // At ~39K tokens, should NOT have amber or red colors
    const className = await span.getAttribute('class');
    expect(className).not.toContain('text-amber');
    expect(className).not.toContain('text-red');
  });
});
