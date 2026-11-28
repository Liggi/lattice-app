// @vitest-environment happy-dom

/**
 * An image whose file has gone (a cleared /tmp) is dropped from the panel's
 * Outputs, and in chat is replaced by a quiet line instead of a broken icon.
 */

import ReactMarkdown from 'react-markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { OutputsSection } from '../../src/web/chat/components/InsightsPanel/PanelShapes';
import { GalleryBlock } from '../../src/web/chat/components/MessageList/GalleryBlock';
import { markdownComponents } from '../../src/web/chat/components/MessageList/MessageItem';

afterEach(cleanup);

const image = (path: string, caption = '') => ({ path, caption, messageId: 'm1' });
const fail = (img: Element) => fireEvent.error(img);

describe('OutputsSection with images that fail to load', () => {
  it('drops a failed tile and keeps the rest', () => {
    const { container } = render(<OutputsSection outputs={{ images: [image('/tmp/a.png', 'A'), image('/tmp/b.png', 'B')], links: [] }} />);
    fail(container.querySelector('img[alt="A"]')!);
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('alt'))).toEqual(['B']);
  });

  it('hides the whole section when every image fails and there are no links', () => {
    const { container, queryByTestId } = render(<OutputsSection outputs={{ images: [image('/tmp/a.png'), image('/tmp/b.png')], links: [] }} />);
    for (const img of [...container.querySelectorAll('img')]) fail(img);
    expect(queryByTestId('panel-outputs')).toBeNull();
  });

  it('keeps the section for its links when every image fails', () => {
    const links = [{ href: 'https://github.com/o/r/pull/1', label: '#1', kind: 'pr' as const }];
    const { container, queryByTestId } = render(<OutputsSection outputs={{ images: [image('/tmp/a.png')], links }} />);
    fail(container.querySelector('img')!);
    expect(queryByTestId('panel-outputs')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('chat images that fail to load', () => {
  it('a gallery image becomes a quiet line and keeps its caption', () => {
    const source = JSON.stringify({ images: [{ path: '/tmp/gone.png', caption: 'Step 1' }, { path: '/tmp/here.png', caption: 'Step 2' }] });
    const { container } = render(<GalleryBlock source={source} imageUrl={(p) => `/api/images?path=${p}`} />);
    fail(container.querySelector('img[alt="Step 1"]')!);
    expect(container.querySelectorAll('[data-missing-image]')).toHaveLength(1);
    expect(container.querySelector('[data-missing-image]')!.textContent).toBe('Image no longer on disk');
    expect(container.textContent).toContain('Step 1');
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('a markdown image becomes a quiet line, not a link', () => {
    const { container } = render(<ReactMarkdown components={markdownComponents}>{'![after](/tmp/after.png)'}</ReactMarkdown>);
    const link = container.querySelector('a[data-viewable-image]') as HTMLAnchorElement;
    expect(link.style.textDecoration).toBe('none');
    fail(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[data-missing-image]')!.getAttribute('title')).toBe('after');
  });
});
