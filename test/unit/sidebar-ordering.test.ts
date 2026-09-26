/**
 * The sidebar keeps a fixed order: projects, pinned sessions and sessions are
 * each listed newest-created first, and activity never moves a row. Ctrl+Tab
 * walks the same order.
 */

import { describe, it, expect } from 'vitest';
import { getSidebarOrderedSessionIds, sidebarLists } from '@/web/chat/utils/sidebar-ordering';
import type { UnifiedConversationSummary } from '@/web/chat/types';

const HOUR = 60 * 60 * 1000;
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
    ...overrides,
  } as UnifiedConversationSummary;
}

describe('sidebarLists', () => {
  it('orders by creation, newest first, whatever the status or last activity', () => {
    const { sessions } = sidebarLists([
      session('conv-oldest', 72, { status: 'ongoing', lastActivityAt: ago(0) }),
      session('conv-newest', 1, { lastActivityAt: ago(1 * HOUR) }),
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

describe('getSidebarOrderedSessionIds', () => {
  // Ctrl+Tab walks this list, so it has to match the sidebar's render order.
  it('lists projects, then pinned, then sessions', () => {
    expect(getSidebarOrderedSessionIds([
      session('conv-session', 1),
      session('conv-pinned', 2, { pinned: true }),
      session('conv-project', 3, { coordinator: true }),
    ])).toEqual(['conv-project', 'conv-pinned', 'conv-session']);
  });
});
