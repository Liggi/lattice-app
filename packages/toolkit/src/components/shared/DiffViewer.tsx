import React, { useMemo, useState, useEffect } from 'react';
import { diffLines, diffWords } from 'diff';
import { Maximize2, Minimize2 } from 'lucide-react';
import { codeToTokens, type ThemedToken } from 'shiki';
import { cn } from '../../utils/cn.js';
import { useToolkitTheme } from '../../context.js';
import { tk } from '../../tokens.js';

interface DiffViewerProps {
  oldValue: string;
  newValue: string;
  language?: string;
}

// ── Types ──

interface DiffSegment {
  text: string;
  type: 'added' | 'removed' | 'unchanged';
}

interface DiffLine {
  id: string;
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  /** Word-level diff segments for changed lines. */
  segments?: DiffSegment[];
  /** Line number in old file (for removed/unchanged). */
  oldLineNum?: number;
  /** Line number in new file (for added/unchanged). */
  newLineNum?: number;
}

// ── Diff computation ──

/** Compute word-level segments for a pair of old/new text blocks. */
function computeWordSegments(
  oldText: string,
  newText: string,
): { oldSegments: DiffSegment[][]; newSegments: DiffSegment[][] } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const oldSegments: DiffSegment[][] = oldLines.map(l => [{ text: l, type: 'removed' }]);
  const newSegments: DiffSegment[][] = newLines.map(l => [{ text: l, type: 'added' }]);

  // Pair up lines 1:1 for word-level diff where we can
  const pairCount = Math.min(oldLines.length, newLines.length);
  for (let i = 0; i < pairCount; i++) {
    const wordDiff = diffWords(oldLines[i], newLines[i]);
    const oldSegs: DiffSegment[] = [];
    const newSegs: DiffSegment[] = [];

    for (const part of wordDiff) {
      if (part.added) {
        newSegs.push({ text: part.value, type: 'added' });
      } else if (part.removed) {
        oldSegs.push({ text: part.value, type: 'removed' });
      } else {
        oldSegs.push({ text: part.value, type: 'unchanged' });
        newSegs.push({ text: part.value, type: 'unchanged' });
      }
    }

    oldSegments[i] = oldSegs;
    newSegments[i] = newSegs;
  }

  return { oldSegments, newSegments };
}

function computeDiffLines(oldValue: string, newValue: string): DiffLine[] {
  const changes = diffLines(oldValue, newValue);
  const lines: DiffLine[] = [];
  let nextId = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  // First pass: collect raw changes and identify removed→added pairs for word-level diff
  interface RawBlock {
    type: 'added' | 'removed' | 'unchanged';
    value: string;
  }
  const blocks: RawBlock[] = changes.map(c => ({
    type: c.added ? 'added' as const : c.removed ? 'removed' as const : 'unchanged' as const,
    value: c.value,
  }));

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const blockLines = block.value.split('\n');
    if (blockLines[blockLines.length - 1] === '') blockLines.pop();

    if (block.type === 'unchanged') {
      for (const line of blockLines) {
        lines.push({
          id: `d-${nextId++}`,
          type: 'unchanged',
          content: line,
          oldLineNum: oldLineNum++,
          newLineNum: newLineNum++,
        });
      }
    } else if (block.type === 'removed') {
      // Check if next block is 'added' — if so, compute word-level diff
      const nextBlock = blocks[bi + 1];
      if (nextBlock?.type === 'added') {
        const { oldSegments, newSegments } = computeWordSegments(block.value.replace(/\n$/, ''), nextBlock.value.replace(/\n$/, ''));

        for (let i = 0; i < oldSegments.length; i++) {
          lines.push({
            id: `d-${nextId++}`,
            type: 'removed',
            content: blockLines[i] || '',
            segments: oldSegments[i],
            oldLineNum: oldLineNum++,
          });
        }

        const addedLines = nextBlock.value.split('\n');
        if (addedLines[addedLines.length - 1] === '') addedLines.pop();
        for (let i = 0; i < addedLines.length; i++) {
          lines.push({
            id: `d-${nextId++}`,
            type: 'added',
            content: addedLines[i],
            segments: newSegments[i],
            newLineNum: newLineNum++,
          });
        }

        bi++; // skip the next (added) block
      } else {
        // Standalone removed block
        for (const line of blockLines) {
          lines.push({
            id: `d-${nextId++}`,
            type: 'removed',
            content: line,
            oldLineNum: oldLineNum++,
          });
        }
      }
    } else {
      // Standalone added block (no preceding removed)
      for (const line of blockLines) {
        lines.push({
          id: `d-${nextId++}`,
          type: 'added',
          content: line,
          newLineNum: newLineNum++,
        });
      }
    }
  }

  return lines;
}

// ── Syntax highlighting ──

/** Tokenize source text with shiki for per-line token coloring. */
function useTokenizedLines(text: string, language: string, theme: string): ThemedToken[][] | null {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  useEffect(() => {
    if (!text || language === 'text') { setTokens(null); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    codeToTokens(text, { lang: language, theme } as any)
      .then(result => setTokens(result.tokens))
      .catch(() => setTokens(null));
  }, [text, language, theme]);
  return tokens;
}

/** Render a line using shiki tokens for syntax coloring. */
function SyntaxLine({ tokens }: { tokens: ThemedToken[] }): React.JSX.Element {
  if (!tokens.length) return <>{' '}</>;
  return (
    <>
      {tokens.map((token, i) => (
        <span key={i} style={{ color: token.color }}>{token.content}</span>
      ))}
    </>
  );
}

// ── Rendering ──

function SegmentedContent({ segments }: { segments: DiffSegment[] }): React.JSX.Element {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'unchanged') {
          return <span key={i}>{seg.text}</span>;
        }
        // Highlighted changed word
        const highlight = seg.type === 'added'
          ? 'bg-emerald-500/25 dark:bg-emerald-400/20 rounded-sm'
          : 'bg-red-500/25 dark:bg-red-400/20 rounded-sm';
        return <span key={i} className={highlight}>{seg.text}</span>;
      })}
    </>
  );
}

