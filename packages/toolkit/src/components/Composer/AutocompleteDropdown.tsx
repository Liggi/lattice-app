import React, { useEffect, useRef } from 'react';
import type { FileSystemEntry, Command, EmojiSuggestion } from './types.js';
import { cn } from '../../utils/cn.js';

export interface AutocompleteDropdownProps {
  suggestions: FileSystemEntry[] | Command[] | EmojiSuggestion[];
  onSelect: (value: string) => void;
  onClose: () => void;
  isOpen: boolean;
  focusedIndex: number;
  type: 'file' | 'command' | 'emoji';
  onFocusReturn?: () => void;
}

export function AutocompleteDropdown({
  suggestions,
  onSelect,
  onClose,
  isOpen,
  focusedIndex,
  type,
  onFocusReturn,
}: AutocompleteDropdownProps): React.ReactElement | null {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll focused item into view
  useEffect(() => {
    if (!isOpen || focusedIndex < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-autocomplete-item]');
    items[focusedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex, isOpen]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose();
        onFocusReturn?.();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, onClose, onFocusReturn]);

  if (!isOpen || suggestions.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-[240px] overflow-y-auto rounded-md border bg-composer-surface border-composer-border"
    >
      {suggestions.map((entry, i) => {
        if (type === 'emoji') {
          const { emoji, shortcode } = entry as EmojiSuggestion;
          return (
            <button
              key={shortcode}
              data-autocomplete-item
              type="button"
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors',
                i === focusedIndex
                  ? 'bg-composer-active/10 text-composer-text'
                  : 'text-composer-text-secondary hover:bg-composer-active/5',
              )}
              onMouseDown={(e) => {
                e.preventDefault(); // Keep textarea focus
                onSelect(emoji);
              }}
            >
              <span className="w-5 text-center text-lg leading-none">{emoji}</span>
              <span>:{shortcode}:</span>
            </button>
          );
        }
        const isCommand = type === 'command';
        const label = isCommand ? (entry as Command).name : (entry as FileSystemEntry).name;
        const description = isCommand ? (entry as Command).description : undefined;

        return (
          <button
            key={label}
            data-autocomplete-item
            type="button"
            className={cn(
              'flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm transition-colors',
              i === focusedIndex
                ? 'bg-composer-active/10 text-composer-text'
                : 'text-composer-text-secondary hover:bg-composer-active/5',
            )}
            onMouseDown={(e) => {
              e.preventDefault(); // Keep textarea focus
              onSelect(label);
            }}
          >
            <span>{label}</span>
            {description && (
              <span className="text-xs text-composer-text-faint">{description}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
