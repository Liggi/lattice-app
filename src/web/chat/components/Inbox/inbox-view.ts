/**
 * What the Inbox page shows, kept pure so the filtering and the tone of each
 * row can be tested without a browser: which rows a tab lists, the glyph each
 * row carries, and how titles step down in contrast as rows get older.
 */

import type { InboxGlyphKind, InboxItem, InboxRequestKind } from '@/types/inbox-feed';
import { parseAsk } from '@/types/ask-text';
import type { StateGlyphKind } from '../shared/StateGlyph';

export type InboxTab = 'priority' | 'all';

/** The rows a tab lists, oldest-asked last, as the feed orders them. */
export function inboxRows(items: InboxItem[], tab: InboxTab): InboxItem[] {
  return tab === 'priority' ? items.filter((item) => item.priority) : items;
}

/**
 * The shared state marks: a decision is the half-filled ring of a step in
 * hand, a stall and an outside wait both the pause ring, a failure the cross.
 */
export function inboxGlyph(kind: InboxGlyphKind): StateGlyphKind {
  switch (kind) {
    case 'decision': return 'progress';
    case 'failed': return 'failed';
    case 'stalled':
    case 'waiting': return 'waiting';
  }
}

/** Title and reason classes for an active row: every unanswered row stays legible; selection lifts the active row. */
export function rowTone(rank: number, selected = false): { title: string; reason: string } {
  if (selected || rank === 0) {
    return { title: 'text-fg font-medium', reason: 'text-fg-2' };
  }
  return { title: 'text-fg/90', reason: 'text-fg-3' };
}

/** The empty line a tab shows when it lists nothing. */
export function emptyText(tab: InboxTab): string {
  return tab === 'priority' ? 'Nothing waiting in Priority' : 'All clear';
}

/** A failing pull request's repo and number, from the feed or else its GitHub link. */
export function prRef(item: InboxItem): { repo: string; number: number; failedChecks: string[] } | null {
  if (item.pr) return item.pr;
  const match = item.href ? /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(item.href) : null;
  return match ? { repo: match[1], number: Number(match[2]), failedChecks: [] } : null;
}

/** The request kind for an ask item (`decision` or `call`), defaulting cleanly for older payloads. */
export function requestKindOf(item: InboxItem): InboxRequestKind | null {
  if (item.requestKind) return item.requestKind;
  if (item.kind === 'decision') return 'decision';
  if (item.kind === 'call') return 'info';
  return null;
}

/** Human-readable label for a request kind. */
export function requestKindLabel(kind: InboxRequestKind): string {
  switch (kind) {
    case 'go-ahead': return 'Go-ahead';
    case 'decision': return 'Decision';
    case 'review': return 'Review';
    case 'access': return 'Access';
    case 'info': return 'Info';
  }
}

/** What kind of thing the item is, in a word or a reference: "Go-ahead", "Decision", "web-app #3575". */
export function kindLabel(item: InboxItem): string {
  switch (item.kind) {
    case 'failing-pr': {
      const ref = prRef(item);
      return ref ? `${ref.repo} #${ref.number}` : 'Pull request';
    }
    case 'decision': return requestKindLabel(item.requestKind ?? 'decision');
    case 'call': return item.requestKind ? requestKindLabel(item.requestKind) : 'Question';
    case 'failed-run': return 'Failed run';
    case 'stalled-job': return 'Stalled job';
  }
}

/** The single parsed recommendation on a one-question thread ask, when present. */
export function singleAskRecommendation(item: InboxItem): { question: string; recommendation: string; context: string } | null {
  if (item.action?.kind !== 'thread' || !item.action.askText) return null;
  const parsed = parseAsk(item.action.askText);
  if (!parsed || parsed.questions.length !== 1) return null;
  const only = parsed.questions[0];
  if (!only.recommendation) return null;
  return { question: only.text, recommendation: only.recommendation, context: parsed.context };
}

/** The ask an item puts to the user, when it has one. */
export function itemQuestion(item: InboxItem): string | null {
  return item.action?.kind === 'decision' || item.action?.kind === 'thread' ? item.action.question : null;
}

/** The item's real subject: the decision's question, else the PR, thread, session or job it is about. */
export function itemSubject(item: InboxItem): string {
  if (item.action?.kind === 'decision') return item.action.question;
  if (item.action?.kind === 'thread' && item.action.question) return item.action.question;
  return item.title;
}

/** The line under a row's subject: the recommendation, failing checks, or fallback consequence. */
export function rowWhy(item: InboxItem): string {
  switch (item.kind) {
    case 'failing-pr': {
      const checks = prRef(item)?.failedChecks ?? [];
      return checks.length ? `${item.reason}: ${checks.join(', ')}` : item.reason;
    }
    case 'decision': {
      const options = item.action?.kind === 'decision' ? item.action.options : [];
      const recommended = options.find((option) => option.recommended);
      if (recommended) return `Recommended: ${recommended.label}`;
      if (item.ifUnanswered) return `If unanswered: ${item.ifUnanswered}`;
      return options.length ? `${options.length} options` : item.reason;
    }
    case 'call': {
      const single = singleAskRecommendation(item);
      if (single) return `Recommended: ${single.recommendation}`;
      if (item.ifUnanswered) return `If unanswered: ${item.ifUnanswered}`;
      if (item.context?.[0]) return item.context[0];
      const question = itemQuestion(item);
      return question && question !== item.title ? question : item.reason;
    }
    case 'stalled-job': {
      const count = jobCount(item);
      return count ? `${item.reason} at ${count.done.toLocaleString()} of ${count.total.toLocaleString()}` : item.reason;
    }
    default:
      return item.reason;
  }
}

/** The colour of an item's status line: rose for a failure, amber for a stall, else none. */
export function statusTone(item: InboxItem): 'failed' | 'stalled' | null {
  if (item.glyph === 'failed') return 'failed';
  if (item.glyph === 'stalled') return 'stalled';
  return null;
}

/** A stalled job's "done of total", when its detail is a count rather than a read error. */
export function jobCount(item: InboxItem): { done: number; total: number } | null {
  const match = item.kind === 'stalled-job' && item.detail ? /^([\d,]+) of ([\d,]+)$/.exec(item.detail) : null;
  if (!match) return null;
  const total = Number(match[2].replace(/,/g, ''));
  return total > 0 ? { done: Number(match[1].replace(/,/g, '')), total } : null;
}
