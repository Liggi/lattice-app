import React, { useState } from 'react';
import { Circle, Clock, CheckCircle, Pause, XCircle } from 'lucide-react';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { cn } from '../../utils/cn.js';
import { tk, accent } from '../../tokens.js';

interface TaskManagementToolProps {
  input: {
    subject?: string; description?: string; activeForm?: string; status?: string;
    taskId?: string; id?: string;
    addBlockedBy?: string[]; removeBlockedBy?: string[];
    blocks?: string[]; blockedBy?: string[];
  };
  result: string;
  isUpdate: boolean;
}

function getStatusIcon(status: string | undefined): React.JSX.Element {
  switch (status) {
    case 'completed': case 'done':
      return <CheckCircle size={14} className="text-emerald-400/80 flex-shrink-0" />;
    case 'in_progress': case 'current':
      return <Clock size={14} className="text-cyan-400/80 flex-shrink-0" />;
    case 'paused':
      return <Pause size={14} className="text-amber-400/80 flex-shrink-0" />;
    case 'abandoned':
      return <XCircle size={14} className={`${tk.text.muted} flex-shrink-0`} />;
    default:
      return <Circle size={14} className="text-stone-400/80 dark:text-stone-400/80 flex-shrink-0" />;
  }
}

function getStatusBadge(status: string | undefined): React.JSX.Element | null {
  const base = 'text-[13px] px-1.5 py-0.5 rounded';
  switch (status) {
    case 'completed': case 'done':
      return <span className={`${base} bg-emerald-500/15 text-emerald-400/80`}>done</span>;
    case 'in_progress': case 'current':
      return <span className={`${base} bg-cyan-500/15 text-cyan-400/80`}>active</span>;
    case 'paused':
      return <span className={`${base} bg-amber-500/15 text-amber-400/80`}>paused</span>;
    case 'abandoned':
      return <span className={`${base} bg-stone-500/15 ${tk.text.muted}`}>abandoned</span>;
    default: return null;
  }
}

export function TaskManagementTool({ input, result, isUpdate }: TaskManagementToolProps): React.JSX.Element {
  const taskSubject = input.subject || input.activeForm || '';
  const taskId = input.taskId || input.id || '';
  const status = input.status;
  const description = input.description;
  const hasBlockedBy = (input.blockedBy && input.blockedBy.length > 0) || (input.addBlockedBy && input.addBlockedBy.length > 0);

  let summaryText = '';
  if (isUpdate) {
    summaryText = taskId ? `#${taskId}${status ? ` → ${status}` : ''}` : 'Update task';
  } else {
    summaryText = taskSubject?.slice(0, 60) || 'Create task';
    if (taskSubject && taskSubject.length > 60) summaryText += '...';
  }

  const hasExpandableContent = description || hasBlockedBy || (result && result.trim());
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.cyan.card}
      canExpand={!!hasExpandableContent}
      headerContent={(
        <>
          <div className="flex items-center gap-2">
            {getStatusIcon(status)}
            <span className={`text-xs ${tk.text.muted}`}>{isUpdate ? 'Update' : 'Task'}</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{summaryText}</span>
          {status && getStatusBadge(status)}
        </>
      )}
      content={hasExpandableContent ? (
        <div className={`border-t ${tk.separator} px-3 py-3 space-y-2`}>
          {!isUpdate && taskSubject && taskSubject.length > 60 && (
            <div className={`text-xs ${tk.text.primary}`}>{taskSubject}</div>
          )}
          {description && <div className={`text-xs ${tk.text.secondary}`}>{description}</div>}
          {hasBlockedBy && (
            <div className={`text-[13px] ${tk.text.muted}`}>
              <span className="text-cyan-400/80">Blocked by:</span>{' '}
              {(input.blockedBy || input.addBlockedBy || []).join(', ')}
            </div>
          )}
          {result && result.trim() && (
            <pre className={cn('m-0 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words rounded p-2', tk.codeBg, tk.text.primary)}>
              {result}
            </pre>
          )}
        </div>
      ) : undefined}
    />
  );
}
