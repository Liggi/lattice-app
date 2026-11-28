/**
 * The Start screen's two pure choices, kept apart so they can be tested
 * without a browser: what the Project/Session toggle does to the URL, and
 * which paused conversations are listed under the composer.
 */

import type { UnifiedConversationSummary } from '../../types';
import { lastUsedAt } from '../../utils/session-activity';

const PAUSED_LIMIT = 5;
/** An idle one counts as paused only once it has been left this long. */
export const PAUSED_IDLE_MS = 60 * 60 * 1000;

/**
 * The search params after picking Project or Session: `coordinator=1` for a
 * project, none for a session. The provider is dropped so the new kind starts
 * on its own default; the permission mode is kept.
 */
export function startKindSearch(current: URLSearchParams, kind: 'project' | 'session'): URLSearchParams {
  const next = new URLSearchParams(current);
  if (kind === 'project') next.set('coordinator', '1');
  else next.delete('coordinator');
  next.delete('provider');
  return next;
}

/** Sleeping ones first, then ones idle for over an hour, each newest used first; at most five. */
export function pausedConversations(
  sleeping: UnifiedConversationSummary[],
  awake: UnifiedConversationSummary[],
  isIdle: (conversation: UnifiedConversationSummary) => boolean,
  now: number = Date.now(),
): UnifiedConversationSummary[] {
  const newestFirst = (a: UnifiedConversationSummary, b: UnifiedConversationSummary) => lastUsedAt(b) - lastUsedAt(a);
  return [...[...sleeping].sort(newestFirst), ...awake.filter((c) => isIdle(c) && now - lastUsedAt(c) > PAUSED_IDLE_MS).sort(newestFirst)].slice(0, PAUSED_LIMIT);
}
