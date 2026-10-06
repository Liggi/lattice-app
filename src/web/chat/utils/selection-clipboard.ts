import { useEffect, type RefObject } from 'react';

/**
 * What a copied selection of rendered messages puts on the clipboard.
 *
 * Left to itself the browser serialises the selection with every element's
 * computed style inlined (the dark background, text colours, margins in em,
 * `font-style: normal`), and its text/plain drops list bullets, bold and code
 * backticks. Slack and other editors then paste that as mis-styled, squashed
 * text. This rebuilds the selection as bare semantic HTML and as Markdown.
 */

export interface ClipboardContent {
  html: string;
  text: string;
}

const SKIP = new Set(['BUTTON', 'SVG', 'svg', 'IFRAME', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'NOSCRIPT']);
const RENAME: Record<string, string> = { B: 'strong', STRONG: 'strong', I: 'em', EM: 'em', S: 'del', DEL: 'del', A: 'a', CODE: 'code' };
const BLOCKS = new Set(['P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'BR']);
const LIST_LIKE = new Set(['UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TR']);
const TABLE_PARTS = new Set(['THEAD', 'TBODY', 'TR']);
const INLINE_CONTAINERS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH']);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function skipped(el: Element): boolean {
  return SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('data-copy-skip');
}

function linkHref(el: Element): string | null {
  const href = (el as HTMLAnchorElement).href || el.getAttribute('href') || '';
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

class SelectionWriter {
  constructor(private range: Range) {}

  private inRange(node: Node): boolean {
    try {
      return this.range.intersectsNode(node);
    } catch {
      return false;
    }
  }

  private textOf(node: Text): string {
    let s = node.data;
    if (node === this.range.endContainer) s = s.slice(0, this.range.endOffset);
    if (node === this.range.startContainer) s = s.slice(this.range.startOffset);
    return s;
  }

  /** Raw selected text under a node, for code, which keeps its whitespace. */
  rawText(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return this.inRange(node) ? this.textOf(node as Text) : '';
    if (node.nodeType !== Node.ELEMENT_NODE || !this.inRange(node) || skipped(node as Element)) return '';
    let out = '';
    node.childNodes.forEach((c) => { out += this.rawText(c); });
    return out;
  }

  private kids(node: Node): Node[] {
    return Array.from(node.childNodes).filter((c) => this.inRange(c));
  }

  html(node: Node, parentTag = ''): string {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!this.inRange(node)) return '';
      const t = this.textOf(node as Text);
      if (!t.trim() && (LIST_LIKE.has(parentTag) || betweenBlocks(node))) return '';
      return escapeHtml(t);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    if (skipped(el)) return '';
    const tag = el.tagName;
    if (tag === 'PRE') return `<pre><code>${escapeHtml(this.rawText(el).replace(/\n$/, ''))}</code></pre>`;
    const inner = this.kids(el).map((c) => this.html(c, tag)).join('');
    if (tag === 'IMG') return escapeHtml(el.getAttribute('alt') ?? '');
    if (tag === 'BR') return '<br>';
    if (tag === 'HR') return '<hr>';
    if (tag === 'A') {
      const href = linkHref(el);
      if (!inner.trim()) return '';
      return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
    }
    const name = RENAME[tag] ?? (BLOCKS.has(tag) ? tag.toLowerCase() : null);
    if (!name) return inner;
    const body = BLOCKS.has(tag) ? inner.trim() : inner;
    return body || name === 'td' || name === 'th' ? `<${name}>${body}</${name}>` : '';
  }

  md(node: Node, parentTag = ''): string {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!this.inRange(node)) return '';
      const t = this.textOf(node as Text);
      if (LIST_LIKE.has(parentTag) && !t.trim()) return '';
      // The newline markdown puts after a hard break is not a space.
      const afterBreak = (node.previousSibling as Element | null)?.tagName === 'BR';
      return (afterBreak ? t.trimStart() : t).replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    if (skipped(el)) return '';
    const tag = el.tagName;
    const inner = (): string => this.kids(el).map((c) => this.md(c, tag)).join('');
    const block = (s: string): string => (s.trim() ? `\n\n${s.trim()}\n\n` : '');
    switch (tag) {
      case 'PRE': return block('```\n' + this.rawText(el).replace(/\n$/, '') + '\n```');
      case 'IMG': return el.getAttribute('alt') ?? '';
      case 'BR': return '\n';
      case 'HR': return block('---');
      case 'P': return block(inner());
      case 'STRONG': case 'B': return wrap(inner(), '**');
      case 'EM': case 'I': return wrap(inner(), '_');
      case 'DEL': case 'S': return wrap(inner(), '~~');
      case 'CODE': return wrap(inner(), '`');
      case 'A': {
        const text = inner();
        const href = linkHref(el);
        if (!text.trim()) return '';
        return href && href !== text.trim() ? `[${text}](${href})` : text;
      }
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return block(`${'#'.repeat(Number(tag[1]))} ${inner().trim()}`);
      case 'BLOCKQUOTE':
        return block(inner().trim().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
      case 'UL': case 'OL': {
        let n = Number(el.getAttribute('start') ?? 1);
        const items = this.kids(el).filter((c) => (c as Element).tagName === 'LI').map((li) => {
          const marker = tag === 'OL' ? `${n++}.` : '-';
          const body = this.md(li, tag).trim().replace(/\n{2,}/g, '\n');
          return `${marker} ${body.split('\n').join('\n' + ' '.repeat(marker.length + 1))}`;
        });
        return block(items.join('\n'));
      }
      case 'LI': return inner();
      case 'TABLE': return block(this.table(el));
      default: return inner();
    }
  }

  private table(table: Element): string {
    const rows = Array.from(table.querySelectorAll('tr')).filter((r) => this.inRange(r));
    const lines = rows.map((r) =>
      '| ' + Array.from(r.children).filter((c) => this.inRange(c)).map((c) => this.md(c).trim().replace(/\|/g, '\\|')).join(' | ') + ' |');
    const header = rows[0]?.querySelector('th');
    if (header && lines.length) {
      const cols = rows[0].children.length;
      lines.splice(1, 0, '|' + ' --- |'.repeat(cols));
    }
    return lines.join('\n');
  }
}

function wrap(s: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  if (!m || !m[2]) return s;
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

/** Whitespace between block elements is source formatting, not content. */
function betweenBlocks(node: Node): boolean {
  return Array.from(node.parentNode?.children ?? []).some((c) => BLOCKS.has(c.tagName) || c.tagName === 'PRE' || c.tagName === 'DIV');
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * Serialises the part of `range` inside `root`. A selection inside one code
 * block is just its code; inside one paragraph or list item, just its text;
 * across several blocks, those blocks with their structure.
 */
export function selectionToClipboard(range: Range, root: Element): ClipboardContent {
  const writer = new SelectionWriter(range);
  let top = elementOf(range.commonAncestorContainer);
  if (!top || !root.contains(top)) top = root;

  const pre = top.closest('pre');
  if (pre && root.contains(pre)) {
    const code = writer.rawText(pre);
    return { html: `<pre><code>${escapeHtml(code)}</code></pre>`, text: code };
  }
  if (TABLE_PARTS.has(top.tagName)) top = top.closest('table') ?? top;

  // Inside one paragraph, list item or heading, the selection is a run of
  // text: no bullet or block around it. Formatting the whole run sits inside
  // (a bold phrase, a link) stays on the HTML; the plain text carries none.
  const kids = Array.from(top.childNodes);
  let html: string;
  let text: string;
  if (top.tagName in RENAME || INLINE_CONTAINERS.has(top.tagName)) {
    html = top.tagName in RENAME ? writer.html(top) : kids.map((c) => writer.html(c)).join('');
    text = kids.map((c) => writer.md(c)).join('');
  } else {
    html = writer.html(top);
    text = writer.md(top);
  }
  for (let a = top.parentElement; a && a !== root && root.contains(a); a = a.parentElement) {
    const name = RENAME[a.tagName];
    if (!name) continue;
    const href = name === 'a' ? linkHref(a) : null;
    html = name !== 'a' ? `<${name}>${html}</${name}>` : href ? `<a href="${escapeHtml(href)}">${html}</a>` : html;
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { html: html.trim(), text };
}

/** Rewrites copies of a selection inside the element `ref` points at. */
export function useSelectionClipboard(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const root = ref.current;
      const sel = document.getSelection();
      if (!root || !e.clipboardData || !sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return;
      const { html, text } = selectionToClipboard(range, root);
      if (!text) return;
      e.clipboardData.setData('text/html', `<meta charset="utf-8">${html}`);
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [ref]);
}
