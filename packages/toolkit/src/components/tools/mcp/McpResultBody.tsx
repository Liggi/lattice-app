import React, { useMemo, useState } from 'react';
import { cn } from '../../../utils/cn.js';
import { tk } from '../../../tokens.js';
import {
  unwrapResult, parseDelimited, stripNoise, rankColumns, toRecords, describeFields, detectKind,
  descendSingleKey,
  type UnwrappedResult, type Field,
} from './unwrapResult.js';

/**
 * Renders an MCP tool result as whatever it actually is — a table, structured JSON,
 * markdown, or text — rather than as one pre-formatted JSON dump.
 *
 * Two rules hold throughout:
 *   nothing is hidden without saying so, and the complete raw payload is always
 *   one click away. Truncation is stated in the UI, never silent.
 */

/** Below this, render the whole payload. The median MCP result is ~600 bytes. */
const FULL_RENDER_BYTES = 2_000;
/** Rows/lines shown before the "show all" affordance kicks in. */
const PREVIEW_ROWS = 12;
const PREVIEW_LINES = 20;

interface McpResultBodyProps {
  result: string;
  /** Rendered above the payload when the transport reported a failure. */
  isError?: boolean;
}

function ShowAll({ hidden, unit, onClick }: { hidden: number; unit: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn('w-full px-3 py-1.5 text-left text-[11px] border-t', tk.separator, tk.text.muted, tk.hover)}
    >
      show {hidden.toLocaleString()} more {unit}
    </button>
  );
}

// ── Kind renderers ──

/** Columns shown before the rest are folded behind a toggle. */
const PREVIEW_COLS = 5;
/** Characters of a single cell shown inline. The full value stays in the tooltip. */
const CELL_CHARS = 90;

function cell(v: string): string {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > CELL_CHARS ? s.slice(0, CELL_CHARS - 1) + '…' : s;
}

