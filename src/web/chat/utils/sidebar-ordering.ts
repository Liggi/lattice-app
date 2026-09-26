import type { UnifiedConversationSummary } from '../types';

/**
 * When a conversation was last used. `updatedAt` alone only moves on the legacy
 * /resume route and on segment changes, so it mostly stays at creation time.
 * The sidebar card's age label reads this; the sidebar's order does not.
 */
export function lastUsedAt(session: UnifiedConversationSummary): number {
  return new Date(session.lastActivityAt ?? session.updatedAt).getTime();
}

const newestCreatedFirst = (a: UnifiedConversationSummary, b: UnifiedConversationSummary): number =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

/**
 * The sidebar's lists, in the order they render: Projects, then Pinned, then
 * Sessions. Each is ordered by creation time, newest first, and nothing else,
 * so a row never moves because its session did something. The request, 2026-09-26:
 * "projects / sessions shouldn't change order in the lattice sidebar". Status
 * is shown on the card, not by moving it between bands.
 *
 * A worker a coordinator dispatched is not a session the user started, so it is
 * not listed; it lives in the coordinator's right panel. It stays listed when
 * its coordinator is not in the list, so it is never unreachable.
 */
export function sidebarLists(conversations: UnifiedConversationSummary[]): {
  projects: UnifiedConversationSummary[];
  pinned: UnifiedConversationSummary[];
  sessions: UnifiedConversationSummary[];
} {
  const ids = new Set(conversations.map(c => c.conversationId));
  const live = conversations.filter(c => !c.archived).sort(newestCreatedFirst);
  const projects = live.filter(c => c.coordinator);
  const others = live.filter(c => !c.coordinator && !(c.pickedUpFrom && ids.has(c.pickedUpFrom)));
  return {
    projects,
    pinned: others.filter(c => c.pinned),
    sessions: others.filter(c => !c.pinned),
  };
}

/** Every listed conversation in sidebar order, top to bottom. Ctrl+Tab walks this. */
export function getSidebarOrderedSessionIds(conversations: UnifiedConversationSummary[]): string[] {
  const { projects, pinned, sessions } = sidebarLists(conversations);
  return [...projects, ...pinned, ...sessions].map(c => c.conversationId);
}
