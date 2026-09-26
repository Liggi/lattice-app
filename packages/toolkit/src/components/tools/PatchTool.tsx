import React, { useMemo, useState } from 'react';
import { FileDiff } from 'lucide-react';
import { cn } from '../../utils/cn.js';
import { formatFilePath } from '../../utils/tool-utils.js';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { tk, accent } from '../../tokens.js';

/**
 * Codex reports file edits as `fileChange` items carrying a unified diff per path,
 * rather than the before/after pair Claude's Edit tool supplies. DiffViewer computes
 * its own diff from two strings, so it cannot render these — the hunks are parsed here.
 */
export interface PatchChange {
  path?: string;
  diff?: string;
}

export interface PatchToolInput {
  changes?: PatchChange[];
  cwd?: string;
}

interface PatchToolProps {
  input: PatchToolInput;
  result: string;
  workingDirectory?: string;
  isPending?: boolean;
}

type LineKind = 'added' | 'removed' | 'context' | 'hunk' | 'meta';

interface PatchLine {
  kind: LineKind;
  text: string;
  oldNum?: number;
  newNum?: number;
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Preamble lines that only restate the path or file mode. The card header already
 * names the file, and `--- a/x` / `+++ b/x` would otherwise read as a removed and
 * an added line.
 */
const FILE_HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to) |Binary files )/;

/** Splits a unified diff into displayable lines, tracking line numbers across hunks. */
export function parseUnifiedDiff(diff: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let oldNum = 0;
  let newNum = 0;
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      oldNum = Number(hunk[1]);
      newNum = Number(hunk[3]);
      inHunk = true;
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (FILE_HEADER.test(raw)) continue;
    // Anything else before the first hunk is a message from the tool, not diff content.
    if (!inHunk) {
      if (raw.trim()) lines.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'added', text: raw.slice(1), newNum: newNum++ });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'removed', text: raw.slice(1), oldNum: oldNum++ });
    } else if (raw.startsWith('\\')) {
      lines.push({ kind: 'meta', text: raw });
    } else {
      lines.push({ kind: 'context', text: raw.replace(/^ /, ''), oldNum: oldNum++, newNum: newNum++ });
    }
  }
  return lines;
}

function countLines(lines: PatchLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'added') added++;
    else if (l.kind === 'removed') removed++;
  }
  return { added, removed };
}

/** Header summary for a pending or collapsed patch: one path, or a file count. */
export function summarizePatchTargets(input: PatchToolInput, workingDirectory?: string): string {
  const changes = Array.isArray(input?.changes) ? input.changes : [];
  if (changes.length === 1) return formatFilePath(changes[0].path ?? '', workingDirectory);
  if (changes.length > 1) return `${changes.length} files`;
  return '';
}

const ROW_STYLE: Record<LineKind, string> = {
  added: 'bg-emerald-500/10 dark:bg-emerald-500/8',
  removed: 'bg-rose-500/10 dark:bg-rose-500/8',
  context: '',
  hunk: '',
  meta: '',
};

const TEXT_STYLE: Record<LineKind, string> = {
  added: 'text-emerald-800 dark:text-emerald-300',
  removed: 'text-rose-800 dark:text-rose-300',
  context: tk.text.secondary,
  hunk: tk.text.faint,
  meta: tk.text.faint,
};

const MARKER: Record<LineKind, string> = {
  added: '+', removed: '-', context: ' ', hunk: '', meta: '',
};

function DiffLines({ lines }: { lines: PatchLine[] }): React.JSX.Element {
  const gutterWidth = useMemo(() => {
    const max = lines.reduce((m, l) => Math.max(m, l.oldNum ?? 0, l.newNum ?? 0), 0);
    return `${Math.max(2, String(max).length)}ch`;
  }, [lines]);

  return (
    <div className={cn('font-mono text-[13px] leading-relaxed overflow-x-auto', tk.codeBg)}>
      {lines.map((line, i) => (
        <div key={i} className={cn('flex items-start px-2', ROW_STYLE[line.kind])}>
          <span
            className={cn('flex-shrink-0 text-right select-none tabular-nums pr-2', tk.text.faint)}
            style={{ width: gutterWidth }}
          >
            {line.oldNum ?? ''}
          </span>
          <span
            className={cn('flex-shrink-0 text-right select-none tabular-nums pr-2', tk.text.faint)}
            style={{ width: gutterWidth }}
          >
            {line.newNum ?? ''}
          </span>
          <span className={cn('flex-shrink-0 select-none w-3', TEXT_STYLE[line.kind])}>{MARKER[line.kind]}</span>
          <span className={cn('whitespace-pre-wrap break-words min-w-0', TEXT_STYLE[line.kind])}>
            {line.text || ' '}
          </span>
        </div>
      ))}
    </div>
  );
}

const AUTO_EXPAND_THRESHOLD = 5;

export function PatchTool({ input, result, workingDirectory, isPending }: PatchToolProps): React.JSX.Element {
  const changes = useMemo(() => (Array.isArray(input?.changes) ? input.changes : []), [input]);
  const parsed = useMemo(
    () => changes.map(c => ({ path: c.path ?? '', lines: parseUnifiedDiff(c.diff ?? '') })),
    [changes],
  );

  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const p of parsed) {
      const c = countLines(p.lines);
      added += c.added;
      removed += c.removed;
    }
    return { added, removed };
  }, [parsed]);

  const changedLines = totals.added + totals.removed;
  const [isExpanded, setIsExpanded] = useState(() => changedLines > 0 && changedLines <= AUTO_EXPAND_THRESHOLD);

  const deltaText = totals.added > 0 && totals.removed > 0
    ? `+${totals.added} -${totals.removed}`
    : totals.added > 0 ? `+${totals.added}`
    : totals.removed > 0 ? `-${totals.removed}`
    : '~';

  const content = parsed.length > 0 ? (
    <div className="flex flex-col">
      {parsed.map((p, i) => (
        <div key={`${p.path}-${i}`}>
          {(i > 0 || parsed.length > 1) && (
            <div className={cn('px-3 py-1.5 text-[11px] font-mono border-t', tk.separator, tk.text.secondary)}>
              {formatFilePath(p.path, workingDirectory)}
            </div>
          )}
          <DiffLines lines={p.lines} />
        </div>
      ))}
    </div>
  ) : (
    <div className={`px-3 py-2 text-sm ${tk.text.muted}`}>{result || 'No changes reported'}</div>
  );

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.emerald.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2">
            <FileDiff size={14} className={`${accent.emerald.icon} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>{isPending ? 'Patching' : 'Patch'}</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>
            {summarizePatchTargets(input, workingDirectory)}
          </span>
          <span className={cn('text-[11px] tabular-nums flex-shrink-0', tk.text.faint)}>{deltaText}</span>
        </>
      )}
      content={(
        <div className={`border-t ${tk.separator}`}>{content}</div>
      )}
    />
  );
}
