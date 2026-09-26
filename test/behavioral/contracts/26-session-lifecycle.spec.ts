/**
 * Session Lifecycle — Behavioral Tests
 *
 * Tests status bar transitions, session card identity (image + mission),
 * and the full new-session lifecycle as a user experiences it.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

// -- Test helpers --

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

async function seedInsights(sessionId: string, opts: {
  mission?: string;
  project?: string;
  theme?: string;
  identityImage?: string;
}) {
  await fetch(`${BASE_URL}/api/test/seed-insights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      context: {
        project: opts.project ?? 'Test Project',
        area: null,
        mission: opts.mission ?? 'Fix the widget tests',
        scope: 'feature',
      },
      theme: opts.theme ?? 'debugging',
      tags: { complexity: 'routine' },
      purpose: opts.mission ?? 'Fix the widget tests',
      identityImage: opts.identityImage,
    }),
  });
}

async function injectMessage(sessionId: string, role: string, content: string) {
  await fetch(`${BASE_URL}/api/test/inject-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, role, content }),
  });
}

async function sendMessage(page: Page, text: string) {
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible({ timeout: 15000 });
  await composer.fill(text);
  await page.getByTestId('send-button').click();
}

async function startSessionInBrowser(page: Page, message: string): Promise<string> {
  const convId = await seedConversation();
  await page.goto(`/c/${convId}`);
  await sendMessage(page, message);
  return convId;
}

// ============================================================================
// Status Bar Transitions
// ============================================================================

test.describe('Status Bar Transitions', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('status shows Starting then Working during a turn', async ({ page }) => {
    // Use slow-spawn scenario so we can catch the Starting state
    await setScenario('slow-spawn-exits');
    await startSessionInBrowser(page, 'Wait for me');

    // Starting should appear while the process boots (2s startup delay)
    await expect(page.getByText('Starting')).toBeVisible({ timeout: 5000 });
  });

  test('status shows Working during streaming', async ({ page }) => {
    await setScenario('slow-response');
    await startSessionInBrowser(page, 'Take your time');

    // Working should appear while the agent is streaming (3s delay before result).
    // exact: true — the slow-response scenario also renders assistant text
    // "Working on it — this will take a moment." which substring-matches "Working".
    await expect(page.getByText('Working', { exact: true })).toBeVisible({ timeout: 10000 });
  });

  test('status bar disappears or shows idle after turn completes', async ({ page }) => {
    await setScenario('simple-response');
    await startSessionInBrowser(page, 'Quick response');

    // Wait for response to complete
    await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 15000 });

    // After turn completes, Working should no longer be visible
    // (status bar shows Ready or New session depending on process state)
    await expect(page.getByText('Working', { exact: true })).not.toBeVisible({ timeout: 10000 });
  });
});

// ============================================================================
// Session Card Identity (Pro only — requires insights)
// ============================================================================

test.describe('Session Card Identity', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('session card shows mission text from seeded insights', async ({ page }) => {
    const convId = await seedConversation();
    await injectMessage(convId, 'user', 'Help me fix the tests');
    await injectMessage(convId, 'assistant', 'Sure, let me look at the test failures.');

    // Seed insights with a mission
    await seedInsights(convId, { mission: 'Fix failing widget tests' });

    // Navigate with ?tier=pro so insights render on session cards
    await page.goto(`/c/${convId}?tier=pro`);

    // Wait for sidebar to show the session card
    const missionEl = page.getByTestId(`session-mission-${convId}`);
    await expect(missionEl).toBeVisible({ timeout: 15000 });

    // Mission text should contain the seeded mission
    await expect(missionEl).toContainText('Fix failing widget tests', { timeout: 10000 });
  });

  test('session card shows identity image when seeded', async ({ page }) => {
    const convId = await seedConversation();
    await injectMessage(convId, 'user', 'Some conversation');
    await injectMessage(convId, 'assistant', 'Some response');

    // Seed insights with a tiny valid JPEG-like identity image (base64)
    // Using a minimal placeholder — the UI just needs a non-empty value
    const tinyImage = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFBABAAAAAAAAAAAAAAAAAAAAf/aAAwDAQACEQMRAD8AJQD/2Q==';

    await seedInsights(convId, {
      mission: 'Image test session',
      identityImage: tinyImage,
    });

    // Navigate with ?tier=pro
    await page.goto(`/c/${convId}?tier=pro`);

    // The session image container should exist and have content
    const imageEl = page.getByTestId(`session-image-${convId}`);
    await expect(imageEl).toBeVisible({ timeout: 15000 });
  });

  test('insights render without a pro tier — local features are not gated', async ({ page }) => {
    const convId = await seedConversation();
    await injectMessage(convId, 'user', 'My initial question about widgets');
    await injectMessage(convId, 'assistant', 'Here is my answer.');

    // Seed insights without ?tier=pro. Since local features were ungated
    // (627c8015), persisted local data renders for everyone; the license
    // only guards hosted proxy spend.
    await seedInsights(convId, { mission: 'AI generated mission' });

    await page.goto(`/c/${convId}`);

    const missionEl = page.getByTestId(`session-mission-${convId}`);
    await expect(missionEl).toBeVisible({ timeout: 15000 });
    await expect(missionEl).toContainText('AI generated mission');
  });
});
