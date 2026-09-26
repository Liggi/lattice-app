import React, { useState, useMemo } from 'react';
import { ChevronDown, Search, FolderSearch, List, FileText, ChevronRight } from 'lucide-react';
import { countLines } from '../../utils/tool-utils.js';
import { cn } from '../../utils/cn.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.js';
import { tk, accent } from '../../tokens.js';

interface SearchToolProps {
  input: Record<string, unknown>;
  result: string;
  toolType: 'Grep' | 'Glob' | 'LS';
}

const AUTO_EXPAND_THRESHOLD = 5;

// ── Grep content parsing ──

interface GrepMatch {
  lineNum: string;
  content: string;
  isContext: boolean; // context line from -A/-B/-C
}

interface GrepFileGroup {
  file: string;
  shortFile: string;
  matches: GrepMatch[];
}

/** Detect whether grep output is content mode (file:line:content) vs file list. */
function isContentMode(result: string): boolean {
  const lines = result.split('\n').filter(l => l.trim());
  if (lines.length === 0) return false;
  // Content mode lines have file:num:content or file-num-content
  // Check first non-header line
  const first = lines[0].startsWith('Found ') ? lines[1] : lines[0];
  if (!first) return false;
  return /^.+?[:\-]\d+[:\-]/.test(first);
}