const MAX_COLLAPSED = 12;

export function DiffViewer({ oldValue, newValue, language = 'text' }: DiffViewerProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const normalizedOld = oldValue ?? '';
  const normalizedNew = newValue ?? '';
  const theme = useToolkitTheme();
  const shikiTheme = theme === 'dark' ? 'github-dark-default' : 'github-light-default';

  const diffResult = useMemo(
    () => computeDiffLines(normalizedOld, normalizedNew),
    [normalizedOld, normalizedNew],
  );

  // Syntax-highlight old and new text separately, then map tokens to diff lines
  const oldTokens = useTokenizedLines(normalizedOld, language, shikiTheme);
  const newTokens = useTokenizedLines(normalizedNew, language, shikiTheme);

  // Build lookup: line number → token array
  const oldTokenMap = useMemo(() => {
    if (!oldTokens) return null;
    const map = new Map<number, ThemedToken[]>();
    oldTokens.forEach((tokens, i) => map.set(i + 1, tokens));
    return map;
  }, [oldTokens]);

  const newTokenMap = useMemo(() => {
    if (!newTokens) return null;
    const map = new Map<number, ThemedToken[]>();
    newTokens.forEach((tokens, i) => map.set(i + 1, tokens));
    return map;
  }, [newTokens]);

  const totalLines = diffResult.length;
  const shouldShowExpandButton = totalLines > MAX_COLLAPSED;
  const linesToShow = isExpanded ? diffResult : diffResult.slice(0, MAX_COLLAPSED);
  const hiddenCount = totalLines - MAX_COLLAPSED;

  if (normalizedOld === normalizedNew) {
    return (
      <div className={cn('p-3 font-mono text-[13px]', tk.text.muted, tk.codeBg)}>
        No changes
      </div>
    );
  }

  return (
    <div className={cn('relative overflow-hidden', tk.codeBg)}>
      {shouldShowExpandButton && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={cn(
            'absolute top-2 right-2 h-6 w-6 p-0 z-10 flex items-center justify-center rounded transition-colors cursor-pointer',
            'text-stone-400 hover:text-stone-600 bg-stone-100/80',
            'dark:text-stone-600 dark:hover:text-stone-400 dark:bg-stone-900/80',
          )}
          aria-label={isExpanded ? 'Show fewer lines' : 'Show all lines'}
        >
          {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      )}

      <div className="font-mono text-[13px] leading-relaxed">
        {linesToShow.map((line) => {
          const bgClass = line.type === 'added'
            ? 'bg-emerald-500/8 dark:bg-emerald-500/8'
            : line.type === 'removed'
              ? 'bg-red-500/8 dark:bg-red-500/8'
              : '';

          const prefixClass = line.type === 'added'
            ? 'text-emerald-600 dark:text-emerald-400/70'
            : line.type === 'removed'
              ? 'text-red-600 dark:text-red-400/70'
              : tk.text.faint;

          const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
          const contentOpacity = line.type === 'unchanged' ? 'opacity-50' : '';

          return (
            <div key={line.id} className={cn('flex', bgClass)}>
              {/* Line number gutter */}
              <span className={cn('select-none w-8 text-right pr-1 shrink-0 text-[11px] tabular-nums', tk.text.faint)}>
                {line.oldLineNum ?? ''}
              </span>
              <span className={cn('select-none w-8 text-right pr-1 shrink-0 text-[11px] tabular-nums', tk.text.faint)}>
                {line.newLineNum ?? ''}
              </span>
              {/* +/- prefix */}
              <span className={cn('select-none w-5 text-center shrink-0 border-r', prefixClass, line.type === 'unchanged' ? tk.separator : line.type === 'added' ? 'border-emerald-500/20' : 'border-red-500/20')}>
                {prefix}
              </span>
              {/* Content with optional word-level highlighting */}
              <span className={cn('flex-1 whitespace-pre-wrap break-words pl-2 pr-3', tk.text.primary, contentOpacity)}>
                {line.segments ? (
                  <SegmentedContent segments={line.segments} />
                ) : (() => {
                  // Use syntax highlighting for unchanged lines when available
                  const tokenMap = line.type === 'removed' ? oldTokenMap
                    : line.type === 'added' ? newTokenMap
                    : (oldTokenMap || newTokenMap);
                  const lineNum = line.type === 'removed' ? line.oldLineNum
                    : line.type === 'added' ? line.newLineNum
                    : (line.oldLineNum || line.newLineNum);
                  const tokens = lineNum && tokenMap?.get(lineNum);
                  if (tokens) return <SyntaxLine tokens={tokens} />;
                  return <>{line.content || ' '}</>;
                })()}
              </span>
            </div>
          );
        })}
      </div>

      {!isExpanded && shouldShowExpandButton && (
        <div className={cn(
          'text-center text-xs py-2 border-t border-emerald-500/20',
          tk.text.muted,
          'bg-stone-50/50 dark:bg-stone-950/50',
        )}>
          +{hiddenCount} more lines
        </div>
      )}
    </div>
  );
}
