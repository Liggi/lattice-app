import { test, expect } from '@playwright/experimental-ct-react';
import { ComposerHeightHarness } from './fixtures/ComposerHeightHarness';

// ── COMPOSER_TEXTAREA_HEIGHT_CAP ──
//
// The textarea auto-grows to fit its content but is capped at ~3 rows
// (TEXTAREA_MAX_HEIGHT_PX = 85 in Composer.tsx). Beyond that it scrolls.

const CAP_PX = 85;

test.describe('composer textarea auto-grow cap', () => {
  test('stops growing at ~3 rows and scrolls the overflow', async ({ mount }) => {
    const component = await mount(<ComposerHeightHarness lines={12} />);
    const textarea = component.getByTestId('composer-input');
    await expect(textarea).toBeVisible();

    const box = await textarea.evaluate((el: HTMLTextAreaElement) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      maxHeight: getComputedStyle(el).maxHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));

    // Capped: never taller than the 3-row budget (small tolerance for rounding).
    expect(box.clientHeight).toBeLessThanOrEqual(90);
    // Actually grew to the cap rather than staying at the 1-row minimum.
    expect(box.clientHeight).toBeGreaterThan(60);
    // Content overflows and is reachable by scrolling.
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    expect(box.overflowY).toBe('auto');
    expect(box.maxHeight).toBe(`${CAP_PX}px`);
  });

  test('is scrollable to the bottom of the overflowing content', async ({ mount }) => {
    const component = await mount(<ComposerHeightHarness lines={12} />);
    const textarea = component.getByTestId('composer-input');

    const scrolled = await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });

    expect(scrolled).toBeGreaterThan(0);
  });

  test('shrinks back down when the content becomes short again', async ({ mount }) => {
    const component = await mount(<ComposerHeightHarness lines={12} />);
    const textarea = component.getByTestId('composer-input');

    const tall = await textarea.evaluate((el: HTMLTextAreaElement) => el.clientHeight);
    expect(tall).toBeLessThanOrEqual(90);

    await component.getByTestId('set-single-line').click();

    await expect
      .poll(async () => textarea.evaluate((el: HTMLTextAreaElement) => el.clientHeight))
      .toBeLessThan(tall);

    const short = await textarea.evaluate((el: HTMLTextAreaElement) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    // A single line no longer overflows.
    expect(short.scrollHeight).toBeLessThanOrEqual(short.clientHeight + 1);
  });
});
