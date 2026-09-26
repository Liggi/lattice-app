import React, { useState } from 'react';
import { Smile } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';
import { EmojiPicker } from './EmojiPicker.js';
import { useCoarsePointer } from './hooks.js';

export interface ComposerEmojiButtonProps {
  onPick: (emoji: string) => void;
  disabled?: boolean;
}

/**
 * An emoji button for the Composer's `renderLeadingActions` slot: the
 * reaction picker, inserting at the caret through `ComposerRef.insertText`.
 * Sized and coloured like the Composer's own foot buttons.
 */
export function ComposerEmojiButton({ onPick, disabled }: ComposerEmojiButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const coarse = useCoarsePointer();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Insert emoji"
          data-testid="composer-emoji"
          className="relative flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-composer-text-faint transition-colors duration-100 before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-full before:min-w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] hover:bg-composer-surface-elevated hover:text-composer-text disabled:cursor-not-allowed disabled:opacity-45 data-[state=open]:bg-composer-surface-elevated data-[state=open]:text-composer-text"
        >
          <Smile size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-auto p-0"
        // The picker decides focus itself: its search box on desktop, nothing
        // on touch, where focusing it would raise the keyboard over the grid.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Focus goes back to the input on pick, not to the trigger.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {open && (
          <EmojiPicker
            autoFocus={!coarse}
            onPick={(emoji) => {
              setOpen(false);
              onPick(emoji);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
