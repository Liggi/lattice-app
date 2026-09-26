import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, SmilePlus } from 'lucide-react';
import { cn } from '../../utils/cn.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip.js';
import { EmojiPicker } from './EmojiPicker.js';
import { QUICK_REACTIONS } from './emoji.js';
import { useCoarsePointer } from './hooks.js';

/** Someone who reacted. */
export interface Reactor {
  id: string;
  name: string;
}

/** One emoji on a message and who put it there. */
export interface ReactionGroup {
  emoji: string;
  /** How many reacted; may exceed `reactors` when the app sends only some names. */
  count: number;
  /** Whether the viewer is one of them. Clicking the chip adds or removes only the viewer's own. */
  reactedByMe: boolean;
  /** Named on hover, in this order, under the names the app gives them. */
  reactors: readonly Reactor[];
}

/** What a reaction control does. Storage and delivery are the app's. */
export interface ReactionHandlers {
  onAdd: (emoji: string) => void;
  onRemove: (emoji: string) => void;
}

const NO_GROUPS: readonly ReactionGroup[] = [];

function mine(reactions: readonly ReactionGroup[], emoji: string): boolean {
  return reactions.some((group) => group.emoji === emoji && group.reactedByMe);
}

/** Picking an emoji the viewer already has on the message takes it off, as Slack does. */
function pickHandler(reactions: readonly ReactionGroup[], { onAdd, onRemove }: ReactionHandlers) {
  return (emoji: string) => (mine(reactions, emoji) ? onRemove(emoji) : onAdd(emoji));
}

