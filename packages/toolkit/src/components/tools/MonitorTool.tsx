import React, { useState } from 'react';
import { Activity } from 'lucide-react';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { cn } from '../../utils/cn.js';
import { tk, accent } from '../../tokens.js';

interface MonitorToolProps {
  input: { description?: string; command?: string; timeout_ms?: number; persistent?: boolean };
  result: string;
  isPending?: boolean;
}

export function MonitorTool({ input, result, isPending = false }: MonitorToolProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const description = input?.description || 'background monitor';
  const command = input?.command || '';

  // Extract task ID from result like "Monitor started (task bhx4kzpj0, timeout 30000ms)..."
  const taskMatch = result.match(/\(task\s+(\w+)/);
  const taskId = taskMatch ? taskMatch[1] : undefined;

  const headerSummary = taskId ? `${description} · ${taskId}` : description;

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.cyan.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Activity size={14} className={`${accent.cyan.icon} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>Monitor</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{headerSummary}</span>
        </>
      )}
      content={(
        <>
          {command && (
            <div className={cn('border-t px-3 py-2.5', tk.separator, tk.codeBg)}>
              <div className="flex gap-2">
                <span className={`${tk.text.faint} font-mono text-[13px] select-none shrink-0 leading-relaxed`}>$</span>
                <pre className={cn('m-0 font-mono text-[13px] whitespace-pre-wrap break-all leading-relaxed', tk.text.primary)}>
                  {command}
                </pre>
              </div>
            </div>
          )}
          {result && !isPending && (
            <div className={cn('border-t px-3 py-2 text-[13px]', tk.separator, tk.codeBgSubtle, tk.text.secondary)}>
              {result.split('.')[0]}
            </div>
          )}
        </>
      )}
    />
  );
}
