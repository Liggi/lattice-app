import React, { useState, useEffect, useMemo } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { codeToHtml } from 'shiki';
import { cn } from '../../utils/cn.js';
import { useToolkitTheme } from '../../context.js';
import { tk } from '../../tokens.js';

interface CodeHighlightProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  className?: string;
}

const MAX_COLLAPSED_LINES = 12;

export const CodeHighlight: React.FC<CodeHighlightProps> = ({
  code,
  language,
  showLineNumbers: _showLineNumbers = false,
  className = '',
}) => {
  const theme = useToolkitTheme();
  const shikiTheme = theme === 'dark' ? 'github-dark-default' : 'github-light-default';
  const [isExpanded, setIsExpanded] = useState(false);
  const [html, setHtml] = useState<string | null>(null);

  const lines = useMemo(() => code.trimEnd().split('\n'), [code]);
  const totalLines = lines.length;
  const shouldShowExpandButton = totalLines > MAX_COLLAPSED_LINES;
  const displayCode = isExpanded ? code.trimEnd() : lines.slice(0, MAX_COLLAPSED_LINES).join('\n');
  const hiddenLinesCount = totalLines - MAX_COLLAPSED_LINES;

  useEffect(() => {
    codeToHtml(displayCode, { lang: language, theme: shikiTheme })
      .then(setHtml)
      .catch(() => setHtml(null));
  }, [displayCode, language, shikiTheme]);

  return (
    <div className={cn('relative overflow-hidden', tk.codeBg, className)}>
      {shouldShowExpandButton && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={cn(
            'absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded transition-colors cursor-pointer',
            'text-stone-400 hover:text-stone-600 bg-stone-100/80',
            'dark:text-stone-600 dark:hover:text-stone-400 dark:bg-stone-900/80',
          )}
          aria-label={isExpanded ? 'Show fewer lines' : 'Show all lines'}
        >
          {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      )}

      {html ? (
        <div
          className="[&_pre]:!bg-transparent [&_pre]:px-3 [&_pre]:py-2.5 [&_pre]:text-[13px] [&_pre]:leading-relaxed [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:!bg-transparent"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={cn(
          'px-3 py-2.5 text-[13px] whitespace-pre-wrap break-words leading-relaxed font-mono m-0',
          tk.text.secondary,
        )}>
          {displayCode}
        </pre>
      )}

      {!isExpanded && shouldShowExpandButton && (
        <div className={cn(
          'text-center text-[13px] py-1.5',
          tk.separator,
          'border-t',
          tk.text.faint,
          'bg-stone-50/80 dark:bg-stone-950/80',
        )}>
          +{hiddenLinesCount} more lines
        </div>
      )}
    </div>
  );
};
