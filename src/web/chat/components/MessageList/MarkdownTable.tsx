import React, { type JSX, useLayoutEffect, useRef } from 'react';

/** Below this column width a table that does not fit is shown one row per block. */
const STACK_BELOW_PX = 560;
/** A column holding sentences reads badly narrower than this, so the table stacks instead. */
const MIN_PROSE_COLUMN_PX = 110;
/** A cell with more characters than this counts as a sentence. */
const PROSE_CELL_CHARS = 40;
/** Inline code, or a cell without spaces, up to this length stays on one line. */
const SHORT_TOKEN_CHARS = 30;

/**
 * A markdown table in a chat message. It keeps the grid while the grid fits;
 * on a narrow column a table too wide for it, or one whose sentences would be
 * squeezed into a few words per line, shows each row as a block, with every
 * value beside its header's name. A table of short values scrolls sideways
 * instead, with its right edge faded while columns are hidden past it.
 */
export function MarkdownTable({ children }: { children?: React.ReactNode }): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const table = wrap?.querySelector('table');
    if (!wrap || !table) return;

    const headerCells = Array.from(table.querySelectorAll('thead th')) as HTMLElement[];
    const headers = headerCells.map((th) => th.textContent?.trim() ?? '');
    const proseColumns = new Set<number>();
    for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
      Array.from(row.children).forEach((cell, i) => {
        const text = cell.textContent?.trim() ?? '';
        if (headers[i]) cell.setAttribute('data-label', headers[i]);
        // A short cell with no spaces (an id, a model name, a number) stays on one
        // line; a long path or URL may wrap. Cells still streaming in change, so mark afresh.
        cell.toggleAttribute('data-token', !!text && !/\s/.test(text) && text.length <= SHORT_TOKEN_CHARS);
        cell.toggleAttribute('data-long-word', text.split(/\s+/).some((word) => word.length > SHORT_TOKEN_CHARS));
        if (text.length > PROSE_CELL_CHARS) proseColumns.add(i);
      });
    }
    for (const code of Array.from(table.querySelectorAll('code'))) {
      if ((code.textContent?.length ?? 0) <= SHORT_TOKEN_CHARS) code.setAttribute('data-short', '');
    }

    let lastWidth = -1;
    const fit = () => {
      if (wrap.clientWidth === lastWidth) return;
      lastWidth = wrap.clientWidth;
      wrap.removeAttribute('data-stacked');
      const tooWide = table.scrollWidth > wrap.clientWidth;
      const proseSqueezed = [...proseColumns].some((i) => (headerCells[i]?.offsetWidth ?? Infinity) < MIN_PROSE_COLUMN_PX);
      // Numbers compare down a column, so a table of short values scrolls sideways instead.
      const stack = proseColumns.size > 0 && ((tooWide && wrap.clientWidth < STACK_BELOW_PX) || proseSqueezed);
      if (stack) wrap.setAttribute('data-stacked', '');
      markMoreRight();
    };
    // Fades the right edge while columns are hidden past it, so they do not look cut off.
    const markMoreRight = () => {
      const more = !wrap.hasAttribute('data-stacked') && wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1;
      wrap.toggleAttribute('data-more-right', more);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(wrap);
    wrap.addEventListener('scroll', markMoreRight, { passive: true });
    return () => {
      observer.disconnect();
      wrap.removeEventListener('scroll', markMoreRight);
    };
  }, [children]);

  return (
    <div ref={wrapRef} data-md-table className="md-table my-3 not-prose max-w-full overflow-x-auto overscroll-x-contain">
      <table className="min-w-full border-collapse text-[13.5px] tabular-nums">
        {children}
      </table>
    </div>
  );
}
