// @vitest-environment happy-dom

/**
 * An agent's frame: the checks `lattice frame` runs on its SVG source, and the
 * full-screen viewer a chat image opens in.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { extractFrame, lintFrame, textSizes } from '../../src/cli/frame-command';
import { frameGuidance } from '../../src/services/sessions/frame-guidance';
import { galleryGuidance } from '../../src/services/sessions/gallery-guidance';
import { noteBoxFraction, parseGalleryBlock } from '../../src/web/chat/utils/gallery-block';
import { modelReadsImages } from '../../src/constants/claude-endpoint';
import { ViewableImage } from '../../src/web/chat/components/MessageList/ImageViewer';

afterEach(cleanup);

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

const frame = (body: string, size = 'viewBox="0 0 1920 1080" width="1920" height="1080"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${size}>${body}</svg>`;

describe('frame source checks', () => {
  it('finds the svg in a draft and accepts a 1920 frame with large type', () => {
    const svg = frame('<text x="1" y="80" font-size="72">Title</text><g font-size="40"><text x="1" y="200">Inherited</text></g>');
    expect(extractFrame(`Draft\n${svg}\nmore`)).toBe(svg);
    expect(lintFrame(svg)).toEqual([]);
  });

  it('reads sizes from attributes, styles and enclosing groups, defaulting to 16', () => {
    const sizes = textSizes(frame('<g font-size="44"><text>a</text></g><text style="font-size: 30px">b</text><text>c</text>'));
    expect(sizes.map((t) => t.size)).toEqual([44, 30, 16]);
  });

  it('flags small text, the wrong width and scripts', () => {
    const problems = lintFrame(frame('<text font-size="24">Too small</text><script>x()</script>', 'viewBox="0 0 340 200" width="340"'));
    expect(problems.some((p) => p.includes('340 wide'))).toBe(true);
    expect(problems.some((p) => p.includes('"Too small" at 24px'))).toBe(true);
    expect(problems.some((p) => p.includes('<script>'))).toBe(true);
  });
});

describe('sessions whose model cannot read images', () => {
  const config = { claudeEndpoints: [
    { id: 'a', baseUrl: 'http://x', model: 'deepseek-v4' },
    { id: 'b', baseUrl: 'http://y', model: 'kimi-k3', readsImages: true },
  ] };

  it('reads images only on Claude models and endpoints marked as reading them', () => {
    expect(modelReadsImages(config, 'claude-opus-5-5')).toBe(true);
    expect(modelReadsImages(config, 'kimi-k3')).toBe(true);
    expect(modelReadsImages(config, 'deepseek-v4')).toBe(false);
  });

  it('are told to check the source and never to open the images', () => {
    const blind = frameGuidance('lattice', false).join('\n');
    expect(blind).not.toMatch(/Open both|Open each/);
    expect(blind).toMatch(/never open the PNGs/);
    expect(frameGuidance('lattice').join('\n')).toMatch(/Open both and look as a reader would/);
    expect(galleryGuidance(false).join('\n')).not.toMatch(/and look/);
    expect(galleryGuidance(true).join('\n')).toMatch(/crop the file to each box/);
  });
});

describe('an install with a figure toolkit', () => {
  it('points sessions at its guide instead of the SVG route', () => {
    const text = frameGuidance('lattice', true, '/kit/GUIDE.md').join('\n');
    expect(text).toMatch(/read \/kit\/GUIDE\.md/);
    expect(text).not.toMatch(/lattice frame|viewBox/);
  });

  it('names questions about structure as a reason to draw first, on both routes', () => {
    for (const text of [frameGuidance('lattice', true, '/kit/GUIDE.md'), frameGuidance('lattice', true, '')].map((t) => t.join('\n'))) {
      expect(text).toMatch(/where does X live/);
      expect(text).toMatch(/picture first/);
    }
  });

  it("adds the install's own step after the guide, and nothing when there is none", () => {
    const text = frameGuidance('lattice', true, '/kit/GUIDE.md', 'Show it to the reviewer first.').join('\n');
    expect(text).toMatch(/the figure carries one point\.'?\n- Show it to the reviewer first\.$/);
    expect(frameGuidance('lattice', true, '/kit/GUIDE.md', '').join('\n')).toMatch(/the figure carries one point\.$/);
  });

  it('keeps sessions that cannot read images on the SVG route', () => {
    expect(frameGuidance('lattice', false, '/kit/GUIDE.md').join('\n')).toMatch(/never open the PNGs/);
  });
});

describe('lattice-gallery block', () => {
  it('reads images, captions and notes, with and without a box', () => {
    const parsed = parseGalleryBlock(JSON.stringify({ images: [{ path: '/tmp/a.png', size: [200, 100], caption: 'A', notes: [{ text: 'boxed', box: [10, 20, 30, 40] }, { text: 'whole' }] }] }));
    expect(parsed).toEqual({ ok: true, images: [{ path: '/tmp/a.png', caption: 'A', size: { w: 200, h: 100 }, notes: [{ text: 'boxed', box: { x: 10, y: 20, w: 30, h: 40 } }, { text: 'whole' }] }] });
  });

  it('says what is wrong with a block it cannot read', () => {
    expect(parseGalleryBlock('{ nope')).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    expect(parseGalleryBlock('{"images":[{"path":"/a.png","notes":[{"text":"x","box":[1,2,3]}]}]}'))
      .toEqual({ ok: false, error: 'image 1, note 1: "box" must be [x, y, width, height] in pixels' });
  });

  it('scales a box measured at another size to the file, and clamps it to the image', () => {
    // Measured at 1x on a 2x screenshot: the same fractions.
    expect(noteBoxFraction({ x: 100, y: 50, w: 100, h: 50 }, { w: 400, h: 200 }, { w: 200, h: 100 })).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(noteBoxFraction({ x: 150, y: 0, w: 100, h: 50 }, { w: 200, h: 100 })).toEqual({ x: 0.75, y: 0, w: 0.25, h: 0.5 });
    expect(noteBoxFraction({ x: 300, y: 0, w: 10, h: 10 }, { w: 200, h: 100 })).toBeNull();
  });
});

describe('ViewableImage', () => {
  it('opens the image full screen on a tap and closes on Close and Escape', () => {
    const { container } = render(<ViewableImage src={PIXEL} alt="A frame"><img src={PIXEL} alt="A frame" /></ViewableImage>);
    act(() => { fireEvent.click(container.querySelector('[data-viewable-image]')!); });
    expect(document.querySelector('[data-image-viewer] img')?.getAttribute('src')).toBe(PIXEL);
    act(() => { fireEvent.click(document.querySelector('[data-image-viewer-close]')!); });
    expect(document.querySelector('[data-image-viewer]')).toBeNull();
    act(() => { fireEvent.click(container.querySelector('[data-viewable-image]')!); });
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(document.querySelector('[data-image-viewer]')).toBeNull();
  });

  it('pages through the images of one message with the strip, the arrow keys and the buttons', () => {
    const OTHER = `${PIXEL}#2`;
    const { container } = render(
      <div data-message-id="m1">
        <ViewableImage src={PIXEL} alt="Step 1"><img src={PIXEL} alt="Step 1" /></ViewableImage>
        <ViewableImage src={OTHER} alt="Step 2"><img src={OTHER} alt="Step 2" /></ViewableImage>
      </div>,
    );
    act(() => { fireEvent.click(container.querySelectorAll('[data-viewable-image]')[1]); });
    const shown = () => document.querySelector('[data-image-viewer] [data-image-viewer-caption]')?.textContent;
    expect(document.querySelector('[data-image-viewer-position]')?.textContent).toBe('2 of 2');
    expect(shown()).toBe('Step 2');
    expect(document.querySelectorAll('[data-image-viewer-thumb]')).toHaveLength(2);
    expect(document.querySelector<HTMLButtonElement>('[data-image-viewer-next]')?.disabled).toBe(true);
    act(() => { fireEvent.keyDown(window, { key: 'ArrowLeft' }); });
    expect(shown()).toBe('Step 1');
    act(() => { fireEvent.click(document.querySelector('[data-image-viewer-next]')!); });
    expect(shown()).toBe('Step 2');
    act(() => { fireEvent.click(document.querySelectorAll('[data-image-viewer-thumb]')[0]); });
    expect(shown()).toBe('Step 1');
  });

  it('shows a lone image with its caption and no paging', () => {
    const { container } = render(<div data-message-id="m1"><ViewableImage src={PIXEL} alt="Only"><img src={PIXEL} alt="Only" /></ViewableImage></div>);
    act(() => { fireEvent.click(container.querySelector('[data-viewable-image]')!); });
    expect(document.querySelector('[data-image-viewer-caption]')?.textContent).toBe('Only');
    expect(document.querySelector('[data-image-viewer-position]')).toBeNull();
    expect(document.querySelector('[data-image-viewer-strip]')).toBeNull();
  });

  it('leaves a Cmd-click to the browser, which opens a new tab', () => {
    const { container } = render(<ViewableImage src={PIXEL} alt="A"><img src={PIXEL} alt="A" /></ViewableImage>);
    const stopNavigation = (e: Event) => e.preventDefault();
    document.addEventListener('click', stopNavigation);
    act(() => { fireEvent.click(container.querySelector('[data-viewable-image]')!, { metaKey: true }); });
    document.removeEventListener('click', stopNavigation);
    expect(document.querySelector('[data-image-viewer]')).toBeNull();
  });
});
