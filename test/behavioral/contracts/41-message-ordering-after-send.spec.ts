/**
 * Message Ordering After Send — Behavioral Test
 *
 * When a user sends a follow-up message after a response completes, the new
 * message must appear AFTER the previous response in the conversation — both
 * in the data model (event seq order) and in the visual DOM.
 *
 * Regression test for: user message appearing ABOVE the most recent
 * thinking block and response instead of below it. Refresh fixes the
 * ordering (server-side storage is correct), pointing to a client-side
 * event ordering or rendering issue.
 *
 * Uses the `send-after-response` scenario which has:
 *   - Initial prompt → thinking → text response → result (500ms delay before result)
 *   - Follow-up stdin → thinking → text response → result
 *
 * The 500ms gap before the result event creates a window where the follow-up
 * send can race with the result event — exercising the pipeEvents/send race
 * in session-manager.ts.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

async function resetServer() {
  await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
}

async function setScenario(scenario: string) {
  const resp = await fetch(`${BASE_URL}/api/test/set-scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  if (!resp.ok) throw new Error(`set-scenario failed: ${await resp.text()}`);
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

/** Wait for the session to reach idle state (turn complete). */
async function waitForIdle(page: Page, timeoutMs = 15000) {
  // The composer input becomes enabled and the send button is visible
  // when the session is idle. Wait for the assistant response text to
  // appear, which signals the turn is complete.
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: timeoutMs });
}

/**
 * Get all visible message elements in visual order (top to bottom).
 * The MessageList uses flex-col-reverse, so DOM order is reversed.
 * We read bounding boxes to get true visual order.
 */
async function getMessagesInVisualOrder(page: Page): Promise<Array<{
  id: string;
  type: 'user' | 'assistant' | 'group' | 'unknown';
  text: string;
  y: number;
}>> {
  const elements = await page.locator('[data-message-id]').all();
  const messages: Array<{ id: string; type: 'user' | 'assistant' | 'group' | 'unknown'; text: string; y: number }> = [];

  for (const el of elements) {
    const id = await el.getAttribute('data-message-id') ?? '';
    const box = await el.boundingBox();
    if (!box) continue;

    const text = await el.innerText();

    // Determine message type from content
    const hasUserTestId = await el.locator('[data-testid="user-message"]').count() > 0;
    const hasAssistantTestId = await el.locator('[data-testid="assistant-message"]').count() > 0;

    let type: 'user' | 'assistant' | 'group' | 'unknown' = 'unknown';
    if (hasUserTestId) type = 'user';
    else if (hasAssistantTestId) type = 'assistant';

    messages.push({ id, type, text, y: box.y });
  }

  // Sort by Y coordinate (top to bottom = oldest to newest)
  messages.sort((a, b) => a.y - b.y);
  return messages;
}

