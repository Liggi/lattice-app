/**
 * Plan Mode — Behavioral Test
 *
 * When Claude enters plan mode and submits a plan via ExitPlanMode, the tool
 * result arrives with `is_error: true` and content "Exit plan mode?". This
 * is the CLI's way of requesting user approval.
 *
 * The frontend should:
 * 1. NOT render an EnterPlanMode card (it's an internal mode switch)
 * 2. Render ExitPlanMode as a PlanTool card with plan content (markdown)
 * 3. Show "Awaiting approval" status + Approve/Reject buttons
 * 4. On approval, resume the conversation so Claude can execute the plan
 *
 * Uses a real cassette recording of a Claude CLI plan mode session:
 *   - Initial prompt → exploration → EnterPlanMode → read-only work
 *   - ExitPlanMode with plan markdown + is_error:true → turn complete
 *   - stdin gate (approval) — cassette pauses here
 *   - Approval → new turn → Claude executes Write tools
 *
 * The cassette was recorded WITHOUT ASK mode, so plan approval goes through
 * the PlanTool inline buttons (not the PermissionBanner flow).
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

test.describe('Plan Mode', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('ExitPlanMode renders as PlanTool with plan content and approval buttons', async ({ page }) => {
    // Use a moderate timescale — plan mode has many events (~45 entries)
    // but we need the UI to settle before interacting
    await setCassette('plan-mode', { timescale: 0.05 });

    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    // Trigger session — cassette replays the recorded plan mode session
    await sendMessage(page, 'plan the refactor');

    // Wait for the ExitPlanMode tool card to appear.
    // The cassette has ExitPlanMode at ~77s (real time), at 0.05x = ~3.8s
    const planCard = page.locator('[data-testid="tool-ExitPlanMode"]');
    await expect(planCard).toBeVisible({ timeout: 30000 });

    // EnterPlanMode should NOT render visible content (ToolContent returns null,
    // but the ToolUseRenderer wrapper div still exists in the DOM — just empty)
    const enterPlanCard = page.locator('[data-testid="tool-EnterPlanMode"]');
    const enterContent = await enterPlanCard.textContent();
    expect(enterContent?.trim() || '').toBe('');

    // The PlanTool card should contain plan content from input.plan
    // The cassette's plan has structured steps
    await expect(planCard.getByText('Plan', { exact: false }).first()).toBeVisible({ timeout: 5000 });

    // Status should show "Awaiting approval" (isPendingApproval = true because is_error)
    await expect(planCard.getByText('Awaiting approval')).toBeVisible();

    // Approve and Reject buttons should be visible
    await expect(planCard.getByRole('button', { name: /Approve/i })).toBeVisible();
    await expect(planCard.getByRole('button', { name: /Reject/i })).toBeVisible();
  });

  test('clicking Approve resumes the session and hides approval buttons', async ({ page }) => {
    await setCassette('plan-mode', { timescale: 0.05 });
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    await sendMessage(page, 'plan the refactor');

    // Wait for plan card with approval buttons
    const planCard = page.locator('[data-testid="tool-ExitPlanMode"]');
    await expect(planCard).toBeVisible({ timeout: 30000 });
    const approveBtn = planCard.getByRole('button', { name: /Approve/i });
    await expect(approveBtn).toBeVisible({ timeout: 5000 });

    // Click approve — this fires onPlanApprove → api.resumeConversation()
    // which sends input to the harness → unblocks the cassette stdin gate
    await approveBtn.click();

    // After clicking, the buttons should disappear (PlanTool internal state
    // transitions to approvalState='approved')
    await expect(approveBtn).not.toBeVisible({ timeout: 5000 });

    // Status should change to "Implementation plan" (approved state)
    await expect(planCard.getByText('Implementation plan')).toBeVisible({ timeout: 5000 });

    // The session should resume — cassette continues with Claude executing
    // Write tools (creating accents.ts, updating tokens.ts).
    // Wait for any Write tool card to appear as proof the session continued.
    const writeCard = page.locator('[data-testid="tool-Write"]');
    await expect(writeCard.first()).toBeVisible({ timeout: 30000 });
  });

  test('plan content renders as markdown with proper structure', async ({ page }) => {
    await setCassette('plan-mode', { timescale: 0.05 });
    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    await sendMessage(page, 'plan the refactor');

    const planCard = page.locator('[data-testid="tool-ExitPlanMode"]');
    await expect(planCard).toBeVisible({ timeout: 30000 });

    // The plan markdown should render structured content. The cassette's
    // expanded plan body has h1/h2 headings ("Plan: …", "Context",
    // "Approach", …) and inline code for file/identifier names. Heading +
    // code presence is the load-bearing assertion — proves react-markdown
    // rendered, not raw text.
    await expect(planCard.getByRole('heading', { name: /^Context$/ })).toBeVisible({ timeout: 5000 });
    await expect(planCard.getByRole('heading', { name: /^Approach$/ })).toBeVisible({ timeout: 5000 });

    const headings = planCard.locator('h1, h2, h3');
    expect(await headings.count()).toBeGreaterThan(0);

    const codeBlocks = planCard.locator('code');
    expect(await codeBlocks.count()).toBeGreaterThan(0);
  });
});
