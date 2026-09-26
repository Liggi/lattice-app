import { test, expect } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

async function resetServer() {
  await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
}

test.describe('Composer session controls', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('Goal occupies the reclaimed action slot, then moves to the status row', async ({ page }) => {
    await page.goto('/new');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 15000 });

    // Claude has no wired Goal protocol in Lattice, so the UI makes no claim
    // that it does. Codex exposes the control when selected.
    await page.getByTestId('provider-option-claude').click();
    await expect(page.getByTestId('goal-action-button')).toHaveCount(0);

    await page.getByTestId('provider-option-codex').click();
    const goalAction = page.getByTestId('goal-action-button');
    await expect(goalAction).toBeVisible();
    await expect(page.getByTitle('Menu')).toHaveCount(0);

    const nextActionTestId = await goalAction.evaluate((element) =>
      element.nextElementSibling?.getAttribute('data-testid'),
    );
    expect(nextActionTestId).toBe('send-button');

    await goalAction.click();
    const goalDialog = page.getByRole('dialog', { name: 'Goal' });
    await expect(goalDialog).toBeVisible();
    await goalDialog.getByLabel('What should the agent keep working toward?').fill(
      'Ship context controls and verify the real UI',
    );
    await goalDialog.getByTestId('goal-save-button').click();

    await expect(goalAction).toHaveCount(0);
    const goalStatus = page.getByTestId('goal-status-badge');
    await expect(goalStatus).toBeVisible();
    await expect(page.getByTestId('composer-status-bar')).toContainText('Goal');
  });
});