/** Parse ripgrep content output into file groups. */
function parseGrepContent(result: string, basePath?: string): GrepFileGroup[] {
  const lines = result.split('\n');
  const groups: Map<string, GrepMatch[]> = new Map();
  const order: string[] = [];

  for (const line of lines) {
    if (!line.trim() || line === '--') continue;
    if (line === '[Omitted long matching line]') continue;

    // Match: file:linenum:content (match line)
    const matchLine = line.match(/^(.+?):(\d+):(.*)$/);
    if (matchLine) {
      const [, file, lineNum, content] = matchLine;
      if (!groups.has(file)) { groups.set(file, []); order.push(file); }
      groups.get(file)!.push({ lineNum, content, isContext: false });
      continue;
    }

    // Context: file-linenum-content (context line from -A/-B/-C)
    const ctxLine = line.match(/^(.+?)-(\d+)-(.*)$/);
    if (ctxLine) {
      const [, file, lineNum, content] = ctxLine;
      if (!groups.has(file)) { groups.set(file, []); order.push(file); }
      groups.get(file)!.push({ lineNum, content, isContext: true });
      continue;
    }

    // Standalone line number (single-file grep, no filename prefix)
    const standaloneMatch = line.match(/^(\d+):(.*)$/);
    if (standaloneMatch) {
      const file = '(result)';
      if (!groups.has(file)) { groups.set(file, []); order.push(file); }
      groups.get(file)!.push({ lineNum: standaloneMatch[1], content: standaloneMatch[2], isContext: false });
      continue;
    }

    const standaloneCxt = line.match(/^(\d+)-(.*)$/);
    if (standaloneCxt) {
      const file = '(result)';
      if (!groups.has(file)) { groups.set(file, []); order.push(file); }
      groups.get(file)!.push({ lineNum: standaloneCxt[1], content: standaloneCxt[2], isContext: true });
      continue;
    }
  }

  return order.map(file => {
    let shortFile = file;
    if (basePath && file.startsWith(basePath)) {
      shortFile = file.slice(basePath.length).replace(/^\//, '');
    }
    // Also strip common home dir prefix
    shortFile = shortFile.replace(/^\/Users\/[^/]+\//, '~/');
    return { file, shortFile, matches: groups.get(file)! };
  });
}

/** Parse files_with_matches output (just file paths). */
function parseFileList(result: string, basePath?: string): string[] {
  return result.split('\n')
    .filter(l => l.trim() && !l.startsWith('Found ') && !l.startsWith('No '))
    .map(f => {
      let short = f.trim();
      if (basePath && short.startsWith(basePath)) short = short.slice(basePath.length).replace(/^\//, '');
      short = short.replace(/^\/Users\/[^/]+\//, '~/');
      return short;
    });
}

/** Escape regex special chars for use in RegExp constructor. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Grep sub-components ──

function HighlightedText({ text, pattern }: { text: string; pattern?: string }): React.JSX.Element {
  if (!pattern || !text) return <>{text}</>;

  try {
    const regex = new RegExp(`(${pattern})`, 'gi');
    const parts = text.split(regex);
    if (parts.length <= 1) return <>{text}</>;

    return (
      <>
        {parts.map((part, i) =>
          regex.test(part) ? (
            <mark key={i} className="bg-amber-400/30 dark:bg-amber-500/20 text-inherit rounded-sm px-0.5">{part}</mark>
          ) : (
            <React.Fragment key={i}>{part}</React.Fragment>
          ),
        )}
      </>
    );
  } catch {
    // Invalid regex pattern — fall back to plain text
    return <>{text}</>;
  }
}

function GrepContentView({ groups, pattern }: { groups: GrepFileGroup[]; pattern?: string }): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleFile = (file: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });
  };

  // For single-file results with no filename, skip the file header
  const singleAnonymous = groups.length === 1 && groups[0].file === '(result)';

  return (
    <div className={cn('max-h-96 overflow-y-auto', tk.scrollbar)}>
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.file);
        return (
          <div key={group.file}>
            {!singleAnonymous && (
              <button
                onClick={() => toggleFile(group.file)}
                className={cn(
                  'w-full flex items-center gap-1.5 px-3 py-1.5 text-left cursor-pointer select-none border-t transition-colors',
                  tk.separator, tk.hover,
                )}
              >
                <ChevronRight size={10} className={cn(
                  'flex-shrink-0 transition-transform duration-150',
                  tk.text.faint,
                  !isCollapsed && 'rotate-90',
                )} />
                <FileText size={11} className={cn('flex-shrink-0', accent.amber.icon)} />
                <span className={cn('text-[12px] font-mono truncate', tk.text.secondary)}>{group.shortFile}</span>
                <span className={cn('text-[11px] flex-shrink-0 ml-auto', tk.text.faint)}>
                  {group.matches.filter(m => !m.isContext).length}
                </span>
              </button>
            )}
            {!isCollapsed && (
              <div className={cn('font-mono text-[13px] leading-relaxed', tk.codeBg)}>
                {group.matches.map((match, i) => (
                  <div
                    key={`${match.lineNum}-${i}`}
                    className={cn(
                      'flex',
                      match.isContext ? 'opacity-50' : '',
                      !match.isContext && 'bg-amber-500/5 dark:bg-amber-500/5',
                    )}
                  >
                    <span className={cn(
                      'select-none w-10 text-right pr-2 shrink-0 border-r',
                      tk.text.faint,
                      match.isContext ? tk.separator : 'border-amber-500/30',
                    )}>
                      {match.lineNum}
                    </span>
                    <span className={cn('flex-1 pl-2 pr-3 whitespace-pre-wrap break-words', tk.text.primary)}>
                      {match.isContext ? match.content : (
                        <HighlightedText text={match.content} pattern={pattern} />
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FileListView({ files }: { files: string[] }): React.JSX.Element {
  // Group by directory
  const groups = new Map<string, string[]>();
  const dirOrder: string[] = [];
  for (const file of files) {
    const lastSlash = file.lastIndexOf('/');
    const dir = lastSlash >= 0 ? file.slice(0, lastSlash) : '.';
    const name = lastSlash >= 0 ? file.slice(lastSlash + 1) : file;
    if (!groups.has(dir)) { groups.set(dir, []); dirOrder.push(dir); }
    groups.get(dir)!.push(name);
  }

  // If only one directory, show flat list
  if (dirOrder.length === 1) {
    return (
      <div className={cn('max-h-64 overflow-y-auto', tk.scrollbar)}>
        {files.map((file, i) => (
          <div key={i} className={cn('flex items-center gap-2 px-3 py-1 font-mono text-[13px]', tk.text.primary)}>
            <FileText size={11} className={tk.text.faint} />
            <span className="truncate">{file}</span>
          </div>
        ))}
      </div>
    );
  }

  // Multiple directories — group
  return (
    <div className={cn('max-h-80 overflow-y-auto', tk.scrollbar)}>
      {dirOrder.map(dir => (
        <div key={dir}>
          <div className={cn('px-3 py-1 font-mono text-[12px] border-t', tk.text.faint, tk.separator)}>
            {dir}/
          </div>
          {groups.get(dir)!.map((name, i) => (
            <div key={i} className={cn('flex items-center gap-2 px-3 pl-6 py-0.5 font-mono text-[13px]', tk.text.primary)}>
              <FileText size={11} className={tk.text.faint} />
              <span className="truncate">{name}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Main SearchTool ──

export function SearchTool({ input, result, toolType }: SearchToolProps): React.JSX.Element {
  const resultLines = countLines(result);
  const [isExpanded, setIsExpanded] = useState(() => resultLines > 0 && resultLines <= AUTO_EXPAND_THRESHOLD);

  const pattern = input?.pattern as string | undefined;
  const basePath = input?.path as string | undefined;
  const outputMode = (input?.output_mode as string) || 'files_with_matches';

  // Parse grep results
  const grepData = useMemo(() => {
    if (toolType !== 'Grep' || !result) return null;
    if (isContentMode(result)) {
      return { mode: 'content' as const, groups: parseGrepContent(result, basePath) };
    }
    return { mode: 'files' as const, files: parseFileList(result, basePath) };
  }, [toolType, result, basePath]);

  const getToolConfig = () => {
    switch (toolType) {
      case 'Grep': {
        const grepPath = basePath ? String(basePath).split('/').pop() : '';
        const detail = grepPath ? `${pattern || ''} in ${grepPath}` : (pattern || '');
        const matchCount = grepData?.mode === 'content'
          ? grepData.groups.reduce((sum, g) => sum + g.matches.filter(m => !m.isContext).length, 0)
          : grepData?.mode === 'files' ? grepData.files.length : resultLines;
        return { icon: Search, label: 'Grep', color: accent.amber.icon, cardStyle: accent.amber.card, detail, count: matchCount };
      }
      case 'Glob':
        return { icon: FolderSearch, label: 'Glob', color: accent.violet.icon, cardStyle: accent.violet.card, detail: pattern || '', count: resultLines };
      case 'LS':
        return { icon: List, label: 'LS', color: accent.violet.icon, cardStyle: accent.violet.card, detail: (input?.path as string) || '.', count: resultLines };
    }
  };

  const config = getToolConfig();
  const Icon = config.icon;

  // Try to build a safe regex pattern for highlighting
  const highlightPattern = useMemo(() => {
    if (!pattern) return undefined;
    // If the pattern looks like a simple literal, escape it
    // If it looks intentionally like a regex, use it directly
    const hasRegexChars = /[.*+?^${}()|[\]\\]/.test(pattern);
    if (!hasRegexChars) return escapeRegex(pattern);
    // Try to compile it — if it fails, escape it
    try { new RegExp(pattern); return pattern; }
    catch { return escapeRegex(pattern); }
  }, [pattern]);

  return (
    <div className="w-fit max-w-full">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <div className={cn('border rounded-lg overflow-hidden', config.cardStyle)}>
          <CollapsibleTrigger className="w-full text-left cursor-pointer select-none">
            <div className={cn('flex items-center gap-2 px-3 py-2 transition-colors', tk.hover)}>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Icon size={14} className={config.color} />
                <span className={`text-xs ${tk.text.muted}`}>{config.label}</span>
              </div>
              <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{config.detail}</span>
              {config.count > 0 && (
                <span className={cn('text-[11px] flex-shrink-0', tk.text.faint)}>{config.count}</span>
              )}
              <ChevronDown size={12} className={cn('transition-transform duration-150 flex-shrink-0', tk.text.faint, !isExpanded && '-rotate-90')} />
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {result && (
              <div className={`border-t ${tk.separator}`}>
                {/* Structured grep content view */}
                {grepData?.mode === 'content' && grepData.groups.length > 0 ? (
                  <GrepContentView groups={grepData.groups} pattern={highlightPattern} />
                ) : grepData?.mode === 'files' && grepData.files.length > 0 ? (
                  <FileListView files={grepData.files} />
                ) : (
                  /* Fallback: raw pre for Glob, LS, or unparseable grep */
                  <pre className={cn('m-0 px-3 py-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words', tk.codeBg, tk.text.primary)}>
                    {result}
                  </pre>
                )}
              </div>
            )}
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
}
