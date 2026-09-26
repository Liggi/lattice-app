/**
 * Non-Adjacent Content Coalescing — Behavioral Test
 *
 * Regression test for duplicate assistant messages.
 *
 * Root cause: the SDK adapter emits multiple `content` events that share one
 * messageId but are NON-adjacent — a tool_use round-trip (assistant tool_use +
 * user tool_result → a `result` event) sits between the two content fragments.
 * useHarnessSession coalesced content only when the fragments were adjacent in
 * the event list, so the second fragment rendered as a separate duplicate
 * assistant message. Production evidence: 12,131 DuplicateMessageDetector
 * warnings in server.log.
 *
 * Fix: coalesce `content` by messageId across the whole list — the later
 * fragment merges into the first occurrence's rendered message, preserving
 * intra-message block order.
 *
 * Assertion: the two fragments (FRAGMENT_ALPHA, FRAGMENT_BRAVO) that share
 * message.id "msg_shared" render as exactly ONE assistant message containing
 * both.
 */

import { test, expect, type Page } from '@playwright/test';

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
  const data = (await resp.json()) as { conversationId: string };
  return data.conversationId;
}

async function sendMessage(page: Page, text: string) {
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible({ timeout: 15000 });
  await composer.fill(text);
  await page.getByTestId('send-button').click();
}

test.describe('Non-adjacent content coalescing', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('non-adjacent content fragments sharing a messageId render as one assistant message', async ({
    page,
  }) => {
    await setScenario('non-adjacent-content-same-messageid');
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);
    await sendMessage(page, 'Trigger the split response');

    // Both fragments must be visible...
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'FRAGMENT_ALPHA' }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'FRAGMENT_BRAVO' }),
    ).toBeVisible({ timeout: 15000 });

    // ...and they must live in the SAME assistant message. With the bug, the
    // second fragment renders as a separate duplicate — two assistant messages,
    // one per fragment. After the fix there is exactly one.
    await expect(page.getByTestId('assistant-message')).toHaveCount(1);

    const both = page
      .getByTestId('assistant-message')
      .filter({ hasText: 'FRAGMENT_ALPHA' })
      .filter({ hasText: 'FRAGMENT_BRAVO' });
    await expect(both).toHaveCount(1);
  });
});
