// @vitest-environment happy-dom

/**
 * A message typed while a session is compacting reaches the server. Until
 * 2026-09-23 the view held it in its own state until the compaction ended, so
 * switching session or reloading first lost it without a trace; the server
 * now keeps it and the provider reads it after the compaction.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useConversationSendMessage } from '../../src/web/chat/components/ConversationView/use-conversation-send-message';

function render() {
  const send = vi.fn(async () => {});
  const hook = renderHook(() => useConversationSendMessage({
    conversationId: 'conv-compacting',
    connected: true,
    send,
    compact: vi.fn(async () => {}),
    reconnect: vi.fn(),
    setLocalError: vi.fn(),
  }));
  return { send, hook };
}

describe('a message sent while the session compacts', () => {
  it('is handed to the server before the send returns, so leaving the session cannot lose it', async () => {
    const { send, hook } = render();

    let accepted = false;
    await act(async () => {
      accepted = await hook.result.current('typed during compaction', 'claude-opus-5-5');
    });
    hook.unmount();

    expect(accepted).toBe(true);
    expect(send).toHaveBeenCalledWith('typed during compaction', { model: 'claude-opus-5-5' });
  });

  it('still starts a compaction when the message is /compact', async () => {
    const compact = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    const { result } = renderHook(() => useConversationSendMessage({
      conversationId: 'conv-compacting', connected: true, send, compact, reconnect: vi.fn(), setLocalError: vi.fn(),
    }));

    await act(async () => { await result.current('/compact'); });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
