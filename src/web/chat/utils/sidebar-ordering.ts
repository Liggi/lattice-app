import type { UnifiedConversationSummary } from '../types';
import { deriveSessionActivity, lastUsedAt } from './session-activity';

const newestCreatedFirst = (a: UnifiedConversationSummary, b: UnifiedConversationSummary): number =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

const lastUsedFirst = (a: UnifiedConversationSummary, b: UnifiedConversationSummary): number =>
  lastUsedAt(b) - lastUsedAt(a);

/**
 * The sidebar's lists, in the order they render: Projects, Sleeping projects,
 * Pinned, Sessions, Sleeping sessions. Each is ordered by creation time, newest
 * first, and nothing else, so a row never moves because its session did
 * something. The request, 2026-09-26: "projects / sessions shouldn't change
 * order in the lattice sidebar". Status is shown on the card, not by moving it
 * between bands.
 *
 * The one move is falling asleep: a project or session whose card shows
 * Sleeping (deriveSessionActivity, so it needs nothing from the user, is not
 * working and holds no pending work) drops into its list's Sleeping group, and
 * returns to its place when it wakes. A row put to sleep by hand (sleptAt)
 * drops there too, even while it works or waits, and stays until its next turn
 * starts; needing the user or failing still keeps it in view. Pinned sessions never move. A Sleeping
 * group is ordered by last use, most recent first (asked 2026-09-29); nothing
 * in it is active, so that order holds still too.
 *
 * A worker a coordinator dispatched is not a session the user started, so it is
 * not listed; it lives in the coordinator's right panel. It stays listed when
 * its coordinator is not in the list, so it is never unreachable.
 */
export function sidebarLists(
  conversations: UnifiedConversationSummary[],
  sessionAttention: Record<string, number> = {},
  now: number = Date.now(),
): {
  projects: UnifiedConversationSummary[];
  sleepingProjects: UnifiedConversationSummary[];
  pinned: UnifiedConversationSummary[];
  sessions: UnifiedConversationSummary[];
  sleepingSessions: UnifiedConversationSummary[];
} {
  const ids = new Set(conversations.map(c => c.conversationId));
  const live = conversations.filter(c => !c.archived).sort(newestCreatedFirst);
  const asleep = (c: UnifiedConversationSummary): boolean => {
    const { kind } = deriveSessionActivity(c, conversations, (sessionAttention[c.conversationId] ?? 0) > 0, now);
    return kind === 'sleeping' || (Boolean(c.sleptAt) && kind !== 'needs-you' && kind !== 'failed');
  };
  const projects = live.filter(c => c.coordinator);
  const others = live.filter(c => !c.coordinator && !(c.pickedUpFrom && ids.has(c.pickedUpFrom)));
  const unpinned = others.filter(c => !c.pinned);
  return {
    projects: projects.filter(c => !asleep(c)),
    sleepingProjects: projects.filter(asleep).sort(lastUsedFirst),
    pinned: others.filter(c => c.pinned),
    sessions: unpinned.filter(c => !asleep(c)),
    sleepingSessions: unpinned.filter(asleep).sort(lastUsedFirst),
  };
}

/** Every listed conversation in sidebar order, top to bottom. Ctrl+Tab walks this. */
export function sidebarOrderedIds(lists: ReturnType<typeof sidebarLists>): string[] {
  const { projects, sleepingProjects, pinned, sessions, sleepingSessions } = lists;
  return [...projects, ...sleepingProjects, ...pinned, ...sessions, ...sleepingSessions].map(c => c.conversationId);
}
