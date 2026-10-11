import { test, expect } from '@playwright/experimental-ct-react';
import { ComposerHeightHarness } from './fixtures/ComposerHeightHarness';

// ── COMPOSER_INPUT_HEIGHT_CAP ──
//
// The text box auto-grows to fit its content but is capped at 8 rows
// (INPUT_MAX_HEIGHT_PX = 198 in Composer.tsx). Beyond that it scrolls.
// The box is an editor; its scrolling element wraps the editable content.

const CAP_PX = 198;

test.describe('composer input auto-grow cap', () => {
  test('stops growing at 8 rows and scrolls the overflow', async ({ mount }) => {
    const component = await mount(<ComposerHeightHarness lines={12} />);
    const input = component.getByTestId('composer-input');
    await expect(input).toBeVisible();

    const box = await input.evaluate((el) => {
      const s = el.closest('.cm-scroller') as HTMLElement;
      return {
        clientHeight: s.clientHeight,
        scrollHeight: s.scrollHeight,
        maxHeight: getComputedStyle(s).maxHeight,
        overflowY: getComputedStyle(s).overflowY,
      };
    });

    // Capped: never taller than the 8-row budget (small tolerance for rounding).
    expect(box.clientHeight).toBeLessThanOrEqual(CAP_PX + 2);
    // Actually grew to the cap rather than staying near one row.
    expect(box.clientHeight).toBeGreaterThan(160);
    // Content overflows and is reachable by scrolling.
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    expect(box.overflowY).toBe('auto');
    expect(box.maxHeight).toBe(`${CAP_PX}px`);
  });

  test('is scrollable to the bottom of the overflowing content', async ({ mount }) => {
    const component = await mount(<ComposerHeightHarness lines={12} />);
    const input = component.getByTestId('composer-input');

    const scrolled = await input.evaluate((el) => {
      const s = el.closest('.cm-scroller') as HTMLElement;
      s.scrollTop = s.scrollHeight;
      return s.scrollTop;
    });

    expect(scrolled).toBeGreaterThan(0);
  });

  test('shrinks back down when the content becomes short again', async ({ mount }) => {
    const component = await mount(<ComposerHeightHarness lines={12} />);
    const input = component.getByTestId('composer-input');
    const height = () => input.evaluate((el) => (el.closest('.cm-scroller') as HTMLElement).clientHeight);

    const tall = await height();
    expect(tall).toBeLessThanOrEqual(CAP_PX + 2);

    await component.getByTestId('set-single-line').click();

    await expect.poll(height).toBeLessThan(tall);

    const short = await input.evaluate((el) => {
      const s = el.closest('.cm-scroller') as HTMLElement;
      return { clientHeight: s.clientHeight, scrollHeight: s.scrollHeight };
    });
    // A single line no longer overflows.
    expect(short.scrollHeight).toBeLessThanOrEqual(short.clientHeight + 1);
  });
});
