/**
 * The Start screen's Project/Session toggle flips `?coordinator=1` and lets
 * the new kind choose its own provider; the Paused list under the composer
 * puts sleeping work first, then idle work, newest used first, five at most.
 */

import { describe, expect, it } from 'vitest';
import { pausedConversations, startKindSearch } from '../../src/web/chat/components/NewSessionView/start-screen.js';
import type { UnifiedConversationSummary } from '../../src/web/chat/types/index.js';

describe('startKindSearch', () => {
  it('sets coordinator for a project and drops the provider, keeping the mode', () => {
    const next = startKindSearch(new URLSearchParams('provider=claude&mode=bypassPermissions'), 'project');
    expect(next.toString()).toBe('mode=bypassPermissions&coordinator=1');
  });

  it('clears coordinator for a session', () => {
    const next = startKindSearch(new URLSearchParams('coordinator=1&mode=bypassPermissions'), 'session');
    expect(next.toString()).toBe('mode=bypassPermissions');
  });
});

describe('pausedConversations', () => {
  const conv = (id: string, hoursAgo: number, idle = true) => ({
    conversation: { conversationId: id, updatedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() } as UnifiedConversationSummary,
    idle,
  });

  it('lists sleeping first, then idle awake ones, newest first, at most five', () => {
    const sleeping = [conv('s-old', 50), conv('s-new', 30)].map((c) => c.conversation);
    const awakeEntries = [conv('a-busy', 1.5, false), conv('a-1', 2), conv('a-2', 3), conv('a-3', 4), conv('a-4', 5)];
    const idle = new Set(awakeEntries.filter((c) => c.idle).map((c) => c.conversation.conversationId));
    const result = pausedConversations(sleeping, awakeEntries.map((c) => c.conversation), (c) => idle.has(c.conversationId));
    expect(result.map((c) => c.conversationId)).toEqual(['s-new', 's-old', 'a-1', 'a-2', 'a-3']);
  });

  it('leaves out idle work used within the hour', () => {
    const recent = conv('a-recent', 0.05).conversation;
    expect(pausedConversations([], [recent], () => true)).toEqual([]);
  });

  it('is empty when nothing is paused', () => {
    expect(pausedConversations([], [conv('a', 1, false).conversation], () => false)).toEqual([]);
  });
});
