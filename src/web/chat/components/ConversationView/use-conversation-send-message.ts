import { useCallback } from 'react';
import type { ContentBlockParam } from '../../types';
import { markUserSend } from '../shared/user-send-marks';

/** Signature of the view's send: resolves true when the server accepted the message. */
export type SendMessage = (
  message: string,
  model?: string,
  permissionMode?: string,
  attachments?: ContentBlockParam[],
  reasoningEffort?: string,
) => Promise<boolean>;

/**
 * The composer's send. Every message goes to the server before this returns,
 * whatever the session is doing, because the view that called it can unmount
 * at any moment (a session switch, a reload) and takes its state with it.
 */
export function useConversationSendMessage({
  conversationId,
  connected: harnessConnected,
  send: harnessSend,
  compact: harnessCompact,
  reconnect: harnessReconnect,
  setLocalError,
}: {
  conversationId: string | undefined;
  connected: boolean;
  send: (input: string, extra?: Record<string, unknown>) => Promise<void>;
  compact: () => Promise<void>;
  reconnect: () => void;
  setLocalError: (error: string | null) => void;
}): SendMessage {
  return useCallback(async (
    message: string,
    model?: string,
    permissionMode?: string,
    attachments?: ContentBlockParam[],
    reasoningEffort?: string,
  ): Promise<boolean> => {
    // Composer attachments (already ContentBlockParam[] via LatticeComposer's
    // toContentBlockParam) ride both send paths. Omitted entirely when empty so
    // a plain message keeps its existing wire shape.
    const attachmentBlocks = attachments && attachments.length > 0 ? attachments : undefined;
    // A new attempt replaces the last refusal; it must not stay on screen over
    // a message that was then accepted.
    setLocalError(null);
    try {
      if (message.trim() === '/compact' && !attachmentBlocks) {
        await harnessCompact();
        return true;
      }
      // A message sent during a compaction goes to the server like any other.
      // Held here it lived only in this view's state, so switching session or
      // reloading before the compaction ended lost it. The server keeps it and
      // the provider takes it once the compaction has finished.
      // No optimistic message needed — SSE delivers input:sent within ~1-5ms
      // of the HTTP send response on localhost.
      if (harnessConnected) {
        // Session exists (SSE connected). Use /send for stdin injection.
        // Works both when idle and mid-turn — the CLI queues stdin input
        // internally and processes it after the current turn completes.
        // If the process died from idle timeout, /send handles respawn
        // with --resume automatically.
        //
        // The second arg is the harness client's `extra` bag: it spreads into
        // the /send body and the server threads it to ProcessHandle.write().
        // A model in the bag triggers respawn-with-resume on the new model
        // when the session is idle (mid-session model switch).
        const sendExtra = model || attachmentBlocks || reasoningEffort
          ? {
              ...(model ? { model } : {}),
              ...(attachmentBlocks ? { attachments: attachmentBlocks } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
            }
          : undefined;
        await harnessSend(message, sendExtra);
        // The sidebar's Argus arrow is a snapshot from the last ambient scan.
        // A successful send answers `your-move` immediately; failed sends leave
        // the ask visible so it is not silently lost.
        if (conversationId) markUserSend(conversationId);
      } else {
        // No harness session — create one via /start. This is the first
        // message or the page loaded with no existing session.
        const resp = await fetch(`/api/harness/${conversationId}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: message,
            model,
            permissionMode,
            ...(attachmentBlocks ? { attachments: attachmentBlocks } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          }),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({ error: 'Start failed' })) as { error?: string };
          throw new Error(body.error || 'Start failed');
        }
        if (conversationId) markUserSend(conversationId);
        harnessReconnect();
      }
      return true;
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Send failed');
      return false;
    }
  }, [conversationId, harnessCompact, harnessConnected, harnessSend, harnessReconnect, setLocalError]);
}
