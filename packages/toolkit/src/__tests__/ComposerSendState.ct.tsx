import { test, expect } from '@playwright/experimental-ct-react';
import type { Locator } from '@playwright/test';
import { ComposerSendStateHarness } from './fixtures/ComposerSendStateHarness';

// ── SEND_BUTTON_DISABLED_STATE ──
//
// An idle composer must disable Send via the *native* attribute, not only
// aria-disabled. Hosts (such as Lattice) style the idle state off `:disabled`,
// so an aria-only button renders in full enabled colours, keeps its hover
// state, stays in the tab order, and silently swallows clicks.
//
// Regression: 0.3.0 moved the emptiness clause off `disabled` onto
// `aria-disabled`, which broke every host styling `:disabled`.
//
// NOTE: do not use Playwright's toBeDisabled()/toBeEnabled() here. Those
// matchers treat aria-disabled="true" as disabled, so they pass on exactly the
// bug this file exists to catch. Assert the DOM property instead.

const isNativelyDisabled = (button: Locator) =>
  button.evaluate((el: HTMLButtonElement) => el.disabled);

test.describe('composer send button disabled state', () => {
  test('an empty composer disables Send natively, not just via aria', async ({ mount }) => {
    const component = await mount(<ComposerSendStateHarness />);
    const send = component.getByTestId('send-button');

    expect(await isNativelyDisabled(send)).toBe(true);
    await expect(send).toHaveAttribute('aria-disabled', 'true');
  });

  test('a host :disabled rule matches the idle Send button', async ({ mount }) => {
    const component = await mount(<ComposerSendStateHarness />);
    const send = component.getByTestId('send-button');

    // This is the host-styling contract, expressed the way a host would.
    const matchesDisabledSelector = await send.evaluate((el) => el.matches(':disabled'));
    expect(matchesDisabledSelector).toBe(true);
  });

  test('a disabled Send is not focusable and does not submit', async ({ mount }) => {
    const component = await mount(<ComposerSendStateHarness />);
    const send = component.getByTestId('send-button');

    await send.click({ force: true });
    await expect(component.getByTestId('submit-count')).toHaveText('0');

    // Natively disabled buttons are skipped by the tab order; an aria-only
    // button would report itself as the active element here.
    const focused = await send.evaluate((el) => el === document.activeElement);
    expect(focused).toBe(false);
  });

  test('typing enables Send', async ({ mount }) => {
    const component = await mount(<ComposerSendStateHarness />);
    const send = component.getByTestId('send-button');

    await component.getByTestId('set-text').click();
    expect(await isNativelyDisabled(send)).toBe(false);

    await send.click();
    await expect(component.getByTestId('submit-count')).toHaveText('1');
  });

  test('clearing the composer disables Send again', async ({ mount }) => {
    const component = await mount(<ComposerSendStateHarness initialValue="hello" />);
    const send = component.getByTestId('send-button');

    expect(await isNativelyDisabled(send)).toBe(false);
    await component.getByTestId('clear-text').click();
    await expect
      .poll(async () => isNativelyDisabled(send))
      .toBe(true);
  });

  test('whitespace alone does not enable Send', async ({ mount }) => {
    const component = await mount(<ComposerSendStateHarness initialValue="   " />);
    expect(await isNativelyDisabled(component.getByTestId('send-button'))).toBe(true);
  });

  test('allowEmptySubmit keeps Send live on an empty composer', async ({ mount }) => {
    const component = await mount(<ComposerSendStateHarness allowEmptySubmit />);
    const send = component.getByTestId('send-button');

    expect(await isNativelyDisabled(send)).toBe(false);
    await send.click();
    await expect(component.getByTestId('submit-count')).toHaveText('1');
  });
});
