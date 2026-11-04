import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/web/chat/components/ui/tooltip';
import { UNDO_WINDOW_MS, type PendingUndo } from './pending-undo';

interface UndoButtonProps {
  pending: PendingUndo;
  onUndo: () => void;
  /** `icon` keeps a toolbar icon's footprint; `menu` keeps the phone's menu button's. */
  variant: 'icon' | 'menu';
}

/** Stands in for the button that archived or slept a session; the bar under it empties as the chance to undo runs out. */
export function UndoButton({ pending, onUndo, variant }: UndoButtonProps): JSX.Element {
  // A negative delay picks the bar up where it was when this header mounted.
  // Read once: changing the delay of a running animation shifts it again.
  const [elapsed] = useState(() => Math.min(Date.now() - pending.startedAt, UNDO_WINDOW_MS));
  const label = pending.action === 'archive' ? 'Undo archive' : 'Undo sleep';
  const bar = (
    <span aria-hidden className="absolute left-0 right-0 -bottom-[5px] h-[2px] rounded-full bg-line overflow-hidden">
      <span
        className="block h-full rounded-full bg-fg-3 origin-left"
        style={{ animation: `undoCountdown ${UNDO_WINDOW_MS}ms linear ${-elapsed}ms forwards` }}
      />
    </span>
  );

  if (variant === 'menu') {
    return (
      <button
        type="button"
        onClick={onUndo}
        aria-label={label}
        data-testid="session-undo"
        className="flex items-center justify-center w-10 h-10 ui-icon-btn text-fg touch-manipulation"
      >
        <span className="relative block">
          <Undo2 size={20} />
          {bar}
        </span>
      </button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onUndo}
          aria-label={label}
          data-testid="session-undo"
          className="p-1.5 ui-icon-btn text-fg"
        >
          <span className="relative block">
            <Undo2 size={16} />
            {bar}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
