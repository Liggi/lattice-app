import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { cn } from '@/web/chat/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/web/chat/components/ui/tooltip';
import { copyText } from '../../utils/copy-text';

type CopyState = 'idle' | 'copied' | 'failed';

const LABEL: Record<CopyState, string> = {
  idle: 'Copy',
  copied: 'Copied',
  failed: "Couldn't copy. Select the text and copy it instead.",
};

/**
 * The copy icon in a code block's top-right corner. It shows when the block
 * is hovered or the button focused, and always on touch, where there is no
 * hover. After a click the icon becomes a check, or a cross with a tooltip
 * held open when the browser refused the copy, so a failure is never silent.
 */
export function CodeCopyButton({ text, className }: { text: string; className?: string }): JSX.Element {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = copyText(text) ? 'copied' : 'failed';
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), next === 'copied' ? 1500 : 4000);
  };

  return (
    <Tooltip open={state === 'failed' ? true : undefined}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={LABEL[state]}
          data-testid="code-copy"
          className={cn(
            'absolute top-2 z-10 flex h-6 w-6 items-center justify-center rounded-sm bg-surface text-fg-3 transition-opacity hover:text-fg touch-manipulation',
            'opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100',
            state !== 'idle' && 'opacity-100',
            className,
          )}
        >
          {state === 'copied' ? <Check size={12} className="text-emerald-400" />
            : state === 'failed' ? <X size={12} className="text-rose-400" />
            : <Copy size={12} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[240px]">{LABEL[state]}</TooltipContent>
    </Tooltip>
  );
}