/** "Ana, Ben and 2 others reacted with 👍": every reactor listed, then how many more `count` says there are. */
export function describeReactors(group: ReactionGroup): string {
  const names = group.reactors.map((reactor) => reactor.name);
  const others = group.count - names.length;
  if (others > 0) names.push(`${others} other${others === 1 ? '' : 's'}`);
  if (names.length === 0) return `Reacted with ${group.emoji}`;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} reacted with ${group.emoji}`;
}

// ── Menu ──

export interface ReactionMenuProps extends ReactionHandlers {
  /** The message's reactions, to mark the quick picks the viewer already has. */
  reactions?: readonly ReactionGroup[];
  /** Called after a pick, to close whatever holds the menu. */
  onDone?: () => void;
  /** Touch-sized quick picks, for the phone sheet. */
  large?: boolean;
  quickReactions?: readonly string[];
}

/** Quick picks, then every emoji behind "All emoji". */
export function ReactionMenu({ reactions = NO_GROUPS, onAdd, onRemove, onDone, large = false, quickReactions = QUICK_REACTIONS }: ReactionMenuProps): React.JSX.Element {
  const coarse = useCoarsePointer();
  const [full, setFull] = useState(false);
  const toggle = pickHandler(reactions, { onAdd, onRemove });
  const pick = (emoji: string) => {
    toggle(emoji);
    onDone?.();
  };
  if (full) return <EmojiPicker onPick={pick} autoFocus={!coarse} />;
  const size = large ? 'h-11 w-11 text-[24px]' : 'h-9 w-9 text-[20px]';
  return (
    <div className="flex items-center gap-0.5 p-1" data-testid="quick-reactions">
      {quickReactions.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => pick(emoji)}
          aria-pressed={mine(reactions, emoji)}
          // leading-none after the size: tailwind-merge drops a leading-* that precedes a font size.
          className={cn('flex items-center justify-center rounded-sm hover:bg-reaction-surface-hover', size, 'leading-none', mine(reactions, emoji) && 'bg-reaction-accent-soft')}
        >
          {emoji}
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-reaction-border-strong" />
      <button
        type="button"
        onClick={() => setFull(true)}
        className={cn('flex items-center gap-0.5 rounded-sm px-2 text-[12px] font-medium text-reaction-text-secondary hover:bg-reaction-surface-hover hover:text-reaction-text', large ? 'h-11' : 'h-9')}
      >
        All emoji
        <ChevronRight size={12} />
      </button>
    </div>
  );
}

// ── Add button (desktop) ──

export interface AddReactionButtonProps extends ReactionHandlers {
  reactions?: readonly ReactionGroup[];
  quickReactions?: readonly string[];
  className?: string;
}

/** The add-reaction control on desktop: a popover with the reaction menu. */
export function AddReactionButton({ reactions, onAdd, onRemove, quickReactions, className }: AddReactionButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            'touch-manipulation rounded-sm p-1.5 text-reaction-text-secondary transition-colors hover:bg-reaction-surface-hover hover:text-reaction-text',
            open && 'bg-reaction-surface-hover text-reaction-text',
            className,
          )}
          title="Add reaction"
          aria-label="Add reaction"
          data-testid="add-reaction"
        >
          <SmilePlus size={14} />
        </button>
      </PopoverTrigger>
      {/* Remounted on each open, so it opens on the quick picks again. */}
      <PopoverContent align="end" className="w-auto p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
        {open && (
          <ReactionMenu reactions={reactions} onAdd={onAdd} onRemove={onRemove} quickReactions={quickReactions} onDone={() => setOpen(false)} />
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Sheet (touch) ──

export interface ReactionSheetProps extends ReactionHandlers {
  reactions?: readonly ReactionGroup[];
  onClose: () => void;
  title?: string;
  quickReactions?: readonly string[];
  /**
   * Attributes set on both the backdrop and the panel, for an app that has to
   * recognise its own overlays (e.g. to keep a text-selection layer from
   * treating a tap on the sheet as a tap on the page).
   */
  overlayAttributes?: Record<`data-${string}`, string>;
}

/**
 * The reaction menu as a sheet along the bottom of the screen, for touch,
 * where there is no hover to reveal an add button. Mount it while open.
 * Sits above `--app-safe-area-bottom` when the app sets it.
 */
export function ReactionSheet({ reactions, onAdd, onRemove, onClose, title = 'React to message', quickReactions, overlayAttributes }: ReactionSheetProps): React.JSX.Element | null {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" {...overlayAttributes} />
      <div
        {...overlayAttributes}
        data-testid="reaction-sheet"
        className="fixed z-50 flex flex-col items-center overflow-hidden rounded-lg border border-reaction-border bg-reaction-surface text-reaction-text"
        style={{ left: 12, right: 12, bottom: 'calc(12px + var(--app-safe-area-bottom, env(safe-area-inset-bottom, 0px)))', touchAction: 'manipulation' }}
      >
        <div className="flex w-full items-center gap-2 border-b border-reaction-border px-3 py-2">
          <SmilePlus size={12} className="flex-shrink-0 text-reaction-text-faint" />
          <span className="text-xs font-medium text-reaction-text-secondary">{title}</span>
        </div>
        <div className="py-1">
          <ReactionMenu reactions={reactions} onAdd={onAdd} onRemove={onRemove} quickReactions={quickReactions} onDone={onClose} large />
        </div>
      </div>
    </>,
    document.body,
  );
}

// ── Chips ──

export interface ReactionChipsProps extends Partial<ReactionHandlers> {
  reactions: readonly ReactionGroup[];
  /**
   * Every reaction is the viewer's own (a single-user app): chips show just
   * the emoji, with no count and no mark for the viewer's own.
   */
  singleUser?: boolean;
  /** A ring in the page colour around each chip, for chips laid over the edge of a bubble. */
  ringed?: boolean;
  className?: string;
  testId?: string;
}

/** One reaction: the emoji on a small round backing. */
const CHIP = 'flex h-6 items-center gap-1 rounded-full bg-reaction-surface-hover px-1.5 text-[14px] leading-none';

/**
 * The reactions on a message. With `onAdd` and `onRemove`, clicking a chip
 * adds or takes off the viewer's own reaction; without them the chips are
 * only shown. Hovering one names who reacted.
 */
export function ReactionChips({ reactions, onAdd, onRemove, singleUser = false, ringed = false, className, testId = 'message-reactions' }: ReactionChipsProps): React.JSX.Element | null {
  if (reactions.length === 0) return null;
  const interactive = Boolean(onAdd && onRemove);
  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn('flex flex-wrap items-center gap-1', className)} data-testid={testId}>
        {reactions.map((group) => {
          const described = describeReactors(group);
          const own = !singleUser && group.reactedByMe;
          const body = (
            <>
              {group.emoji}
              {!singleUser && <span className={cn('text-[12px] font-medium tabular-nums', own ? 'text-reaction-accent' : 'text-reaction-text-secondary')}>{group.count}</span>}
            </>
          );
          const chipClass = cn(CHIP, ringed && 'ring-2 ring-reaction-page', own && 'bg-reaction-accent-soft');
          return (
            <Tooltip key={group.emoji}>
              <TooltipTrigger asChild>
                {interactive ? (
                  <button
                    type="button"
                    onClick={() => (group.reactedByMe ? onRemove!(group.emoji) : onAdd!(group.emoji))}
                    aria-pressed={group.reactedByMe}
                    aria-label={`${described}. ${group.reactedByMe ? 'Click to remove yours.' : 'Click to add yours.'}`}
                    className={cn(chipClass, 'hover:bg-reaction-border-strong')}
                  >
                    {body}
                  </button>
                ) : (
                  <span aria-label={described} className={chipClass}>{body}</span>
                )}
              </TooltipTrigger>
              <TooltipContent>{described}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
