/**
 * Streaming Scroll Anchor — Behavioral Contract
 *
 * A reader who scrolls into history during an active response must keep the
 * same text under their eyes while the live message grows below the viewport.
 * MessageList uses a reversed flex column, so preserving only the numeric
 * scrollTop is insufficient: the browser must compensate for height changes
 * at the live edge.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

async function resetServer() {
  await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
}

async function setScenario(scenario: string) {
  const response = await fetch(`${BASE_URL}/api/test/set-scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  if (!response.ok) throw new Error(`set-scenario failed: ${await response.text()}`);
}

async function seedConversation(): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/test/seed-conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude' }),
  });
  const data = (await response.json()) as { conversationId: string };
  return data.conversationId;
}

async function injectMessage(sessionId: string, role: 'user' | 'assistant', content: string) {
  const response = await fetch(`${BASE_URL}/api/test/inject-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, role, content }),
  });
  if (!response.ok) throw new Error(`inject-message failed: ${await response.text()}`);
}

async function sendMessage(page: Page, text: string) {
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible({ timeout: 15000 });
  await composer.fill(text);
  await page.getByTestId('send-button').click();
}

test.describe('Streaming scroll anchor', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('keeps historical text fixed while the live response grows', async ({ page }) => {
    await setScenario('streaming-scroll-growth');
    const conversationId = await seedConversation();

    await injectMessage(
      conversationId,
      'assistant',
      `OLDER CONTEXT. ${'This is historical filler above the reading position. '.repeat(45)}`,
    );
    await injectMessage(conversationId, 'user', 'What part should I keep reading?');
    await injectMessage(
      conversationId,
      'assistant',
      `READING ANCHOR. ${'This sentence is the text the reader wants to keep in place. '.repeat(35)}`,
    );
    await injectMessage(conversationId, 'user', 'A more recent historical question');
    await injectMessage(
      conversationId,
      'assistant',
      `RECENT CONTEXT. ${'This is historical filler below the reading position. '.repeat(45)}`,
    );

    await page.goto(`/c/${conversationId}`);
    await sendMessage(page, 'Stream a long response');

    await expect(page.getByText('FIRST STREAM BLOCK')).toBeVisible({ timeout: 15000 });

    const anchor = page.getByTestId('assistant-message').filter({ hasText: 'READING ANCHOR' });
    await expect(anchor).toBeVisible();
    await anchor.evaluate((element) => {
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
    });

    const messageList = page.getByTestId('message-list');
    await expect.poll(() => messageList.evaluate((element) => element.scrollTop)).toBeLessThan(-96);
    await expect(page.getByTestId('jump-to-latest')).toBeVisible();

    const before = await anchor.boundingBox();
    expect(before).not.toBeNull();

    await expect(page.getByText('FINAL STREAM BLOCK')).toBeVisible({ timeout: 15000 });

    const after = await anchor.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  });
});
