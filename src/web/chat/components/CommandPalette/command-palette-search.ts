/**
 * What the command palette lists and in what order. Pure, so the ranking can
 * be tested without a browser: the component turns live app state into
 * `PaletteItem`s and draws whatever `searchPalette` returns.
 */

import type { UnifiedConversationSummary } from '../../types';

export type PaletteGroup = 'Recent' | 'Projects' | 'Sessions' | 'Pull requests' | 'Go to' | 'Actions' | 'Archived';

export type PaletteKind = 'project' | 'session' | 'archived' | 'pr' | 'page' | 'action';

export type PaletteTarget =
  | { type: 'navigate'; to: string }
  | { type: 'external'; href: string }
  | { type: 'settings' };

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  kind: PaletteKind;
  title: string;
  /** Shown under the title only on the highlighted row. */
  subtitle?: string;
  /** Matched like the subtitle but never shown. */
  keywords?: string;
  /** Epoch ms of last use, for ordering ties and the Recent group. */
  lastUsed?: number;
  /** Shown on a row whose shortcut really works. */
  keys?: string[];
  target: PaletteTarget;
}

/** Groups in the order they are drawn once the reader has typed something. */
const SEARCH_GROUP_ORDER: PaletteGroup[] = ['Projects', 'Sessions', 'Pull requests', 'Go to', 'Actions', 'Archived'];
const SEARCH_GROUP_LIMIT: Partial<Record<PaletteGroup, number>> = { Archived: 20 };
const DEFAULT_GROUP_LIMIT = 8;
const RECENT_LIMIT = 5;

/** The last folder of a working directory: `~/src/payments-service` → `payments-service`. */
export function folderName(path: string | undefined | null): string | undefined {
  if (!path) return undefined;
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.at(-1);
}

/** The title a conversation's sidebar row would show, without the ambient read. */
export function conversationTitle(conversation: UnifiedConversationSummary): string {
  return conversation.customName?.trim()
    || conversation.projectName?.trim()
    || conversation.insights?.context?.mission?.trim()
    || conversation.insights?.purpose?.trim()
    || conversation.initialPromptPreview?.trim()
    || conversation.conversationId.slice(0, 8);
}

function lastUsed(conversation: UnifiedConversationSummary): number {
  const value = new Date(conversation.lastActivityAt ?? conversation.updatedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function conversationItem(conversation: UnifiedConversationSummary, archived = false): PaletteItem {
  const kind: PaletteKind = archived ? 'archived' : conversation.coordinator ? 'project' : 'session';
  return {
    id: `conv:${conversation.conversationId}`,
    group: archived ? 'Archived' : conversation.coordinator ? 'Projects' : 'Sessions',
    kind,
    title: conversationTitle(conversation),
    subtitle: archived ? 'Archived' : folderName(conversation.workingDirectory),
    keywords: [conversation.workingDirectory, conversation.conversationId].filter(Boolean).join(' '),
    lastUsed: lastUsed(conversation),
    target: { type: 'navigate', to: `/c/${conversation.conversationId}` },
  };
}

/**
 * How well `query` matches an item; 0 means it does not. Every word of the
 * query has to be found. A title that starts with the query beats a word in
 * the title that does, which beats the query inside a word, which beats a
 * match in the folder or id, which beats the letters in order with gaps.
 */
export function scoreItem(item: PaletteItem, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const title = item.title.toLowerCase();
  const extra = `${item.subtitle ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  if (title === q) return 1000;
  if (title.startsWith(q)) return 900;

  let total = 0;
  for (const word of q.split(/\s+/).filter(Boolean)) {
    const at = title.indexOf(word);
    if (at === 0) total += 120;
    else if (at > 0 && /[^a-z0-9]/.test(title[at - 1] ?? '')) total += 100;
    else if (at > 0) total += 60;
    else if (extra.includes(word)) total += 30;
    else if (isSubsequence(word, title)) total += 10;
    else return 0;
  }
  return total;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * The rows to draw, already grouped and in order. With nothing typed: the
 * five most recently used projects and sessions, then pull requests, pages
 * and actions; archived work only appears once the reader searches for it.
 */
export function searchPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim();
  if (!q) {
    const recent = items
      .filter((item) => item.kind === 'project' || item.kind === 'session')
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
      .slice(0, RECENT_LIMIT)
      .map((item) => ({ ...item, group: 'Recent' as const }));
    const rest = (['Pull requests', 'Go to', 'Actions'] as const)
      .flatMap((group) => items.filter((item) => item.group === group).slice(0, DEFAULT_GROUP_LIMIT));
    return [...recent, ...rest];
  }

  const scored = items
    .map((item) => ({ item, score: scoreItem(item, q) }))
    .filter((entry) => entry.score > 0);
  return SEARCH_GROUP_ORDER.flatMap((group) => scored
    .filter((entry) => entry.item.group === group)
    .sort((a, b) => b.score - a.score || (b.item.lastUsed ?? 0) - (a.item.lastUsed ?? 0))
    .slice(0, SEARCH_GROUP_LIMIT[group] ?? DEFAULT_GROUP_LIMIT)
    .map((entry) => entry.item));
}
