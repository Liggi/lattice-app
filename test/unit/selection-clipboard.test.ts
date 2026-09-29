// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { selectionToClipboard } from '../../src/web/chat/utils/selection-clipboard.js';

/** A rendered agent reply, with the inline styles and chrome the real one carries. */
function render(): HTMLElement {
  document.body.innerHTML = `
    <div id="list">
      <div class="prose" style="color: rgb(231, 229, 228); font-style: normal">
        <p id="intro">Fixed the <strong>retry loop</strong> in <code>run_job_once</code>.</p>
        <ul>
          <li id="one"><strong>Cause:</strong> the timer was never cleared.</li>
          <li id="two"><strong>Fix:</strong> clear it on exit, see <a href="https://example.com/pr">the PR</a>.</li>
        </ul>
        <div class="not-prose"><div><button>Copy</button><pre id="code"><code><span class="line">const a_b = 1;</span>
<span class="line">run(a_b);</span></code></pre></div></div>
        <table><thead><tr><th>Check</th><th>Result</th></tr></thead>
          <tbody><tr><td>unit</td><td>pass</td></tr></tbody></table>
        <p id="outro">Nothing is pushed.</p>
      </div>
    </div>`;
  return document.getElementById('list')!;
}

function rangeOver(start: Node, startOffset: number, end: Node, endOffset: number): Range {
  const r = document.createRange();
  r.setStart(start, startOffset);
  r.setEnd(end, endOffset);
  return r;
}

const text = (id: string, n = 0): Text => {
  const walker = document.createTreeWalker(document.getElementById(id)!, NodeFilter.SHOW_TEXT);
  let t = walker.nextNode();
  for (let i = 0; i < n; i++) t = walker.nextNode();
  return t as Text;
};

describe('selectionToClipboard', () => {
  let root: HTMLElement;
  beforeEach(() => { root = render(); });

  it('copies a whole reply as bare semantic HTML and Markdown', () => {
    const prose = root.querySelector('.prose')!;
    const r = document.createRange();
    r.selectNodeContents(prose);
    const { html, text: md } = selectionToClipboard(r, root);

    expect(html).not.toMatch(/style=|class=|<button|<div|<span/);
    expect(html).toContain('<ul><li><strong>Cause:</strong> the timer was never cleared.</li>');
    expect(html).toContain('<a href="https://example.com/pr">the PR</a>');
    expect(html).toContain('<pre><code>const a_b = 1;\nrun(a_b);</code></pre>');
    expect(md).toBe([
      'Fixed the **retry loop** in `run_job_once`.',
      '',
      '- **Cause:** the timer was never cleared.',
      '- **Fix:** clear it on exit, see [the PR](https://example.com/pr).',
      '',
      '```\nconst a_b = 1;\nrun(a_b);\n```',
      '',
      '| Check | Result |\n| --- | --- |\n| unit | pass |',
      '',
      'Nothing is pushed.',
    ].join('\n'));
  });

  it('keeps a selection across two bullets as a list', () => {
    const { html, text: md } = selectionToClipboard(rangeOver(text('one', 1), 5, text('two', 1), 6), root);
    expect(html).toBe('<ul><li>timer was never cleared.</li><li><strong>Fix:</strong> clear</li></ul>');
    expect(md).toBe('- timer was never cleared.\n- **Fix:** clear');
  });

  it('copies part of one bullet as plain words', () => {
    const { html, text: md } = selectionToClipboard(rangeOver(text('two', 1), 1, text('two', 1), 9), root);
    expect(html).toBe('clear it');
    expect(md).toBe('clear it');
  });

  it('copies a selection inside a code block as the code alone', () => {
    const { html, text: md } = selectionToClipboard(rangeOver(text('code', 0), 6, text('code', 2), 8), root);
    expect(md).toBe('a_b = 1;\nrun(a_b)');
    expect(html).toBe('<pre><code>a_b = 1;\nrun(a_b)</code></pre>');
  });
});