function Grid({ header, body }: { header: string[]; body: string[][] }): React.JSX.Element {
  const [showAllRows, setShowAllRows] = useState(false);
  const [showAllCols, setShowAllCols] = useState(false);

  const order = useMemo(() => rankColumns(header, body), [header, body]);
  const cols = showAllCols ? order : order.slice(0, PREVIEW_COLS);
  const rows = showAllRows ? body : body.slice(0, PREVIEW_ROWS);

  return (
    <div>
      <div className={cn('overflow-x-auto', tk.scrollbar)}>
        <table className="text-[12px] border-collapse">
          <thead>
            <tr className={cn('border-b', tk.separator)}>
              {cols.map((c) => (
                <th key={c} className={cn('px-2 py-1.5 text-left font-medium whitespace-nowrap', tk.text.muted)}>
                  {header[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={cn('border-b last:border-0 align-top', tk.separator)}>
                {cols.map((c) => (
                  <td key={c} className={cn('px-2 py-1 whitespace-nowrap', tk.text.primary)} title={r[c] ?? ''}>
                    {cell(r[c] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!showAllCols && order.length > PREVIEW_COLS && (
        <ShowAll
          hidden={order.length - PREVIEW_COLS}
          unit={`columns (${order.slice(PREVIEW_COLS).map((c) => header[c]).join(', ')})`}
          onClick={() => setShowAllCols(true)}
        />
      )}
      {!showAllRows && body.length > PREVIEW_ROWS && (
        <ShowAll hidden={body.length - PREVIEW_ROWS} unit="rows" onClick={() => setShowAllRows(true)} />
      )}
    </div>
  );
}

function TableView({ text }: { text: string }): React.JSX.Element {
  const rows = useMemo(() => parseDelimited(text, text.split('\n')[0].includes('\t') ? '\t' : ','), [text]);
  if (rows.length < 2) return <TextView text={text} />;
  const [header, ...body] = rows;
  return <Grid header={header} body={body} />;
}

/** `[label](href)`, `` `code` ``, `**bold**`. */
function inlineMarkdown(s: string): React.ReactNode[] {
  return s
    .split(/(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, i) => {
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        return (
          <a
            key={i}
            href={link[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-700 dark:text-cyan-400 no-underline hover:underline"
            title={link[2]}
          >
            {link[1]}
          </a>
        );
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={i} className={cn('px-1 py-0.5 rounded text-[12px] font-mono', tk.codeBgSubtle, tk.text.primary)}>
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i} className={tk.text.heading}>{part.slice(2, -2)}</strong>;
      }
      return <React.Fragment key={i}>{part}</React.Fragment>;
    });
}

/** Pull `<tr>`/`<td>` content out of an embedded HTML table so it can render as a grid. */
function parseHtmlTable(html: string): { header: string[]; body: string[][] } | null {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) =>
      c[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    ),
  );
  if (rows.length < 2) return null;
  return { header: rows[0], body: rows.slice(1) };
}

type Block = { kind: 'md'; lines: string[] } | { kind: 'html-table'; html: string };

/** Split markdown into prose runs and embedded HTML tables. */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let cursor = 0;
  const re = /<table[\s\S]*?<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(cursor, m.index);
    if (before.trim()) blocks.push({ kind: 'md', lines: before.split('\n') });
    blocks.push({ kind: 'html-table', html: m[0] });
    cursor = m.index + m[0].length;
  }
  const rest = text.slice(cursor);
  if (rest.trim() || !blocks.length) blocks.push({ kind: 'md', lines: rest.split('\n') });
  return blocks;
}

/** Minimal markdown: headings, bullets, links, inline code and bold, plus embedded HTML tables. */
export function MarkdownView({ text }: { text: string }): React.JSX.Element {
  const [showAll, setShowAll] = useState(text.length <= FULL_RENDER_BYTES);
  const blocks = useMemo(() => splitBlocks(text), [text]);
  const totalLines = text.split('\n').length;

  // Budget preview lines across blocks so a leading table doesn't consume the whole preview.
  let budget = showAll ? Infinity : PREVIEW_LINES;
  const inline = inlineMarkdown;

  const renderMd = (lines: string[], keyBase: number): React.JSX.Element => {
    const shown = lines.slice(0, budget === Infinity ? lines.length : Math.max(0, budget));
    budget = budget === Infinity ? Infinity : budget - shown.length;
    return (
      <div key={keyBase} className="px-3 py-2 space-y-1">
        {shown.map((line, i) => {
          const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
          if (heading) {
            const level = heading[1].length;
            return (
              <div
                key={i}
                className={cn('font-medium', tk.text.heading, level <= 2 ? 'text-[14px] pt-1' : 'text-[13px]')}
              >
                {inline(heading[2])}
              </div>
            );
          }
          const bullet = line.match(/^\s*[-*]\s+(.*)$/);
          if (bullet) {
            return (
              <div key={i} className={cn('flex gap-2 text-[13px]', tk.text.primary)}>
                <span className={tk.text.faint}>•</span>
                <span className="min-w-0">{inline(bullet[1])}</span>
              </div>
            );
          }
          if (!line.trim()) return <div key={i} className="h-1" />;
          return (
            <div key={i} className={cn('text-[13px] leading-relaxed', tk.text.primary)}>
              {inline(line)}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div>
      {blocks.map((b, i) => {
        if (b.kind === 'html-table') {
          const parsed = parseHtmlTable(b.html);
          if (!parsed) return null;
          if (budget !== Infinity) {
            if (budget <= 0) return null;
            budget -= Math.min(parsed.body.length + 1, budget);
          }
          return (
            <div key={i} className={cn('mx-3 my-2 border rounded', tk.separator)}>
              <Grid header={parsed.header} body={parsed.body} />
            </div>
          );
        }
        return renderMd(b.lines, i);
      })}
      {!showAll && totalLines > PREVIEW_LINES && (
        <ShowAll hidden={totalLines - PREVIEW_LINES} unit="lines" onClick={() => setShowAll(true)} />
      )}
    </div>
  );
}

/** Characters of a prose field shown before it is folded. */
const FIELD_CHARS = 400;

/**
 * Short scalars packed several to a line — a row per field wastes most of the card.
 * Identifiers and timestamps are kept but held behind a toggle, so the fields a
 * person reads aren't buried among UUIDs.
 */
function ScalarStrip({ fields }: { fields: Field[] }): React.JSX.Element {
  const [showPlumbing, setShowPlumbing] = useState(false);
  const meaningful = fields.filter((f) => !f.plumbing);
  const plumbing = fields.filter((f) => f.plumbing);
  const shown = showPlumbing ? [...meaningful, ...plumbing] : meaningful;

  return (
    <div>
      <div className="px-3 py-2 leading-relaxed">
        {shown.map((f, i) => (
          <span key={f.key} className="text-[12px] mr-4 inline-block">
            <span className={tk.text.faint}>{f.key}</span>{' '}
            <span className={f.value ? tk.text.primary : tk.text.faint}>{f.value || '—'}</span>
          </span>
        ))}
      </div>
      {plumbing.length > 0 && (
        <button
          onClick={() => setShowPlumbing((v) => !v)}
          className={cn('w-full px-3 pb-1.5 text-left text-[11px]', tk.text.faint, tk.hover)}
        >
          {showPlumbing
            ? 'hide identifiers and timestamps'
            : `${plumbing.length} more: ${plumbing.map((f) => f.key).join(', ')}`}
        </button>
      )}
    </div>
  );
}

function ProseField({ f }: { f: Field }): React.JSX.Element {
  const [showAll, setShowAll] = useState((f.chars ?? 0) <= FIELD_CHARS);
  const text = f.value ?? '';
  const isMd = useMemo(() => detectKind(text) === 'markdown', [text]);

  return (
    <div>
      <div className={cn('px-3 pt-2 text-xs font-medium', tk.text.faint)}>{f.key}</div>
      {showAll && isMd ? (
        <MarkdownView text={text} />
      ) : (
        <div className={cn('px-3 py-1 text-[12px] leading-relaxed whitespace-pre-wrap break-words', tk.text.primary)}>
          {showAll ? text : text.slice(0, FIELD_CHARS) + '…'}
        </div>
      )}
      {!showAll && (
        <ShowAll
          hidden={(f.chars ?? 0) - FIELD_CHARS}
          unit="characters"
          onClick={() => setShowAll(true)}
        />
      )}
    </div>
  );
}

function ScalarListField({ f }: { f: Field }): React.JSX.Element {
  return (
    <div className="px-3 py-1.5 text-[12px]">
      <span className={tk.text.faint}>
        {f.key} ({f.count})
      </span>{' '}
      <span className={tk.text.primary}>{f.value}</span>
    </div>
  );
}

function RecordsField({ f }: { f: Field }): React.JSX.Element | null {
  const table = useMemo(() => toRecords(f.raw), [f.raw]);
  return (
    <div>
      <div className={cn('px-3 pt-2 pb-1 text-xs font-medium', tk.text.faint)}>
        {f.key} ({f.count?.toLocaleString()})
      </div>
      {table ? <Grid header={table.header} body={table.body} /> : <RawJsonView value={f.raw} />}
    </div>
  );
}

/**
 * Renders every top-level field. Short scalars pack together on one strip; arrays,
 * long text and nested objects each get their own block. Nothing is dropped.
 */
function FieldsView({ value }: { value: unknown }): React.JSX.Element {
  const fields = useMemo(() => describeFields(value), [value]);
  if (!fields.length) return <RawJsonView value={value} />;

  const scalars = fields.filter((f) => f.kind === 'scalar');
  const blocks = fields.filter((f) => f.kind !== 'scalar');

  return (
    <div className={cn('divide-y', tk.separator)}>
      {scalars.length > 0 && <ScalarStrip fields={scalars} />}
      {blocks.map((f) => (
        <div key={f.key}>
          {f.kind === 'prose' && <ProseField f={f} />}
          {f.kind === 'scalars' && <ScalarListField f={f} />}
          {f.kind === 'records' && <RecordsField f={f} />}
          {f.kind === 'object' && (
            <div>
              <div className={cn('px-3 pt-2 text-xs font-medium', tk.text.faint)}>{f.key}</div>
              {/* JsonView, not FieldsView — a `{nodes: [...]}` wrapper descends to an array. */}
              <JsonView value={f.raw} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function JsonView({ value }: { value: unknown }): React.JSX.Element {
  const core = useMemo(() => descendSingleKey(value), [value]);
  const table = useMemo(() => (Array.isArray(core) ? toRecords(core) : null), [core]);

  // A list of same-shaped objects is a table; an object keeps its field structure.
  if (Array.isArray(core)) {
    if (table) return <Grid header={table.header} body={table.body} />;
    // A one-element list is that element — a table of one row reads worse than its fields.
    if (core.length === 1 && typeof core[0] === 'object' && core[0] !== null) {
      return <FieldsView value={core[0]} />;
    }
    return <RawJsonView value={core} />;
  }
  return <FieldsView value={core} />;
}

function RawJsonView({ value }: { value: unknown }): React.JSX.Element {
  const clean = useMemo(() => stripNoise(value), [value]);
  const pretty = useMemo(() => JSON.stringify(clean, null, 2), [clean]);
  const [showAll, setShowAll] = useState(pretty.length <= FULL_RENDER_BYTES);
  const lines = pretty.split('\n');
  const shown = showAll ? pretty : lines.slice(0, PREVIEW_LINES).join('\n');

  return (
    <div>
      <pre
        className={cn(
          'm-0 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words max-h-96 overflow-auto',
          tk.codeBg, tk.text.primary, tk.scrollbar,
        )}
      >
        {shown}
      </pre>
      {!showAll && lines.length > PREVIEW_LINES && (
        <ShowAll hidden={lines.length - PREVIEW_LINES} unit="lines" onClick={() => setShowAll(true)} />
      )}
    </div>
  );
}

function TextView({ text }: { text: string }): React.JSX.Element {
  const [showAll, setShowAll] = useState(text.length <= FULL_RENDER_BYTES);
  const lines = text.split('\n');
  const shown = showAll ? text : lines.slice(0, PREVIEW_LINES).join('\n');

  return (
    <div>
      <pre
        className={cn(
          'm-0 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words max-h-96 overflow-auto',
          tk.codeBg, tk.text.primary, tk.scrollbar,
        )}
      >
        {shown}
      </pre>
      {!showAll && lines.length > PREVIEW_LINES && (
        <ShowAll hidden={lines.length - PREVIEW_LINES} unit="lines" onClick={() => setShowAll(true)} />
      )}
    </div>
  );
}

// ── Main ──

export function McpResultBody({ result, isError }: McpResultBodyProps): React.JSX.Element | null {
  const u = useMemo(() => unwrapResult(result), [result]);

  if (!result) return null;

  return (
    <div>
      {(isError || u.isError) && (
        <div className="px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400/80">
          {u.tool ? `${u.tool} failed` : 'Tool call failed'}
        </div>
      )}

      {u.kind === 'csv' ? (
        <TableView text={u.text} />
      ) : u.kind === 'markdown' ? (
        <MarkdownView text={u.text} />
      ) : u.kind === 'json' && u.json !== undefined ? (
        <JsonView value={u.json} />
      ) : u.kind === 'empty' ? (
        <div className={cn('px-3 py-2 text-[12px]', tk.text.faint)}>no content returned</div>
      ) : (
        <TextView text={u.text} />
      )}
    </div>
  );
}

export type { UnwrappedResult };
