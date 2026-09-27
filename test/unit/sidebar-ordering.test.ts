/**
 * The sidebar keeps a fixed order: projects, pinned sessions and sessions are
 * each listed newest-created first, and activity never moves a row, except
 * that a sleeping project or session drops into its list's Sleeping group.
 * Ctrl+Tab walks the same order.
 */

import { describe, it, expect } from 'vitest';
import { sidebarLists, sidebarOrderedIds } from '@/web/chat/utils/sidebar-ordering';
import type { UnifiedConversationSummary } from '@/web/chat/types';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function session(
  conversationId: string,
  createdHoursAgo: number,
  overrides: Partial<UnifiedConversationSummary> = {},
): UnifiedConversationSummary {
  return {
    conversationId,
    createdAt: ago(createdHoursAgo * HOUR),
    updatedAt: ago(createdHoursAgo * HOUR),
    workingDirectory: '/tmp',
    latestProvider: 'claude',
    segmentCount: 1,
    status: 'idle',
    streamingId: null,
    customName: conversationId,
    pinned: false,
    archived: false,
    pausedReason: null,
    importedAt: null,
    permissionMode: null,
    identityImage: null,
    initialPrompt: null,
    // Active a minute ago, so awake unless a test says otherwise.
    lastActivityAt: ago(MINUTE),
    ...overrides,
  } as UnifiedConversationSummary;
}

describe('sidebarLists', () => {
  it('orders by creation, newest first, whatever the status or last activity', () => {
    const { sessions } = sidebarLists([
      session('conv-oldest', 72, { status: 'ongoing', lastActivityAt: ago(0) }),
      session('conv-newest', 1, { lastActivityAt: ago(20 * MINUTE) }),
      session('conv-middle', 24, { pendingWork: 'subagent', lastActivityAt: ago(5 * 60 * 1000) }),
    ]);

    expect(sessions.map(s => s.conversationId)).toEqual(['conv-newest', 'conv-middle', 'conv-oldest']);
  });

  it('keeps a session in place when it becomes active', () => {
    const before = [session('conv-a', 1), session('conv-b', 2), session('conv-c', 3)];
    const after = before.map(s => (s.conversationId === 'conv-c'
      ? { ...s, status: 'ongoing' as const, lastActivityAt: ago(0) }
      : s));

    const ids = (list: UnifiedConversationSummary[]) => sidebarLists(list).sessions.map(s => s.conversationId);
    expect(ids(after)).toEqual(ids(before));
  });

  it('orders projects by creation too, and separates them, pinned and archived out', () => {
    const lists = sidebarLists([
      session('conv-old-project', 48, { coordinator: true, lastActivityAt: ago(0) }),
      session('conv-new-project', 2, { coordinator: true }),
      session('conv-pinned', 30, { pinned: true }),
      session('conv-archived', 0.5, { archived: true }),
      session('conv-plain', 10),
    ]);

    expect(lists.projects.map(s => s.conversationId)).toEqual(['conv-new-project', 'conv-old-project']);
    expect(lists.pinned.map(s => s.conversationId)).toEqual(['conv-pinned']);
    expect(lists.sessions.map(s => s.conversationId)).toEqual(['conv-plain']);
  });

  it('leaves a worker out when its coordinator is listed, and keeps it when not', () => {
    const { sessions } = sidebarLists([
      session('conv-coord', 5, { coordinator: true }),
      session('conv-worker', 4, { pickedUpFrom: 'conv-coord' }),
      session('conv-orphan', 3, { pickedUpFrom: 'conv-gone' }),
    ]);

    expect(sessions.map(s => s.conversationId)).toEqual(['conv-orphan']);
  });
});

describe('sleeping', () => {
  const asleep = { lastActivityAt: ago(31 * MINUTE) };
  const ids = (list: UnifiedConversationSummary[]) => list.map(s => s.conversationId);

  it('moves sleeping sessions and projects into their Sleeping groups, still newest-created first', () => {
    const lists = sidebarLists([
      session('conv-awake', 5),
      session('conv-asleep-old', 40, asleep),
      session('conv-asleep-new', 3, asleep),
      session('conv-project-awake', 8, { coordinator: true }),
      session('conv-project-asleep', 6, { coordinator: true, ...asleep }),
    ]);

    expect(ids(lists.sessions)).toEqual(['conv-awake']);
    expect(ids(lists.sleepingSessions)).toEqual(['conv-asleep-new', 'conv-asleep-old']);
    expect(ids(lists.projects)).toEqual(['conv-project-awake']);
    expect(ids(lists.sleepingProjects)).toEqual(['conv-project-asleep']);
  });

  it('never moves a pinned session', () => {
    const lists = sidebarLists([session('conv-pinned', 50, { pinned: true, ...asleep })]);
    expect(ids(lists.pinned)).toEqual(['conv-pinned']);
    expect(lists.sleepingSessions).toEqual([]);
  });

  // Sleeping is the card's state, so anything the card shows ahead of it keeps the row awake.
  it('keeps a quiet row awake while it needs the user, holds pending work, or has busy workers', () => {
    const lists = sidebarLists([
      session('conv-needs-you', 1, asleep),
      session('conv-pending', 2, { pendingWork: 'scheduled_wakeup', ...asleep }),
      session('conv-project', 3, { coordinator: true, ...asleep }),
      session('conv-worker', 4, { pickedUpFrom: 'conv-project', status: 'ongoing', lastActivityAt: ago(0) }),
    ], { 'conv-needs-you': 1 });

    expect(ids(lists.sessions)).toEqual(['conv-needs-you', 'conv-pending']);
    expect(ids(lists.projects)).toEqual(['conv-project']);
  });

  it('moves a row back to its place when it wakes', () => {
    const quiet = [session('conv-a', 1), session('conv-b', 2, asleep), session('conv-c', 3)];
    expect(ids(sidebarLists(quiet).sessions)).toEqual(['conv-a', 'conv-c']);

    const woken = quiet.map(s => (s.conversationId === 'conv-b' ? { ...s, lastActivityAt: ago(0) } : s));
    expect(ids(sidebarLists(woken).sessions)).toEqual(['conv-a', 'conv-b', 'conv-c']);
  });
});

describe('sidebarOrderedIds', () => {
  // Ctrl+Tab walks this list, so it has to match the sidebar's render order.
  it('lists projects, sleeping projects, pinned, sessions, then sleeping sessions', () => {
    expect(sidebarOrderedIds(sidebarLists([
      session('conv-sleeping-session', 0.5, { lastActivityAt: ago(HOUR) }),
      session('conv-session', 1),
      session('conv-pinned', 2, { pinned: true }),
      session('conv-sleeping-project', 2.5, { coordinator: true, lastActivityAt: ago(HOUR) }),
      session('conv-project', 3, { coordinator: true }),
    ]))).toEqual(['conv-project', 'conv-sleeping-project', 'conv-pinned', 'conv-session', 'conv-sleeping-session']);
  });
});