test.describe('Message Ordering After Send', () => {
  test.beforeEach(async () => {
    await resetServer();
    await setScenario('send-after-response');
  });

  test('follow-up message appears after first response, not before it', async ({ page }) => {
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    // Send the initial message
    await sendMessage(page, 'What is the answer?');

    // Wait for the first response to appear
    await expect(page.getByText('Here is my first response')).toBeVisible({ timeout: 15000 });

    // Wait for the session to return to idle (turn:end processed)
    await waitForIdle(page);

    // Send a follow-up message
    await sendMessage(page, 'Can you elaborate?');

    // Wait for the second response to appear
    await expect(page.getByText('Here is my second response')).toBeVisible({ timeout: 15000 });

    // Now verify the visual ordering is correct.
    // Expected order (top to bottom):
    //   1. User: "What is the answer?"
    //   2. Assistant: thinking + "Here is my first response"
    //   3. User: "Can you elaborate?"
    //   4. Assistant: thinking + "Here is my second response"
    const messages = await getMessagesInVisualOrder(page);

    // Find the key messages by content
    const firstUserMsg = messages.find(m => m.type === 'user' && m.text.includes('What is the answer'));
    const firstResponse = messages.find(m => m.type === 'assistant' && m.text.includes('first response'));
    const secondUserMsg = messages.find(m => m.type === 'user' && m.text.includes('Can you elaborate'));
    const secondResponse = messages.find(m => m.type === 'assistant' && m.text.includes('second response'));

    expect(firstUserMsg, 'First user message should be visible').toBeTruthy();
    expect(firstResponse, 'First assistant response should be visible').toBeTruthy();
    expect(secondUserMsg, 'Second user message should be visible').toBeTruthy();
    expect(secondResponse, 'Second assistant response should be visible').toBeTruthy();

    // THE KEY ASSERTIONS: visual ordering must be correct
    expect(
      firstUserMsg!.y,
      `First user message (y=${firstUserMsg!.y}) should be above first response (y=${firstResponse!.y})`,
    ).toBeLessThan(firstResponse!.y);

    expect(
      firstResponse!.y,
      `First response (y=${firstResponse!.y}) should be above second user message (y=${secondUserMsg!.y})`,
    ).toBeLessThan(secondUserMsg!.y);

    expect(
      secondUserMsg!.y,
      `Second user message (y=${secondUserMsg!.y}) should be above second response (y=${secondResponse!.y})`,
    ).toBeLessThan(secondResponse!.y);
  });

  test('rapid follow-up during result delay preserves ordering', async ({ page }) => {
    // This test sends the follow-up IMMEDIATELY after the response text
    // appears, racing with the 500ms delay before the result event.
    // This exercises the pipeEvents/send race in session-manager.ts.
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    // Send the initial message
    await sendMessage(page, 'Quick question');

    // Wait for the response TEXT to appear (but NOT for idle — the result
    // event may not have arrived yet due to the 500ms delay in the scenario)
    await expect(page.getByText('Here is my first response')).toBeVisible({ timeout: 15000 });

    // Send follow-up immediately — don't wait for idle.
    // The composer might not be fully reset yet, so use the API directly.
    const resp = await fetch(`${BASE_URL}/api/harness/${convId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Follow up now' }),
    });
    expect(resp.ok, `send should succeed: ${resp.status}`).toBeTruthy();

    // Wait for the second response
    await expect(page.getByText('Here is my second response')).toBeVisible({ timeout: 15000 });

    // Verify ordering
    const messages = await getMessagesInVisualOrder(page);

    const firstResponse = messages.find(m => m.text.includes('first response'));
    const followUp = messages.find(m => m.type === 'user' && m.text.includes('Follow up now'));

    expect(firstResponse, 'First response should be visible').toBeTruthy();
    expect(followUp, 'Follow-up message should be visible').toBeTruthy();

    // The follow-up must appear AFTER the first response
    expect(
      firstResponse!.y,
      `First response (y=${firstResponse!.y}) should be above follow-up (y=${followUp!.y})`,
    ).toBeLessThan(followUp!.y);
  });

  test('event sequence numbers are monotonically ordered after send', async ({ page }) => {
    // Verify at the data level — not just visual — that event seqs are in order.
    // Fetches the raw event stream from the server after both turns complete.
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    await sendMessage(page, 'First message');
    await expect(page.getByText('Here is my first response')).toBeVisible({ timeout: 15000 });
    await waitForIdle(page);

    await sendMessage(page, 'Second message');
    await expect(page.getByText('Here is my second response')).toBeVisible({ timeout: 15000 });
    await waitForIdle(page);

    // Fetch events from the server's history endpoint
    const historyResp = await fetch(
      `${BASE_URL}/api/harness/${convId}/history?before=${Number.MAX_SAFE_INTEGER}&limit=200`,
    );
    expect(historyResp.ok).toBeTruthy();

    const { events } = (await historyResp.json()) as { events: Array<{ seq: number; type: string; data: unknown }> };
    expect(events.length).toBeGreaterThan(0);

    // Verify seqs are strictly monotonically increasing
    for (let i = 1; i < events.length; i++) {
      expect(
        events[i].seq,
        `Event ${i} (seq=${events[i].seq}, type=${events[i].type}) should have seq > event ${i - 1} (seq=${events[i - 1].seq}, type=${events[i - 1].type})`,
      ).toBeGreaterThan(events[i - 1].seq);
    }

    // Verify the logical ordering: input:sent events should come before their
    // corresponding response events, not after.
    const inputSentIndices = events
      .map((e, i) => (e.type === 'input:sent' ? i : -1))
      .filter(i => i >= 0);

    expect(inputSentIndices.length).toBeGreaterThanOrEqual(2);

    // For each input:sent, the next content event should come after it (higher index)
    for (const inputIdx of inputSentIndices) {
      const nextContent = events.findIndex(
        (e, i) => i > inputIdx && e.type === 'content',
      );
      if (nextContent >= 0) {
        expect(
          nextContent,
          `Content event (index ${nextContent}) should come after input:sent (index ${inputIdx})`,
        ).toBeGreaterThan(inputIdx);
      }
    }

    // No input:sent should appear between two content events from the same turn.
    // Find turn boundaries (turn:end events) and check within each turn.
    let turnStart = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === 'turn:end') {
        const turnEvents = events.slice(turnStart, i + 1);
        const contentIndices = turnEvents
          .map((e, j) => (e.type === 'content' ? j : -1))
          .filter(j => j >= 0);
        const inputIndices = turnEvents
          .map((e, j) => (e.type === 'input:sent' ? j : -1))
          .filter(j => j >= 0);

        // No input:sent should be between the first and last content event of a turn
        if (contentIndices.length >= 2) {
          const firstContent = contentIndices[0];
          const lastContent = contentIndices[contentIndices.length - 1];
          for (const inputIdx of inputIndices) {
            const isInterleaved = inputIdx > firstContent && inputIdx < lastContent;
            expect(
              isInterleaved,
              `input:sent (turn-relative index ${inputIdx}) should not be interleaved between content events (${firstContent}..${lastContent}) within a turn`,
            ).toBe(false);
          }
        }

        turnStart = i + 1;
      }
    }
  });
});
