import React, { useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { EMOJI_GROUPS, displayShortcode, findEmoji, type Emoji } from './emoji.js';
import { useEmojiTable } from './hooks.js';

export interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  /** Focus the search box on open. Turn off on touch, where it would raise the keyboard over the grid. */
  autoFocus?: boolean;
}

/**
 * Every emoji, searchable by Slack shortcode or keyword, in category
 * sections with a jump row. Enter picks the first result of a search. The
 * line under the grid names the emoji under the pointer, as Slack's does.
 */
export function EmojiPicker({ onPick, autoFocus = true }: EmojiPickerProps): React.JSX.Element {
  const { table: all, error: loadError } = useEmojiTable();
  const [query, setQuery] = useState('');
  const [hovered, setHovered] = useState<Emoji | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => (all && query.trim() ? findEmoji(all, query) : null), [all, query]);
  const sections = useMemo(
    () => (all ? EMOJI_GROUPS.map((group) => ({ ...group, items: all.filter((entry) => entry.group === group.id) })) : []),
    [all],
  );

  const jumpTo = (groupId: number) => {
    setQuery('');
    requestAnimationFrame(() => {
      gridRef.current?.querySelector(`[data-group="${groupId}"]`)?.scrollIntoView({ block: 'start' });
    });
  };

  const cell = (entry: Emoji) => (
    <button
      key={entry.emoji}
      type="button"
      onClick={() => onPick(entry.emoji)}
      onMouseEnter={() => setHovered(entry)}
      onFocus={() => setHovered(entry)}
      aria-label={displayShortcode(entry)}
      className="flex h-8 w-8 items-center justify-center rounded-sm text-[20px] leading-none hover:bg-reaction-surface-hover focus:bg-reaction-surface-hover focus:outline-none"
    >
      {entry.emoji}
    </button>
  );

  return (
    <div className="flex w-[304px] max-w-[calc(100vw-24px)] flex-col" data-testid="emoji-picker">
      <div className="p-2">
        <label className="flex items-center gap-2 rounded-sm border border-reaction-border-strong bg-reaction-page px-2.5 py-1.5 focus-within:border-reaction-accent">
          <Search size={14} className="flex-shrink-0 text-reaction-text-faint" />
          <input
            autoFocus={autoFocus}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results && results.length > 0) {
                event.preventDefault();
                onPick(results[0].emoji);
              }
            }}
            placeholder="Search emoji"
            aria-label="Search emoji"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-reaction-text placeholder:text-reaction-text-faint focus:outline-none"
          />
        </label>
      </div>
      <div className="flex justify-between border-b border-reaction-border px-2 pb-1.5">
        {EMOJI_GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            onClick={() => jumpTo(group.id)}
            title={group.label}
            aria-label={group.label}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-[15px] leading-none opacity-70 hover:bg-reaction-surface-hover hover:opacity-100"
          >
            {group.icon}
          </button>
        ))}
      </div>
      <div ref={gridRef} className="h-[248px] overflow-y-auto overscroll-contain px-1.5 py-1">
        {!all && !loadError && <div className="px-1 py-2 text-[12px] text-reaction-text-faint">Loading…</div>}
        {loadError && <div className="px-1 py-2 text-[12px] text-rose-300">Emoji failed to load: {loadError}. Close and reopen to try again.</div>}
        {results && (
          results.length > 0
            ? <div className="grid grid-cols-8 gap-0.5">{results.map(cell)}</div>
            : <div className="px-1 py-2 text-[12px] text-reaction-text-faint">No emoji match “{query.trim()}”</div>
        )}
        {!results && sections.map((section) => (
          <section key={section.id} data-group={section.id}>
            <div className="sticky top-0 z-[1] bg-reaction-surface px-1 pb-1 pt-1.5 text-[11px] font-medium text-reaction-text-faint">{section.label}</div>
            <div className="grid grid-cols-8 gap-0.5">{section.items.map(cell)}</div>
          </section>
        ))}
      </div>
      <div className="flex h-9 items-center gap-2 border-t border-reaction-border px-3 text-[12px] text-reaction-text-secondary">
        {hovered ? (
          <>
            <span className="text-[18px] leading-none">{hovered.emoji}</span>
            <span className="break-all">:{displayShortcode(hovered, query)}:</span>
          </>
        ) : (
          <span className="text-reaction-text-faint">Pick an emoji</span>
        )}
      </div>
    </div>
  );
}
