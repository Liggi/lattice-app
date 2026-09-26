/**
 * Parallel Agents Flat Rendering — Behavioral Test
 *
 * When Claude spawns multiple Agent subagents simultaneously (parallel tool
 * calls in a single model turn), they must render as sibling cards at the
 * same level — not nested inside each other.
 *
 * Uses a real cassette recording of a Claude CLI session that launches 3
 * parallel Explore agents. The cassette replays through the full harness
 * pipeline (CassetteAdapter → normalizeClaude → EventLog → SSE → frontend).
 *
 * Regression test for: parallel agents nesting bug where LIFO stack model
 * in extractSubagentChildren incorrectly nests parallel agents because
 * detection only worked after results arrived (not during streaming).
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
  if (!resp.ok) {
    throw new Error(`set-cassette failed: ${await resp.text()}`);
  }
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

test.describe('Parallel Agents Rendering', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('parallel Agent tasks render flat, not nested inside each other', async ({ page }) => {
    // Use the real parallel-agents cassette (3 Explore agents launched simultaneously)
    await setCassette('parallel-agents');

    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    // Trigger session start — the CassetteAdapter replays the recorded CLI session
    await sendMessage(page, 'explore directories');

    // Wait for all 3 Agent tool cards to appear in the DOM.
    // The cassette has agents opening at ~7-9s (real time), but with 0.05x
    // timescale they appear in ~350-460ms.
    const agentCards = page.locator('[data-testid="tool-Agent"]');
    await expect(agentCards).toHaveCount(3, { timeout: 15000 });

    // CORE ASSERTION: no Agent card should be nested inside another Agent card.
    // With the nesting bug, Agent 2 renders inside Agent 1's children, and
    // Agent 3 inside Agent 2 — producing a nested DOM tree:
    //   tool-Agent > ... > tool-Agent > ... > tool-Agent
    // When fixed, all 3 are siblings at the same message level.
    const nestedAgents = page.locator('[data-testid="tool-Agent"] [data-testid="tool-Agent"]');
    expect(await nestedAgents.count()).toBe(0);

    // Verify all 3 task descriptions are present (confirms correct cassette replay)
    await expect(page.getByText('List exported functions in protocol/')).toBeVisible();
    await expect(page.getByText('List exported functions in server/')).toBeVisible();
    await expect(page.getByText('List exported functions in client/')).toBeVisible();
  });
});
