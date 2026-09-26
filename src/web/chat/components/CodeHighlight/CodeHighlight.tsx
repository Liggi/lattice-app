import React, { useState, useEffect, useMemo } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { codeToHtml } from 'shiki';
import { cn } from "@/web/chat/lib/utils";

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
  const [isExpanded, setIsExpanded] = useState(false);
  const [html, setHtml] = useState<string | null>(null);

  const lines = useMemo(() => code.trimEnd().split('\n'), [code]);
  const totalLines = lines.length;
  const shouldShowExpandButton = totalLines > MAX_COLLAPSED_LINES;

  const displayCode = isExpanded ? code.trimEnd() : lines.slice(0, MAX_COLLAPSED_LINES).join('\n');
  const hiddenLinesCount = totalLines - MAX_COLLAPSED_LINES;

  useEffect(() => {
    codeToHtml(displayCode, {
      lang: language,
      theme: 'github-dark-default',
    }).then(setHtml).catch(() => {
      setHtml(null);
    });
  }, [displayCode, language]);

  return (
    <div className={cn('relative overflow-hidden bg-bg', className)}>
      {shouldShowExpandButton && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-sm text-fg-3 hover:text-fg bg-surface transition-colors cursor-pointer"
          aria-label={isExpanded ? "Show fewer lines" : "Show all lines"}
        >
          {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      )}

      {html ? (
        <div
          className="[&_pre]:!bg-transparent [&_pre]:!border-0 [&_pre]:!rounded-none [&_pre]:m-0 [&_pre]:px-3.5 [&_pre]:py-3 [&_pre]:text-xs [&_pre]:leading-relaxed [&_pre]:overflow-x-auto [&_code]:!bg-transparent"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="px-3.5 py-3 text-xs text-fg-2 whitespace-pre-wrap leading-relaxed overflow-x-auto font-mono m-0 border-0 rounded-none">
          {displayCode}
        </pre>
      )}

      {!isExpanded && shouldShowExpandButton && (
        <div className="text-center text-xs text-fg-3 py-1.5 border-t border-line">
          +{hiddenLinesCount} more lines
        </div>
      )}
    </div>
  );
};
