import { test, expect } from '@playwright/experimental-ct-react';
import {
  InteractiveModelHarness,
  EffortModelHarness,
  ReadOnlyModelHarness,
} from './fixtures/ComposerModelSelectorHarness';

test.describe('Composer model selector', () => {
  test('renders a read-only badge when the interactive props are absent', async ({ mount }) => {
    const component = await mount(<ReadOnlyModelHarness />);

    const badge = component.getByTestId('session-model');
    await expect(badge).toBeVisible();
    // Read-only badge is a plain div, not a button, and shows the formatted model name.
    await expect(badge).toHaveText('opus-4');
    await expect(component.getByTestId('model-menu')).toHaveCount(0);
    await expect(component.getByTestId('model-selector')).toHaveCount(0);
  });

  test('opens the menu and lists the available models', async ({ mount }) => {
    const component = await mount(<InteractiveModelHarness />);

    await expect(component.getByTestId('model-menu')).toHaveCount(0);
    await component.getByTestId('session-model').click();

    await expect(component.getByTestId('model-menu')).toBeVisible();
    await expect(component.getByTestId('model-option-opus')).toBeVisible();
    await expect(component.getByTestId('model-option-sonnet')).toBeVisible();
    await expect(component.getByTestId('model-option-haiku')).toBeVisible();
  });

  test('selecting a non-default model fires onModelChange with its id', async ({ mount }) => {
    const component = await mount(<InteractiveModelHarness />);

    await component.getByTestId('session-model').click();
    await component.getByTestId('model-option-sonnet').click();

    await expect(component.getByTestId('last-change')).toHaveText('sonnet');
    await expect(component.getByTestId('model-menu')).toHaveCount(0);
  });

  test('selecting the default model fires onModelChange with null', async ({ mount }) => {
    const component = await mount(<InteractiveModelHarness />);

    // First pick a non-default so selecting default is a real change.
    await component.getByTestId('session-model').click();
    await component.getByTestId('model-option-sonnet').click();

    await component.getByTestId('session-model').click();
    await component.getByTestId('model-option-opus').click();

    await expect(component.getByTestId('last-change')).toHaveText('null');
  });

  test('passes the selected model through onSubmit options', async ({ mount }) => {
    const component = await mount(<InteractiveModelHarness />);

    await component.getByTestId('session-model').click();
    await component.getByTestId('model-option-sonnet').click();

    await component.getByTestId('composer-input').fill('hello');
    await component.getByTestId('composer-input').press('Enter');

    await expect(component.getByTestId('submitted-model')).toHaveText('sonnet');
  });

  test('keyboard: ArrowDown then Enter selects the next model and fires onModelChange', async ({
    mount,
  }) => {
    const component = await mount(<InteractiveModelHarness />);

    // Open the menu. Focus lands on the effective (default: opus) row.
    await component.getByTestId('session-model').click();
    await expect(component.getByTestId('model-menu')).toBeVisible();
    await expect(component.getByTestId('model-option-opus')).toBeFocused();

    // ArrowDown moves to sonnet, Enter selects it.
    await component.getByTestId('model-menu').press('ArrowDown');
    await expect(component.getByTestId('model-option-sonnet')).toBeFocused();
    await component.getByTestId('model-menu').press('Enter');

    await expect(component.getByTestId('last-change')).toHaveText('sonnet');
    await expect(component.getByTestId('model-menu')).toHaveCount(0);
    // Focus returns to the trigger on close.
    await expect(component.getByTestId('session-model')).toBeFocused();
  });

  test('open menu is not collapsed and stays within the viewport', async ({ mount, page }) => {
    const component = await mount(<InteractiveModelHarness />);

    await component.getByTestId('session-model').click();
    const menu = component.getByTestId('model-menu');
    await expect(menu).toBeVisible();

    // The menu escapes the composer card's `overflow-hidden`, so it must not be
    // clipped to zero height: its rendered height matches its full scroll height.
    const dims = await menu.evaluate((el) => ({
      height: (el as HTMLElement).getBoundingClientRect().height,
      scrollHeight: (el as HTMLElement).scrollHeight,
    }));
    expect(dims.height).toBeGreaterThan(0);
    expect(Math.round(dims.height)).toBe(Math.round(dims.scrollHeight));

    // And it sits fully inside the page viewport.
    const box = await menu.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (box && viewport) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    }
  });

  test('renders a Reasoning section and fires onEffortChange with the effort id', async ({
    mount,
  }) => {
    const component = await mount(<EffortModelHarness />);

    await component.getByTestId('session-model').click();
    const menu = component.getByTestId('model-menu');
    await expect(menu).toBeVisible();
    // Two section headers, "Model" then "Reasoning".
    await expect(menu.getByText('Reasoning', { exact: true })).toBeVisible();
    await expect(component.getByTestId('effort-option-high')).toBeVisible();

    await component.getByTestId('effort-option-high').click();
    await expect(component.getByTestId('last-effort-change')).toHaveText('high');
  });

  test('selecting the default effort fires onEffortChange with null', async ({ mount }) => {
    const component = await mount(<EffortModelHarness />);

    // Pick a non-default effort first so choosing the default is a real change.
    await component.getByTestId('session-model').click();
    await component.getByTestId('effort-option-high').click();

    // Menu stays open on effort click, so the default row is still reachable.
    await component.getByTestId('effort-option-low').click();
    await expect(component.getByTestId('last-effort-change')).toHaveText('null');
  });

  test('menu stays open on effort click and closes on model click', async ({ mount }) => {
    const component = await mount(<EffortModelHarness />);

    await component.getByTestId('session-model').click();
    await component.getByTestId('effort-option-high').click();
    // Effort selection does not close the menu.
    await expect(component.getByTestId('model-menu')).toBeVisible();

    // Model selection closes it.
    await component.getByTestId('model-option-sonnet').click();
    await expect(component.getByTestId('model-menu')).toHaveCount(0);
  });

  test('onSubmit carries both the selected model and effort', async ({ mount }) => {
    const component = await mount(<EffortModelHarness />);

    await component.getByTestId('session-model').click();
    await component.getByTestId('effort-option-high').click();
    await component.getByTestId('model-option-sonnet').click();

    await component.getByTestId('composer-input').fill('hello');
    await component.getByTestId('composer-input').press('Enter');

    await expect(component.getByTestId('submitted-model')).toHaveText('sonnet');
    await expect(component.getByTestId('submitted-effort')).toHaveText('high');
  });

  test('badge shows "<model> · <effort>" when a non-default effort is selected', async ({
    mount,
  }) => {
    const component = await mount(<EffortModelHarness />);

    const badge = component.getByTestId('session-model');
    // Default effort: model label only, no interpunct.
    await expect(badge).not.toContainText('·');

    await badge.click();
    await component.getByTestId('effort-option-xhigh').click();

    await expect(badge).toContainText('·');
    await expect(badge).toContainText('XHigh');
  });
});
