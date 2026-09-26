import { ListTodo } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/web/chat/components/ui/tooltip';

interface HeaderNotesButtonProps {
  count: number;
  onClick: () => void;
}

export function HeaderNotesButton({ count, onClick }: HeaderNotesButtonProps): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label="Notes"
          className="relative flex items-center gap-1.5 p-1.5 ui-icon-btn"
        >
          <ListTodo size={16} />
          {count > 0 && (
            <span className="min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-surface-2 text-[11px] leading-none text-fg-2 tabular-nums">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-[300px]">
        Action queue for future work: notes and review recommendations stay here until you launch a separate session. This is different from the composer message queue.
      </TooltipContent>
    </Tooltip>
  );
}
