import { test, expect } from '@playwright/experimental-ct-react';
import { ScrollHarness, VisualHarness, TeamColorHarness } from './fixtures/TaskToolHarness';

// ── SUBAGENT_VISUALS ──

test.describe('subagent visual identity', () => {
  test('Explore agent shows "Explorer" label and blue tint', async ({ mount }) => {
    const component = await mount(<VisualHarness subagentType="Explore" />);
    await expect(component.getByText('Explorer')).toBeVisible();
    await expect(component.getByText('Explore', { exact: true })).toBeVisible(); // agent type badge
    // Blue tint applied to card
    const card = component.locator('[class*="border-blue"]');
    await expect(card).toBeVisible();
  });

  test('Plan agent shows "Architect" label and amber tint', async ({ mount }) => {
    const component = await mount(<VisualHarness subagentType="Plan" />);
    await expect(component.getByText('Architect')).toBeVisible();
    await expect(component.getByText('Plan')).toBeVisible();
    const card = component.locator('[class*="border-amber"]');
    await expect(card).toBeVisible();
  });

  test('code-reviewer agent shows "Reviewer" label and purple tint', async ({ mount }) => {
    const component = await mount(<VisualHarness subagentType="code-reviewer" />);
    await expect(component.getByText('Reviewer', { exact: true })).toBeVisible();
    await expect(component.getByText('code-reviewer')).toBeVisible();
    const card = component.locator('[class*="border-purple"]');
    await expect(card).toBeVisible();
  });

  test('statusline-setup agent shows "Config" label and green tint', async ({ mount }) => {
    const component = await mount(<VisualHarness subagentType="statusline-setup" />);
    await expect(component.getByText('Config')).toBeVisible();
    await expect(component.getByText('statusline-setup')).toBeVisible();
    const card = component.locator('[class*="border-green"]');
    await expect(card).toBeVisible();
  });

  test('unknown agent type shows "Agent" label with purple tint', async ({ mount }) => {
    const component = await mount(<VisualHarness subagentType="some-custom-agent" />);
    await expect(component.getByText('Agent', { exact: true })).toBeVisible();
    await expect(component.getByText('some-custom-agent')).toBeVisible();
    const card = component.locator('[class*="border-purple"]');
    await expect(card).toBeVisible();
  });

  test('general-purpose type shows "Agent" label without type badge', async ({ mount }) => {
    const component = await mount(<VisualHarness subagentType="general-purpose" />);
    await expect(component.getByText('Agent')).toBeVisible();
    // "general-purpose" should NOT appear as a badge
    await expect(component.getByText('general-purpose')).not.toBeVisible();
  });

  test('team task shows agent name as label instead of subagent visual label', async ({ mount }) => {
    const component = await mount(
      <VisualHarness subagentType="Explore" teamName="backend-crew" agentName="Cache Agent" />,
    );
    // Team name overrides visual label — shows agent name, not "Explorer"
    await expect(component.getByText('Cache Agent')).toBeVisible();
    await expect(component.getByText('Explorer')).not.toBeVisible();
  });

  test('team task with color override uses team color tint', async ({ mount }) => {
    const component = await mount(<TeamColorHarness />);
    // Team color (green) overrides Explore's default (blue)
    const card = component.locator('[class*="border-green"]');
    await expect(card).toBeVisible();
  });
});

// ── SMART SCROLL ──

test.describe('smart scroll tracking', () => {
  test('auto-scrolls to bottom when children are present', async ({ mount }) => {
    const component = await mount(<ScrollHarness />);

    // The children container should exist and be scrolled near the bottom
    const container = component.locator('.overflow-y-auto');
    await expect(container).toBeVisible();

    // Wait for the smooth scroll animation to complete
    await container.evaluate(el =>
      new Promise<void>(resolve => {
        const check = () => {
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (gap < 10) { resolve(); return; }
          requestAnimationFrame(check);
        };
        // Give the initial effect time to fire
        setTimeout(check, 100);
      }),
    );

    const scrollState = await container.evaluate(el => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    // Should be scrolled to or near the bottom
    const distanceFromBottom = scrollState.scrollHeight - scrollState.scrollTop - scrollState.clientHeight;
    expect(distanceFromBottom).toBeLessThan(10);
  });

  test('adding a child scrolls to bottom when already at bottom', async ({ mount }) => {
    const component = await mount(<ScrollHarness />);
    const container = component.locator('.overflow-y-auto');
    await expect(container).toBeVisible();

    // Wait for initial scroll to settle
    await container.evaluate(el =>
      new Promise<void>(resolve => {
        setTimeout(() => {
          el.scrollTo({ top: el.scrollHeight });
          resolve();
        }, 100);
      }),
    );

    // Get scroll height before adding child
    const beforeHeight = await container.evaluate(el => el.scrollHeight);

    // Add a new child
    await component.getByTestId('add-child').click();

    // Wait for the new child and scroll animation
    await component.getByTestId('child-msg-20').waitFor();
    // Give the smooth scroll time to complete
    await container.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));

    const afterState = await container.evaluate(el => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    // Content grew
    expect(afterState.scrollHeight).toBeGreaterThan(beforeHeight);
    // And we scrolled to follow it
    const distanceFromBottom = afterState.scrollHeight - afterState.scrollTop - afterState.clientHeight;
    expect(distanceFromBottom).toBeLessThan(10);
  });

  test('does NOT auto-scroll when user has scrolled up', async ({ mount }) => {
    const component = await mount(<ScrollHarness />);
    const container = component.locator('.overflow-y-auto');
    await expect(container).toBeVisible();

    // Wait for initial auto-scroll to settle
    await container.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));

    // Scroll up significantly (more than 60px from bottom to trigger the flag)
    await container.evaluate(el => {
      el.scrollTo({ top: 0, behavior: 'instant' });
    });
    // Fire the scroll event handler
    await container.dispatchEvent('scroll');

    // Record the scroll position after scrolling up
    const scrollTopAfterScrollUp = await container.evaluate(el => el.scrollTop);

    // Add a new child
    await component.getByTestId('add-child').click();
    await component.getByTestId('child-msg-20').waitFor();

    // Give any potential auto-scroll time to fire
    await container.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));

    // Scroll position should NOT have changed — user was scrolled up
    const scrollTopAfterAdd = await container.evaluate(el => el.scrollTop);
    expect(scrollTopAfterAdd).toBe(scrollTopAfterScrollUp);
  });
});
