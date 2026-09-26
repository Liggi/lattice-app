import React, { useState, useCallback } from 'react';
import { ClipboardCheck, Check, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { PROSE_CLASSES } from '../../tokens.js';
import { tk, accent } from '../../tokens.js';

type PlanOutcome = 'approved' | 'rejected';

interface PlanToolProps {
  input: { plan?: string };
  result: string;
  isPendingApproval?: boolean;
  /** Historical outcome of this plan — set by the consumer on reload when the
   *  plan has already been acted on. `false` = not yet acted on. */
  priorOutcome?: PlanOutcome | false;
  onApprove?: () => void | Promise<void>;
  onReject?: () => void | Promise<void>;
}

export function PlanTool({ input, result, isPendingApproval, priorOutcome = false, onApprove, onReject }: PlanToolProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(!!isPendingApproval && !priorOutcome);
  const [approvalState, setApprovalState] = useState<'pending' | 'approved' | 'rejected'>(
    priorOutcome ? priorOutcome : 'pending'
  );

  const planContent = input.plan || result || 'No plan provided';

  const handleApprove = useCallback(async () => {
    setApprovalState('approved');
    await onApprove?.();
  }, [onApprove]);

  const handleReject = useCallback(async () => {
    setApprovalState('rejected');
    await onReject?.();
  }, [onReject]);

  const showApprovalButtons = isPendingApproval && approvalState === 'pending';
  const statusLabel = approvalState === 'approved'
    ? 'Implementation plan'
    : approvalState === 'rejected'
      ? 'Plan rejected'
      : isPendingApproval
        ? 'Awaiting approval'
        : 'Implementation plan';

  const tableClasses = `
    [&_table]:w-full [&_table]:text-[13px]
    [&_thead]:bg-stone-100 dark:[&_thead]:bg-stone-800/20 [&_thead]:border-b ${tk.separator}
    [&_tbody]:divide-y [&_tbody]:divide-stone-200 dark:[&_tbody]:divide-stone-800/40
    [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[13px] [&_th]:text-stone-400 dark:[&_th]:text-stone-500
    [&_td]:px-3 [&_td]:py-1.5 [&_td]:text-stone-500 dark:[&_td]:text-stone-400`;

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      wrapperClassName="w-full"
      cardClassName={accent.rose.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2">
            <ClipboardCheck size={14} className={`${accent.rose.icon} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>Plan</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{statusLabel}</span>
        </>
      )}
      content={(
        <>
          <div className={`border-t ${tk.separator} px-3 py-2.5 max-h-96 overflow-y-auto ${tk.scrollbar} ${PROSE_CLASSES} ${tableClasses}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{planContent}</ReactMarkdown>
          </div>

          {showApprovalButtons && (
            <div className="border-t border-rose-500/20 bg-rose-500/5 px-3 py-2.5 flex items-center gap-3">
              <span className={`text-[13px] ${tk.text.secondary} flex-1`}>Ready to implement?</span>
              <button
                onClick={(e) => { e.stopPropagation(); void handleReject(); }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[13px] border transition-colors
                  ${tk.text.secondary} border-stone-300 dark:border-stone-700/50
                  hover:border-red-500/30 hover:text-red-400`}
              >
                <X size={11} /> Reject
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); void handleApprove(); }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[13px] text-rose-400 border border-rose-500/30 hover:bg-rose-500/10 transition-colors"
              >
                <Check size={11} /> Approve
              </button>
            </div>
          )}
        </>
      )}
    />
  );
}
