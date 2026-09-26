/**
 * Parallel Agent Children Attribution — Behavioral Test
 *
 * When Claude spawns multiple parallel agents, each agent's child tool calls
 * must render inside the correct agent card — not flattened to the top level.
 *
 * Uses the parent_tool_use_id field from the CLI to attribute events.
 * Replays the parallel-agents cassette (3 Explore agents with tool calls).
 *
 * Regression test for: parallel agent events flattening to top level because
 * extractSubagentChildren couldn't disambiguate interleaved events without
 * explicit parent_tool_use_id.
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

test.describe('Parallel Agent Children Attribution', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('each parallel agent card contains its own child tool calls', async ({ page }) => {
    await setCassette('parallel-agents');
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    await sendMessage(page, 'explore directories');

    // Wait for all 3 Agent cards to appear
    const agentCards = page.locator('[data-testid="tool-Agent"]');
    await expect(agentCards).toHaveCount(3, { timeout: 15000 });

    // Wait for session to reach idle (all events replayed)
    await expect(page.getByText('READY')).toBeVisible({ timeout: 30000 });

    // Each agent card should contain child tool calls (Grep, Read, Glob, Bash).
    // With the old flattened behavior, agent cards had zero children and all
    // tool calls rendered at the top level.
    for (let i = 0; i < 3; i++) {
      const card = agentCards.nth(i);

      // Click to expand if collapsed
      const trigger = card.locator('button').first();
      const isExpanded = await card.locator('[class*="space-y-1"]').isVisible().catch(() => false);
      if (!isExpanded) {
        await trigger.click();
      }

      // Each agent should have at least one child tool call inside it
      const childTools = card.locator(
        '[data-testid="tool-Grep"], [data-testid="tool-Read"], [data-testid="tool-Glob"], [data-testid="tool-Bash"]'
      );
      const childCount = await childTools.count();
      expect(childCount, `Agent ${i} should have child tool calls`).toBeGreaterThan(0);
    }
  });

  test('top level has no orphaned tool calls from agent children', async ({ page }) => {
    await setCassette('parallel-agents');
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    await sendMessage(page, 'explore directories');

    // Wait for session to finish
    await expect(page.getByText('READY')).toBeVisible({ timeout: 30000 });

    // Tool calls that belong to agents should NOT appear at the top level.
    // At the top level we expect: the 3 Agent cards + the final text response.
    // We should NOT see bare Read/Grep/Glob/Bash cards that aren't inside an agent.
    //
    // Strategy: count tool calls at the top message level (direct children of
    // the message list, not nested inside agent cards).
    const topLevelGreps = page.locator(
      ':not([data-testid="tool-Agent"]) > [data-testid="tool-Grep"]'
    );
    // This selector finds Grep cards that are NOT direct children of an Agent card.
    // With proper nesting, there should be zero orphaned search tools at top level.
    // Note: CSS child combinator can't express "not a descendant", so we check
    // that the total Grep count equals the count inside agent cards.
    const totalGreps = await page.locator('[data-testid="tool-Grep"]').count();
    const grepsInsideAgents = await page.locator('[data-testid="tool-Agent"] [data-testid="tool-Grep"]').count();

    expect(grepsInsideAgents, 'All Grep calls should be inside agent cards').toBe(totalGreps);
  });
});
