import { test, expect } from '@playwright/experimental-ct-react';
import { ReactionsHarness } from './fixtures/ReactionsHarness';

// ── REACTIONS ──
//
// Clicking a chip or picking an emoji changes only the viewer's own
// reaction: onRemove when they already have it, onAdd otherwise.

const SHARED = [
  { emoji: '👍', count: 2, reactedByMe: true, reactors: [{ id: 'ana', name: 'Ana' }, { id: 'me', name: 'You' }] },
  { emoji: '🎉', count: 3, reactedByMe: false, reactors: [{ id: 'ana', name: 'Ana' }, { id: 'ben', name: 'Ben' }] },
];

test.describe('reactions', () => {
  test('chips show counts and name who reacted', async ({ mount }) => {
    const component = await mount(<ReactionsHarness initial={SHARED} />);
    const chips = component.getByTestId('message-reactions').getByRole('button');
    await expect(chips).toHaveText(['👍2', '🎉3']);
    await expect(chips.nth(0)).toHaveAttribute('aria-label', 'Ana and You reacted with 👍. Click to remove yours.');
    await expect(chips.nth(1)).toHaveAttribute('aria-label', 'Ana, Ben and 1 other reacted with 🎉. Click to add yours.');
  });

  test('clicking a chip removes your own and adds to someone else\'s', async ({ mount }) => {
    const component = await mount(<ReactionsHarness initial={SHARED} />);
    const chips = component.getByTestId('message-reactions').getByRole('button');
    await chips.nth(0).click();
    await chips.nth(1).click();
    await expect(component.getByTestId('calls')).toHaveText('["remove 👍","add 🎉"]');
    await expect(chips).toHaveText(['👍1', '🎉4']);
  });

  test('picking an emoji you already have takes it off', async ({ mount, page }) => {
    const component = await mount(<ReactionsHarness initial={SHARED} />);
    await component.getByTestId('add-reaction').click();
    await expect(page.getByTestId('quick-reactions').getByRole('button', { name: '👍' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('quick-reactions').getByRole('button', { name: '👍' }).click();
    await component.getByTestId('add-reaction').click();
    await page.getByTestId('quick-reactions').getByRole('button', { name: '👀' }).click();
    await expect(component.getByTestId('calls')).toHaveText('["remove 👍","add 👀"]');
  });

  test('the full picker searches the table and Enter picks', async ({ mount, page }) => {
    const component = await mount(<ReactionsHarness initial={[]} />);
    await component.getByTestId('add-reaction').click();
    await page.getByRole('button', { name: /All emoji/ }).click();
    await page.getByLabel('Search emoji').fill('tada');
    // The table is a lazy chunk; Enter picks only once it has results.
    await expect(page.getByTestId('emoji-picker').getByRole('button', { name: 'tada' })).toBeVisible();
    await page.getByLabel('Search emoji').press('Enter');
    await expect(component.getByTestId('calls')).toHaveText('["add 🎉"]');
  });

  test('single-user chips show just the emoji; without handlers they are not buttons', async ({ mount }) => {
    const solo = await mount(<ReactionsHarness singleUser initial={[{ emoji: '👍', count: 1, reactedByMe: true, reactors: [{ id: 'me', name: 'You' }] }]} />);
    await expect(solo.getByTestId('message-reactions').getByRole('button')).toHaveText(['👍']);
    await solo.unmount();
    const shown = await mount(<ReactionsHarness readOnly singleUser initial={[{ emoji: '👀', count: 1, reactedByMe: false, reactors: [{ id: 'agent', name: 'The agent' }] }]} />);
    await expect(shown.getByTestId('message-reactions').getByRole('button')).toHaveCount(0);
    await expect(shown.getByLabel('The agent reacted with 👀')).toHaveText('👀');
  });
});
