import { test, expect } from '@playwright/experimental-ct-react';
import { ComposerMarkdownHarness } from './fixtures/ComposerMarkdownHarness';

// ── COMPOSER_MARKDOWN ──
//
// The text box shows markdown formatted (markers hidden, code blocks drawn)
// but sends exactly what was typed, backticks and all.

const sent = async (component: { getByTestId: (id: string) => { textContent: () => Promise<string | null> } }) =>
  JSON.parse((await component.getByTestId('sent').textContent()) ?? '[]');

test.describe('composer markdown', () => {
  test('sends the typed markdown unchanged', async ({ mount }) => {
    const component = await mount(<ComposerMarkdownHarness />);
    const input = component.getByTestId('composer-input');
    await input.click();
    const text = 'Rename `a` to **b**:\n```ts\nconst a = 1;\n```\nthen *rerun*.';
    await input.page().keyboard.insertText(text);
    await input.press('Enter');
    await expect.poll(() => sent(component)).toEqual([{ text }]);
  });

  test('Shift+Enter breaks the line and Enter sends', async ({ mount }) => {
    const component = await mount(<ComposerMarkdownHarness />);
    const input = component.getByTestId('composer-input');
    await input.pressSequentially('one');
    await input.press('Shift+Enter');
    await input.pressSequentially('two');
    await expect(component.getByTestId('sent')).toHaveText('[]');
    await input.press('Enter');
    await expect.poll(() => sent(component)).toEqual([{ text: 'one\ntwo' }]);
  });

  test('a long paste is sent with its span', async ({ mount }) => {
    const component = await mount(<ComposerMarkdownHarness />);
    const input = component.getByTestId('composer-input');
    await input.pressSequentially('see: ');
    const pasted = Array.from({ length: 9 }, (_, i) => `log line ${i}`).join('\n');
    await input.evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, pasted);
    await input.press('Enter');
    await expect.poll(() => sent(component)).toEqual([
      { text: `see: ${pasted}`, pastes: [{ fromEnd: pasted.length, length: pasted.length }] },
    ]);
  });
});
