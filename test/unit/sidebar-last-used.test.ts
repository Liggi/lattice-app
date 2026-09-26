/**
 * A sidebar card's age reads when its conversation was last *used*.
 *
 * `updatedAt` cannot carry that on its own: only the legacy /resume route and
 * segment changes ever write it, so for most conversations it stays at creation
 * time. `lastActivityAt` comes from the newest harness event.
 */

import { describe, expect, it } from 'vitest';
import type { UnifiedConversationSummary } from '@/web/chat/types';
import { lastUsedAt } from '@/web/chat/utils/sidebar-ordering';

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function conversation(overrides: Partial<UnifiedConversationSummary> = {}): UnifiedConversationSummary {
  return {
    conversationId: 'conv-test',
    createdAt: ago(90 * 24 * HOUR),
    updatedAt: ago(90 * 24 * HOUR),
    workingDirectory: '/tmp',
    latestProvider: 'claude',
    segmentCount: 1,
    status: 'completed',
    streamingId: null,
    customName: '',
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

describe('lastUsedAt', () => {
  it('prefers real activity over the stored updatedAt', () => {
    const session = conversation({ updatedAt: ago(90 * 24 * HOUR), lastActivityAt: ago(2 * HOUR) });
    expect(Date.now() - lastUsedAt(session)).toBeLessThan(3 * HOUR);
  });

  // Payloads from an older server have no lastActivityAt.
  it('falls back to updatedAt when activity is unknown', () => {
    const updatedAt = ago(5 * HOUR);
    expect(lastUsedAt(conversation({ updatedAt }))).toBe(new Date(updatedAt).getTime());
  });
});
