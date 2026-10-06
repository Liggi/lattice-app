import { test, expect } from '@playwright/experimental-ct-react';
import { devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComposerAttachmentsHarness } from './fixtures/ComposerAttachmentsHarness';

// ── PHONE_PHOTO_ATTACH ──
//
// A photo picked on an iPhone must show in the composer and go out with the
// message. iOS hands over a camera-sized JPEG (often over 5MB) or HEIC; the
// composer used to reject both and show the reason only inside the attachment
// strip, which isn't drawn when nothing was accepted, so the pick vanished
// without a word. Run in WebKit at iPhone size, where the bug was reported.

const { defaultBrowserType: _browser, ...iPhone } = devices['iPhone 13'];
test.use({ ...iPhone, browserName: 'webkit' });

const HEIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/files/photo.heic');
const MAX_BASE64 = 5 * 1024 * 1024;

const sentAttachments = async (output: import('@playwright/test').Locator) =>
  JSON.parse((await output.textContent()) || '[]') as string[];

test('a camera-sized JPEG over 5MB is resized and sent', async ({ mount, page }) => {
  // Random noise at 12MP compresses badly, like a real photo of texture.
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4032;
    canvas.height = 3024;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < data.data.length; i++) data.data[i] = (Math.random() * 256) | 0;
    ctx.putImageData(data, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
  });
  const buffer = Buffer.from(base64, 'base64');
  expect(buffer.length).toBeGreaterThan(5 * 1024 * 1024);

  const component = await mount(<ComposerAttachmentsHarness />);
  await component.locator('input[type="file"]').setInputFiles({
    name: 'IMG_0001.JPG',
    mimeType: 'image/jpeg',
    buffer,
  });
  await expect(component.getByText('IMG_0001.JPG')).toBeVisible();
  await expect(component.getByTestId('send-button')).toBeEnabled();
  await component.getByTestId('send-button').click();

  const sent = await sentAttachments(component.getByTestId('sent'));
  expect(sent).toHaveLength(1);
  const [mimeType, length] = sent[0].split(':');
  expect(mimeType).toBe('image/jpeg');
  expect(Number(length)).toBeGreaterThan(0);
  expect(Number(length)).toBeLessThanOrEqual(MAX_BASE64);
});

test('a HEIC photo is converted to JPEG and sent', async ({ mount }) => {
  const component = await mount(<ComposerAttachmentsHarness />);
  await component.locator('input[type="file"]').setInputFiles({
    name: 'IMG_0002.HEIC',
    mimeType: 'image/heic',
    buffer: readFileSync(HEIC),
  });
  await expect(component.getByText('IMG_0002.HEIC')).toBeVisible();
  await expect(component.getByTestId('send-button')).toBeEnabled();
  await component.getByTestId('send-button').click();

  const sent = await sentAttachments(component.getByTestId('sent'));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatch(/^image\/jpeg:\d+$/);
});

test('a file that cannot be used says why, even when nothing else is attached', async ({
  mount,
}) => {
  const component = await mount(<ComposerAttachmentsHarness />);
  await component.locator('input[type="file"]').setInputFiles({
    name: 'broken.heic',
    mimeType: 'image/heic',
    buffer: Buffer.from('not an image'),
  });
  await expect(component.getByText(/broken\.heic: .*send a JPEG or PNG/)).toBeVisible();
});
