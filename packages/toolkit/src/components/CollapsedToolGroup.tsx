import React, { useState, useEffect } from 'react';
import { ChevronDown, FileText, FolderOpen, Globe, Layers, Loader2, Search } from 'lucide-react';
import { cn } from '../utils/cn.js';
import { codeToHtml } from 'shiki';
import { useToolkitTheme } from '../context.js';
import { detectLanguageFromPath } from '../utils/language-detection.js';
import { SearchResultContent, ProseResultContent } from './shared/WebResultContent.js';
import { stripRerunFooter } from '../utils/tool-utils.js';
import { tk } from '../tokens.js';

// ---- Types ----

export type TemporalState = 'active' | 'recent' | 'historical';
type ToolType = 'read' | 'grep' | 'glob' | 'ls' | 'web-search' | 'web-fetch' | 'tool-search';

export interface ToolCallData {
  tool: ToolType;
  input: string;
  filePath?: string;
  resultContent?: string;
  status: 'pending' | 'success' | 'error';
}

export interface CollapsedGroupData {
  id: string;
  summary: string;
  toolCalls: ToolCallData[];
  isActive?: boolean;
  latestHint?: string;
  timestamp: string;
}

interface CollapsedToolGroupProps {
  group: CollapsedGroupData;
  temporalState: TemporalState;
}

// ---- Tool metadata ----

const toolMeta: Record<ToolType, { icon: typeof FileText; label: string; color: string }> = {
  // One neutral icon colour: the group is a quiet summary, not a legend.
  read:          { icon: FileText,   label: 'Read',   color: tk.text.muted },
  grep:          { icon: Search,     label: 'Grep',   color: tk.text.muted },
  glob:          { icon: FolderOpen, label: 'Glob',   color: tk.text.muted },
  ls:            { icon: FolderOpen, label: 'LS',     color: tk.text.muted },
  'web-search':  { icon: Globe,      label: 'Search', color: tk.text.muted },
  'web-fetch':   { icon: Globe,      label: 'Fetch',  color: tk.text.muted },
  'tool-search': { icon: Search,     label: 'Tools',  color: tk.text.muted },
};

// ---- Helpers ----

function stripLineNumbers(content: string): string {
  return content.replace(/^\d+\t/gm, '');
}

function SyntaxHighlightedCode({ code, language }: { code: string; language: string }): React.JSX.Element {
  const theme = useToolkitTheme();
  const shikiTheme = theme === 'dark' ? 'github-dark-default' : 'github-light-default';
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    codeToHtml(code, { lang: language, theme: shikiTheme })
      .then(setHtml).catch(() => setHtml(null));
  }, [code, language, shikiTheme]);

  if (!html) {
    return (
      <pre className={cn('px-3 py-2.5 text-[13px] whitespace-pre-wrap break-words leading-relaxed', tk.text.secondary)}>
        {code}
      </pre>
    );
  }

  return (
    <div
      className="[&_pre]:!bg-transparent [&_pre]:px-3 [&_pre]:py-2.5 [&_pre]:text-[13px] [&_pre]:leading-relaxed [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:!bg-transparent"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ---- Animated hint ----

function AnimatedHint({ hint }: { hint: string }): React.JSX.Element {
  const [displayedHint, setDisplayedHint] = useState(hint);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (hint !== displayedHint) {
      setIsAnimating(true);
      const timeout = setTimeout(() => { setDisplayedHint(hint); setIsAnimating(false); }, 150);
      return () => clearTimeout(timeout);
    }
  }, [hint, displayedHint]);

  return (
    <span className={cn('inline-flex items-center overflow-hidden h-4 ml-2 pl-2 border-l', tk.separator)}>
      <span className="relative overflow-hidden h-4 inline-flex items-center">
        <span className={cn(
          'text-[11px] transition-all duration-150 ease-out',
          tk.text.faint,
          isAnimating ? '-translate-y-full opacity-0' : 'translate-y-0 opacity-100',
        )}>
          {displayedHint}
        </span>
      </span>
    </span>
  );
}

// ---- Component ----

export function CollapsedToolGroup({ group, temporalState }: CollapsedToolGroupProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedCalls, setExpandedCalls] = useState<Set<number>>(new Set());

  const toggleCallExpanded = (index: number) => {
    setExpandedCalls((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  return (
    <div className={cn('w-fit max-w-full rounded-lg border transition-all duration-200', tk.card.border, tk.card.bg)}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer group"
      >
        <div className="flex-shrink-0">
          {temporalState === 'active' ? (
            <Loader2 className={cn('w-3.5 h-3.5 animate-spin', tk.text.secondary)} />
          ) : (
            <Layers className={cn('w-3.5 h-3.5', tk.text.secondary)} />
          )}
        </div>
        <span className={cn('flex-1 min-w-0 text-xs truncate', tk.text.secondary)}>
          {group.summary}
          {temporalState === 'active' && group.latestHint && <AnimatedHint hint={group.latestHint} />}
        </span>
        <ChevronDown className={cn(
          'w-3 h-3 transition-all duration-200 flex-shrink-0',
          tk.text.muted,
          `group-hover:${tk.text.secondary}`,
          isExpanded && 'rotate-180',
        )} />
      </button>

      {isExpanded && (
        <div className="px-3 pb-3">
          <div className={cn('border-t pt-2 space-y-1', tk.separator)}>
            {group.toolCalls.map((call, index) => {
              const meta = toolMeta[call.tool] ?? toolMeta.read;
              const Icon = meta.icon;
              const isCallExpanded = expandedCalls.has(index);
              const cleanedResult = call.resultContent ? stripRerunFooter(call.resultContent) : call.resultContent;
              const hasResult = cleanedResult && call.status === 'success';
              const language = call.tool === 'read' ? (detectLanguageFromPath(call.filePath ?? call.input) || 'text') : 'text';

              return (
                <div key={index}>
                  <button
                    onClick={(e) => { e.stopPropagation(); if (hasResult) toggleCallExpanded(index); }}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors',
                      hasResult && `cursor-pointer ${tk.hover}`,
                      !hasResult && 'cursor-default',
                    )}
                  >
                    <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', meta.color)} />
                    <span className={cn('flex-1 text-xs truncate', tk.text.secondary)}>{call.input}</span>
                    {hasResult && (
                      <ChevronDown className={cn('w-3 h-3 transition-transform duration-150 flex-shrink-0', tk.text.faint, isCallExpanded && 'rotate-180')} />
                    )}
                    {call.status === 'pending' && (
                      <Loader2 className={cn('w-3 h-3 animate-spin flex-shrink-0', tk.text.faint)} />
                    )}
                  </button>

                  {isCallExpanded && hasResult && (
                    <div className="mt-1.5 mb-2">
                      <div className={cn(
                        'relative rounded-md border overflow-hidden max-h-60 overflow-y-auto',
                        tk.codeBg, 'border-stone-200 dark:border-stone-800/60', tk.scrollbar,
                      )}>
                        <div className="absolute inset-y-0 left-0 w-0.5 bg-stone-300 dark:bg-stone-700" />
                        {call.tool === 'read' ? (
                          <SyntaxHighlightedCode code={stripLineNumbers(cleanedResult!)} language={language} />
                        ) : call.tool === 'web-search' ? (
                          <SearchResultContent result={cleanedResult!} compact />
                        ) : (
                          <ProseResultContent content={cleanedResult!} compact />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
