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
