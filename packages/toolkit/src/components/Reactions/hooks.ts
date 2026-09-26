import { useCallback, useEffect, useState } from 'react';
import type { EmojiSuggestion } from '../Composer/types.js';
import { loadEmoji, shortcodeSuggestions, type Emoji } from './emoji.js';

/** The emoji table once it has loaded, or the error that stopped it. */
export function useEmojiTable(): { table: Emoji[] | null; error: string | null } {
  const [table, setTable] = useState<Emoji[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadEmoji().then(
      (loaded) => { if (live) setTable(loaded); },
      (reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { live = false; };
  }, []);
  return { table, error };
}

/**
 * The Composer's `searchEmoji`, backed by the toolkit's table. Until the
 * table arrives, `:` opens nothing; a table that fails to load is logged and
 * leaves autocomplete off.
 */
export function useEmojiShortcodeSearch(limit = 20): (query: string) => EmojiSuggestion[] {
  const { table, error } = useEmojiTable();
  useEffect(() => {
    if (error) console.error(`[composer] emoji table failed to load; :shortcode autocomplete is off: ${error}`);
  }, [error]);
  return useCallback(
    (query: string) => (table ? shortcodeSuggestions(table, query, limit) : []),
    [table, limit],
  );
}

/** True on touch screens, where a focused search box would raise the keyboard over the grid. */
export function useCoarsePointer(): boolean {
  const query = '(pointer: coarse)';
  const [coarse, setCoarse] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setCoarse(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return coarse;
}
