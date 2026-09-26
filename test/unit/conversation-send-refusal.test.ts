// @vitest-environment happy-dom

/**
 * A send the server refuses hands the text back to the composer; one it
 * accepts, including a message saved to wait in the inbox, does not, so the
 * same message is not offered for a second send.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../../src/web/chat/services/api', () => ({ api: { unifiedUpdateConversation: vi.fn() } }));

const { restoreComposerDraft, useConversationSendHandlers } = await import(
  '../../src/web/chat/components/ConversationView/use-conversation-send-handlers.js'
);
const { useMessageAnnotations } = await import('../../src/web/chat/hooks/useMessageAnnotations.js');

const conversationId = 'conv-refusal';
const draftKey = `composer-draft-${conversationId}`;

function handlers(accepted: boolean) {
  const onAnnotationsSent = vi.fn();
  const restoreDraftFromBackup = vi.fn(() => restoreComposerDraft(conversationId));
  const { result } = renderHook(() => useConversationSendHandlers({
    conversationId,
    provider: 'claude',
    session: {
      messages: [],
      isActive: false,
      isConnected: true,
      clearNextSteps: () => {},
      addOptimisticUserMessage: () => {},
      sendMessage: async () => accepted,
      enqueueMessage: async () => {},
    },
    setSessionOptimisticOngoing: () => {},
    invalidateConversations: async () => {},
    restoreDraftFromBackup,
    setSessionFailureError: () => {},
    nextStepsDismissedRef: { current: false },
    getPendingAnnotations: () => [{ id: 'note-1', quote: 'q', note: 'n' } as never],
    onAnnotationsSent,
  }));
  return { send: result.current.handleSendMessage, onAnnotationsSent, restoreDraftFromBackup };
}

afterEach(() => localStorage.clear());

describe('composer text after a send', () => {
  it('comes back, readable as the composer stores it, when the send is refused', async () => {
    // What the composer does on submit: back up the raw text, clear the draft.
    localStorage.setItem(`${draftKey}-backup`, 'line one\n"quoted"');
    localStorage.setItem(draftKey, JSON.stringify(''));
    const { send, onAnnotationsSent } = handlers(false);

    await send('line one\n"quoted"');

    expect(JSON.parse(localStorage.getItem(draftKey)!)).toBe('line one\n"quoted"');
    expect(localStorage.getItem(`${draftKey}-backup`)).toBeNull();
    // The notes did not go anywhere either, so they stay for the next attempt.
    expect(onAnnotationsSent).not.toHaveBeenCalled();
  });

  it('stays cleared when the send is accepted, saved to wait or delivered', async () => {
    localStorage.setItem(`${draftKey}-backup`, 'sent once');
    localStorage.setItem(draftKey, JSON.stringify(''));
    const { send, onAnnotationsSent, restoreDraftFromBackup } = handlers(true);

    await send('sent once');

    expect(restoreDraftFromBackup).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(draftKey)!)).toBe('');
    expect(onAnnotationsSent).toHaveBeenCalledWith(['note-1']);
  });
});

/** The real notes hook wired to the send handler, with a send held open. */
function notesAndSend() {
  const releases: Array<(accepted: boolean) => void> = [];
  const sendMessage = vi.fn(() => new Promise<boolean>((resolve) => releases.push(resolve)));
  const { result } = renderHook(() => {
    const notes = useMessageAnnotations(conversationId);
    const { handleSendMessage } = useConversationSendHandlers({
      conversationId,
      provider: 'claude',
      session: {
        messages: [],
        isActive: true,
        isConnected: true,
        clearNextSteps: () => {},
        addOptimisticUserMessage: () => {},
        sendMessage,
        enqueueMessage: async () => {},
      },
      setSessionOptimisticOngoing: () => {},
      invalidateConversations: async () => {},
      restoreDraftFromBackup: () => {},
      setSessionFailureError: () => {},
      nextStepsDismissedRef: { current: false },
      getPendingAnnotations: notes.getPendingAnnotations,
      onAnnotationsSending: notes.beginSendingAnnotations,
      onAnnotationsReleased: notes.releaseAnnotations,
      onAnnotationsSent: notes.consumeAnnotations,
    });
    return { notes, send: handleSendMessage };
  });
  act(() => result.current.notes.addAnnotation({ messageId: 'msg-1', quote: 'the quote', note: 'the note' }));
  return { result, sendMessage, releases };
}

describe('notes submitted with no typed message', () => {
  it('go out once however many times submit is clicked while the send is open', async () => {
    const { result, sendMessage, releases } = notesAndSend();

    const clicks: Promise<void>[] = [];
    act(() => {
      for (let i = 0; i < 3; i++) clicks.push(result.current.send(''));
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toContain('the note');
    // The notes show as sending, and none are left for another submit.
    expect(result.current.notes.sendingCount).toBe(1);
    expect(result.current.notes.getPendingAnnotations()).toEqual([]);

    await act(async () => {
      releases[0](true);
      await Promise.all(clicks);
    });
    expect(result.current.notes.annotations).toEqual([]);
    expect(result.current.notes.sendingCount).toBe(0);
  });

  it('are pending again, and can be sent, after the server refuses the send', async () => {
    const { result, sendMessage, releases } = notesAndSend();

    let first!: Promise<void>;
    act(() => { first = result.current.send(''); });
    await act(async () => {
      releases[0](false);
      await first;
    });

    expect(result.current.notes.annotations).toHaveLength(1);
    expect(result.current.notes.sendingCount).toBe(0);

    act(() => { void result.current.send(''); });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
