// @vitest-environment happy-dom

/**
 * An agent's frame: the checks `lattice frame` runs on its SVG source, and the
 * full-screen viewer a chat image opens in.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { extractFrame, lintFrame, textSizes } from '../../src/cli/frame-command';
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

  it('leaves a Cmd-click to the browser, which opens a new tab', () => {
    const { container } = render(<ViewableImage src={PIXEL} alt="A"><img src={PIXEL} alt="A" /></ViewableImage>);
    const stopNavigation = (e: Event) => e.preventDefault();
    document.addEventListener('click', stopNavigation);
    act(() => { fireEvent.click(container.querySelector('[data-viewable-image]')!, { metaKey: true }); });
    document.removeEventListener('click', stopNavigation);
    expect(document.querySelector('[data-image-viewer]')).toBeNull();
  });
});
