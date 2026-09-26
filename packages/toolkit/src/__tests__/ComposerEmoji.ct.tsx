import { test, expect } from '@playwright/experimental-ct-react';
import { ComposerEmojiHarness } from './fixtures/ComposerEmojiHarness';

// ── EMOJI_AUTOCOMPLETE ──
//
// With `searchEmoji`, `:` plus two name characters opens a list. While it is
// open, Enter and Tab pick; Enter sends only once it is closed. A list that
// found nothing never opens, so it cannot swallow Enter.

test.describe('composer :shortcode autocomplete', () => {
  test('Enter picks the highlighted emoji instead of sending', async ({ mount }) => {
    const component = await mount(<ComposerEmojiHarness />);
    const input = component.getByTestId('composer-input');

    await input.pressSequentially('nice :thu');
    await expect(component.locator('[data-autocomplete-item]')).toHaveCount(2);
    await input.press('ArrowDown');
    await input.press('Enter');

    await expect(input).toHaveValue('nice 👎 ');
    await expect(component.getByTestId('sent')).toHaveText('[]');

    await input.press('Enter');
    await expect(component.getByTestId('sent')).toHaveText('["nice 👎"]');
  });

  test('Tab picks too', async ({ mount }) => {
    const component = await mount(<ComposerEmojiHarness />);
    const input = component.getByTestId('composer-input');

    await input.pressSequentially(':ta');
    await input.press('Tab');
    await expect(input).toHaveValue('🎉 ');
  });

  test('a closing colon on an exact name converts it', async ({ mount }) => {
    const component = await mount(<ComposerEmojiHarness />);
    const input = component.getByTestId('composer-input');

    await input.pressSequentially('ship it :tada:');
    await expect(input).toHaveValue('ship it 🎉');
  });

  test('no matches leaves the list closed and Enter sends', async ({ mount }) => {
    const component = await mount(<ComposerEmojiHarness />);
    const input = component.getByTestId('composer-input');

    await input.pressSequentially('at :zz');
    await expect(component.locator('[data-autocomplete-item]')).toHaveCount(0);
    await input.press('Enter');
    await expect(component.getByTestId('sent')).toHaveText('["at :zz"]');
  });

  test('colons inside words and times do not open it', async ({ mount }) => {
    const component = await mount(<ComposerEmojiHarness />);
    const input = component.getByTestId('composer-input');

    await input.pressSequentially('at 10:thu');
    await expect(component.locator('[data-autocomplete-item]')).toHaveCount(0);
  });

  test('insertText writes at the caret and refocuses the input', async ({ mount }) => {
    const component = await mount(<ComposerEmojiHarness />);
    const input = component.getByTestId('composer-input');

    await input.pressSequentially('go now');
    await input.press('Home');
    await component.getByTestId('insert-rocket').click();
    await expect(input).toHaveValue('🚀go now');
    await expect(input).toBeFocused();
  });
});
