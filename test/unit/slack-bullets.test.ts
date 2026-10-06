// @vitest-environment happy-dom

/**
 * Slack-style "•" lines drafted under single newlines stay on their own lines
 * in a rendered reply and in a copied selection of it.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { remarkSlackBullets } from '../../src/web/chat/utils/slack-bullets.js';
import { selectionToClipboard } from '../../src/web/chat/utils/selection-clipboard.js';

const render = (md: string): string =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkSlackBullets] }, md));

describe('remarkSlackBullets', () => {
  it('breaks before each bullet line and leaves other soft breaks and code alone', () => {
    expect(render('Draft:\n• First with **bold**.\n• Second.')).toBe('<p>Draft:<br/>\n• First with <strong>bold</strong>.<br/>\n• Second.</p>');
    expect(render('One line\nwraps on.')).toBe('<p>One line\nwraps on.</p>');
    expect(render('```\na\n• b\n```')).toBe('<pre><code>a\n• b\n</code></pre>');
  });

  it('copies the bullets one per line', () => {
    document.body.innerHTML = `<div id="list">${render('Intro.\n\n• First.\n• Second `x`.\n\nAfter.')}</div>`;
    const root = document.getElementById('list')!;
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(selectionToClipboard(range, root).text).toBe('Intro.\n\n• First.\n• Second `x`.\n\nAfter.');
  });
});
