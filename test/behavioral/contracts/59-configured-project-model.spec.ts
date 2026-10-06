import { test, expect } from '@playwright/test';

test('a new project displays and launches the configured Codex model', async ({ page }) => {
  await page.route('**/api/config', (route) => route.fulfill({ json: {
    server: { host: '127.0.0.1', port: 4200, defaultWorkingDirectory: '/tmp' },
    interface: { colorScheme: 'dark', language: 'en' },
    coordinator: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
  } }));
  await page.route('**/api/provider-auth/claude/status', (route) => route.fulfill({
    json: { available: true, installed: true, status: { loggedIn: true } },
  }));
  await page.route('**/api/provider-auth/codex/status', (route) => route.fulfill({
    json: { available: true, installed: true, loggedIn: true },
  }));
  // Inspect the actual submission without starting an agent.
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/conv/create', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 503, json: { error: 'Launch intercepted by browser test' } });
  });
  page.on('dialog', (dialog) => { void dialog.dismiss(); });

  await page.goto('/new?coordinator=1');
  await expect(page.getByTestId('new-project-summary')).toHaveText('Coordinator on Sol 6.1');
  await page.getByTestId('composer-input').fill('Check the configured project model');
  await page.getByTestId('composer-input').press('Enter');
  await expect.poll(() => submitted).toMatchObject({
    provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium', coordinator: true,
  });
});
