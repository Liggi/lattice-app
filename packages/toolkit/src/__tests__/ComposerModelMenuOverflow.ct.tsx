import { test, expect } from '@playwright/experimental-ct-react';
import { Composer } from '../components/Composer';

for (const viewport of [{ width: 1280, height: 850 }, { width: 390, height: 844 }]) {
  test(`a long model menu stays reachable at ${viewport.width}px`, async ({ mount, page }) => {
    await page.setViewportSize(viewport);
    const component = await mount(
      <div style={{ position: 'fixed', bottom: 16, left: 16, right: 16 }}>
        <Composer
          core={{ onSubmit: () => {} }}
          runtimeConfig={{
            sessionModel: 'model-1',
            availableModels: Array.from({ length: 10 }, (_, i) => ({
              id: `model-${i}`, label: `Model ${i}`,
              description: 'A capable model for sustained coding and agent work',
            })),
            onModelChange: () => {},
            availableEfforts: Array.from({ length: 6 }, (_, i) => ({
              id: `effort-${i}`, label: `Reasoning ${i}`,
              description: 'Reasoning depth for complex problems and demanding work',
            })),
            onEffortChange: () => {},
          }}
        />
      </div>,
    );

    await component.getByTestId('session-model').click();
    const menu = component.getByTestId('model-menu');
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);

    // Both ends remain clickable, including after the menu has scrolled down.
    await component.getByTestId('effort-option-effort-5').click();
    await component.getByTestId('model-option-model-0').click();
    await expect(menu).toHaveCount(0);
  });
}

test('older models wait behind Other models, which opens and closes in place', async ({ mount }) => {
  const models = [
    { id: 'new-a', label: 'New A' },
    { id: 'new-b', label: 'New B' },
    { id: 'old-a', label: 'Old A', other: true },
  ];
  const component = await mount(
    <div style={{ position: 'fixed', bottom: 16, left: 16, right: 16 }}>
      <Composer core={{ onSubmit: () => {} }} runtimeConfig={{ sessionModel: 'new-a', availableModels: models, onModelChange: () => {} }} />
    </div>,
  );

  await component.getByTestId('session-model').click();
  const other = component.getByTestId('model-menu-other');
  await expect(component.getByTestId('model-option-old-a')).toHaveCount(0);
  await other.click();
  await expect(other).toHaveAttribute('aria-expanded', 'true');
  await expect(component.getByTestId('model-option-old-a')).toBeVisible();
  await other.click();
  await expect(component.getByTestId('model-option-old-a')).toHaveCount(0);
  await other.click();
  await expect(component.getByTestId('model-option-old-a')).toBeVisible();
});

test('the menu opens with Other models open when an older model is chosen', async ({ mount }) => {
  const component = await mount(
    <div style={{ position: 'fixed', bottom: 16, left: 16, right: 16 }}>
      <Composer
        core={{ onSubmit: () => {} }}
        runtimeConfig={{
          sessionModel: 'old-a',
          availableModels: [{ id: 'new-a', label: 'New A' }, { id: 'old-a', label: 'Old A', other: true }],
          onModelChange: () => {},
        }}
      />
    </div>,
  );
  await component.getByTestId('session-model').click();
  await expect(component.getByTestId('model-option-old-a')).toHaveAttribute('aria-checked', 'true');
});

test('the menu shows its note, and no default tag on a row already named default', async ({ mount }) => {
  const component = await mount(
    <div style={{ position: 'fixed', bottom: 16, left: 16, right: 16 }}>
      <Composer
        core={{ onSubmit: () => {} }}
        runtimeConfig={{
          availableModels: [{ id: 'cli-default', label: 'Claude Code default', isDefault: true }, { id: 'a', label: 'A' }],
          onModelChange: () => {},
          modelMenuNote: 'Showing the built-in list',
        }}
      />
    </div>,
  );
  await component.getByTestId('session-model').click();
  await expect(component.getByTestId('model-menu-note')).toHaveText('Showing the built-in list');
  await expect(component.getByTestId('model-option-cli-default')).not.toContainText(/default\s*default/);
});
