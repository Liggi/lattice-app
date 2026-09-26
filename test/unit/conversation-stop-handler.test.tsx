// @vitest-environment happy-dom

/**
 * Stop escalates to a force-kill only when the turn it stopped did not end.
 * On 2026-09-23 a stop that had worked was followed within milliseconds by an
 * auto-compaction or a queued message; the handler read the session as still
 * "ongoing" and force-killed that work, cancelling compactions nobody stopped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConversationStopHandler } from '../../src/web/chat/components/ConversationView/use-conversation-stop-handler';

const stopTurn = vi.fn();
const unifiedForceKillConversation = vi.fn();
const getConversationStatus = vi.fn();
vi.mock('../../src/web/chat/services/api', () => ({
  api: {
    stopTurn: (id: string) => stopTurn(id),
    unifiedForceKillConversation: (id: string) => unifiedForceKillConversation(id),
    getConversationStatus: (id: string) => getConversationStatus(id),
  },
}));

const session = { stop: vi.fn(), forceKill: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  // What the session reports after the stopped turn ends: the next turn is already running.
  getConversationStatus.mockResolvedValue({ status: 'ongoing' });
});

async function pressStop(): Promise<void> {
  const { result } = renderHook(() => useConversationStopHandler({ session, conversationId: 'conv-w', setStopRequested: () => {} }));
  await act(() => result.current.handleStop());
}

describe('stop escalation', () => {
  it('leaves the next turn alone once the stopped turn has ended', async () => {
    stopTurn.mockResolvedValue({ ok: true, ended: true });
    await pressStop();
    expect(stopTurn).toHaveBeenCalledWith('conv-w');
    expect(unifiedForceKillConversation).not.toHaveBeenCalled();
  });

  it('force-kills when the stopped turn did not end', async () => {
    stopTurn.mockResolvedValue({ ok: true, ended: false });
    await pressStop();
    expect(unifiedForceKillConversation).toHaveBeenCalledWith('conv-w');
  });
});
