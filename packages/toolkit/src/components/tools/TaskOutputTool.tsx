import React, { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { cn } from '../../utils/cn.js';
import { tk, accent } from '../../tokens.js';

interface TaskOutputToolProps {
  input: { task_id?: string; block?: boolean; timeout?: number };
  result: string;
  isPending?: boolean;
}

const AUTO_EXPAND_THRESHOLD = 5;

export function TaskOutputTool({ input, result, isPending = false }: TaskOutputToolProps): React.JSX.Element {
  const taskId = input?.task_id || 'unknown';
  const isBlocking = input?.block !== false;
  const resultLines = result ? result.split('\n').filter(l => l.trim()).length : 0;
  const [isExpanded, setIsExpanded] = useState(() => resultLines > 0 && resultLines <= AUTO_EXPAND_THRESHOLD);

  const getSummary = (): string => {
    if (isPending) return isBlocking ? 'Waiting for task...' : 'Checking status...';
    if (result) {
      const firstLine = result.split('\n')[0].slice(0, 60);
      return firstLine.length < result.split('\n')[0].length ? firstLine + '...' : firstLine;
    }
    return 'completed';
  };

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.purple.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2">
            {isPending ? (
              <Loader2 size={14} className={`${accent.purple.icon} animate-spin flex-shrink-0`} />
            ) : (
              <Download size={14} className={`${accent.purple.icon} flex-shrink-0`} />
            )}
            <span className={`text-xs ${tk.text.muted}`}>Output</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{getSummary()}</span>
          <span className={`text-[13px] ${tk.text.faint} font-mono`}>{taskId.slice(0, 8)}</span>
        </>
      )}
      content={(
        <div className={`border-t ${tk.separator}`}>
          {result ? (
            <pre className={cn('m-0 px-3 py-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words max-h-96 overflow-auto', tk.codeBg, tk.text.primary)}>
              {result}
            </pre>
          ) : !isPending ? (
            <div className={`px-3 py-3 text-xs ${tk.text.muted}`}>No output received</div>
          ) : null}
        </div>
      )}
    />
  );
}
