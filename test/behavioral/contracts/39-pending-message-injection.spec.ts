/**
 * Pending Message Injection — Behavioral Test
 *
 * When a user sends a message while the session is mid-turn (actively working),
 * it joins the queue shown above the composer, which opens to the message
 * itself, until Claude picks it up. When consumption is detected (thinking block or
 * turn:end), the pending card disappears and the message appears inline in the
 * conversation flow, placed immediately before the consuming response.
 *
 * Uses the mid-turn-injection cassette which has:
 *   - Initial prompt → thinking → Glob tools → results
 *   - Stdin injection at ts=9494 ("Actually, skip the protocol directory")
 *   - In-flight Read tool calls continue (ts=15888-23247)
 *   - Consumption thinking block at ts=28994
 *   - Final text response at ts=45665
 *
 * Regression test for: mid-turn messages dumping straight into the stream
 * at the wrong position instead of showing as pending then placing correctly.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

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

/** Inject a message directly via the harness API, bypassing the Composer UI.
 *  Use this for mid-turn injection since the Composer may show stop button during streaming. */
async function injectMessage(conversationId: string, text: string, attachments?: unknown[]) {
  const resp = await fetch(`${BASE_URL}/api/harness/${conversationId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, ...(attachments ? { attachments } : {}) }),
  });
  if (!resp.ok) throw new Error(`inject failed: ${await resp.text()}`);
}

async function setScenario(scenario: string) {
  const resp = await fetch(`${BASE_URL}/api/test/set-scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  if (!resp.ok) throw new Error(`set-scenario failed: ${await resp.text()}`);
}

test.describe('Pending Message Injection', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('mid-turn injection shows as pending then places on consumption', async ({ page }) => {
    // Use a slower timescale so we can observe the pending state
    await setCassette('mid-turn-injection', { timescale: 0.1 });
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    // Send the initial message to start the session
    await sendMessage(page, 'audit the codebase');

    // Wait for the session to connect and cassette to reach the stdin gate
    await page.waitForTimeout(2000);

    // Inject mid-turn via API (Composer shows stop button during streaming)
    await injectMessage(convId, 'Actually, skip the protocol directory — just focus on src/server/ files.');

    // After sending mid-turn, the message floats faded above the composer.
    const pendingMessage = page.getByTestId('pending-message');
    await expect(pendingMessage).toBeVisible({ timeout: 30000 });

    // The pending message should contain the injected text
    await expect(pendingMessage).toContainText('skip the protocol directory');

    // Wait for the consumption thinking block to arrive. After that,
    // the pending card should disappear and the message should be
    // placed inline in the conversation.
    await expect(pendingMessage).not.toBeVisible({ timeout: 30000 });

    // The user message should now be visible inline in the conversation,
    // placed before the thinking/response that consumed it.
    const userMessages = page.locator('[data-testid="user-message"]');
    await expect(userMessages).toHaveCount(2, { timeout: 10000 });

    // One of the user messages should contain the injection text.
    // (DOM order may differ from visual order due to flex-col-reverse.)
    const allTexts = await userMessages.allInnerTexts();
    const hasInjection = allTexts.some(t => t.includes('skip the protocol directory'));
    expect(hasInjection, `Expected injection text in user messages`).toBe(true);
  });

  test('pending message does not appear at wrong position in stream', async ({ page }) => {
    // Timescale 0.1 (matching the sibling test), because the injection below
    // must land inside a real window: after the cassette passes its initial
    // stdin gate, before the consumption thinking block at ts=28994 plays.
    await setCassette('mid-turn-injection', { timescale: 0.1 });
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    await sendMessage(page, 'audit the codebase');

    // Inject only once assistant output is visible — the one observable that
    // proves the session spawned and playback passed the initial stdin gate.
    // A fixed sleep here (the previous shape) raced CPU load both ways: too
    // early and the session hadn't spawned, too late and the consumption
    // event had already played; under full-suite load it timed out on READY.
    await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 30000 });
    await injectMessage(convId, 'Actually, skip the protocol directory — just focus on src/server/ files.');

    // Wait for session to finish
    await expect(page.getByText('READY')).toBeVisible({ timeout: 60000 });

    // After session completes, the injected user message should be placed
    // BEFORE the thinking/response that consumed it, not in the middle
    // of tool call results.
    const userMessages = page.locator('[data-testid="user-message"]');
    const messageCount = await userMessages.count();
    expect(messageCount).toBe(2);

    // One of the user messages should contain the injection text
    const allTexts = await userMessages.allInnerTexts();
    const hasInjection = allTexts.some(t => t.includes('skip the protocol directory'));
    expect(hasInjection, 'Injection message should appear inline').toBe(true);

    // The injection message should have a bounding box (is rendered and visible)
    const injectionIdx = allTexts.findIndex(t => t.includes('skip the protocol directory'));
    const injectedBoundingBox = await userMessages.nth(injectionIdx).boundingBox();
    expect(injectedBoundingBox).toBeTruthy();
  });

  test('injection consumed by text response (no thinking) appears before that response', async ({ page }) => {
    // Regression: when Claude responds to an injection with text but no thinking
    // block, the injection was placed at turn:end (after the response) instead of
    // before the text content that acknowledges it.
    await setScenario('injection-text-only-response');
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    // Send initial message to start the session
    await sendMessage(page, 'start the search');

    // Wait for session to start and reach the tool use phase (insideTurn = true).
    // The scenario has a 3000ms delay after tool_use before the text response.
    await page.waitForTimeout(1500);

    // Inject mid-turn via API
    await injectMessage(convId, 'try a different approach');

    // The message floats faded above the composer until it is taken in.
    const pendingMessage = page.getByTestId('pending-message');
    await expect(pendingMessage).toBeVisible({ timeout: 15000 });
    await expect(pendingMessage).toContainText('try a different approach');

    // After the text response arrives (consumption), pending card should disappear
    await expect(pendingMessage).not.toBeVisible({ timeout: 30000 });

    // Wait for session to finish
    const composerInput = page.getByTestId('composer-input');
    await expect(composerInput).toBeVisible({ timeout: 30000 });

    // The injected user message should now be inline in the conversation
    const userMessages = page.locator('[data-testid="user-message"]');
    await expect(userMessages).toHaveCount(2, { timeout: 10000 });

    // The assistant response that consumed the injection should also be visible
    const assistantMessages = page.locator('[data-testid="assistant-message"]');
    const assistantCount = await assistantMessages.count();
    expect(assistantCount).toBeGreaterThanOrEqual(1);

    // KEY ASSERTION: the injected user message must appear VISUALLY ABOVE
    // (before in timeline) the assistant's text response.
    // Use bounding box Y coordinates since flex-col-reverse inverts DOM order.
    const injectionTexts = await userMessages.allInnerTexts();
    const injectionIdx = injectionTexts.findIndex(t => t.includes('try a different approach'));
    expect(injectionIdx, 'Injected message should be inline').toBeGreaterThanOrEqual(0);

    const injectionBox = await userMessages.nth(injectionIdx).boundingBox();
    expect(injectionBox, 'Injected message should be rendered').toBeTruthy();

    // Find the assistant message containing the response to the injection
    const assistantTexts = await assistantMessages.allInnerTexts();
    const responseIdx = assistantTexts.findIndex(t => t.includes('switching to that approach'));
    expect(responseIdx, 'Response message should exist').toBeGreaterThanOrEqual(0);

    const responseBox = await assistantMessages.nth(responseIdx).boundingBox();
    expect(responseBox, 'Response message should be rendered').toBeTruthy();

    // In a top-to-bottom chat, earlier messages have smaller Y values.
    // The injected message should be ABOVE (smaller Y) the response.
    expect(
      injectionBox!.y,
      `Injected message (y=${injectionBox!.y}) should appear above response (y=${responseBox!.y})`
    ).toBeLessThan(responseBox!.y);
  });

  test('an image sent mid-turn shows while it waits, once taken in, and after reload', async ({ page }) => {
    // Regression: the waiting bubble and the placed message were drawn from
    // the inbox's queued event, which carried only the text, so the user's
    // screenshot went missing from their own view of a mid-turn message.
    const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await setScenario('injection-text-only-response');
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);
    await sendMessage(page, 'start the search');
    await page.waitForTimeout(1500);

    await injectMessage(convId, 'see this screenshot', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: onePixelPng } },
    ]);

    const pendingMessage = page.getByTestId('pending-message');
    await expect(pendingMessage).toContainText('see this screenshot', { timeout: 15000 });
    await expect(pendingMessage.locator('img[alt="Attached"]')).toHaveCount(1);

    await expect(pendingMessage).not.toBeVisible({ timeout: 30000 });
    const placed = page.locator('[data-testid="user-message"]', { hasText: 'see this screenshot' });
    await expect(placed.locator('img[alt="Attached"]')).toHaveCount(1);

    await page.reload();
    await expect(placed.locator('img[alt="Attached"]')).toHaveCount(1, { timeout: 15000 });
  });
});
