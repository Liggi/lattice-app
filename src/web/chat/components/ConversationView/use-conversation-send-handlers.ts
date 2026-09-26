import { useCallback, type MutableRefObject } from 'react';
import { api } from '../../services/api';
import { formatAnnotatedMessage, type PendingAnnotation } from '../../utils/annotations-format';
import type { ChatMessage, ContentBlockParam } from '../../types';
import type { Provider } from '@/types/unified-messages';

type ConversationProvider = Provider;

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

export function formatSessionFailureMessage(provider: ConversationProvider, rawError: unknown): string {
  const message = extractErrorMessage(rawError).trim() || 'Unknown error';
  if (/permission request timeout/i.test(message) || /did not respond/i.test(message)) {
    return `Claude session paused after a permission request timed out. Retry with TRUST/accept-edits mode, or respond to permissions sooner.`;
  }
  return `${provider === 'codex' ? 'Codex' : 'Claude'} session failed: ${message}`;
}

/**
 * Put the text of a refused send back as the composer's draft. The composer
 * clears itself on submit and keeps what it cleared as a raw backup; its
 * draft is stored JSON-encoded, so the backup is encoded on the way back.
 * Returns whether there was anything to restore.
 */
export function restoreComposerDraft(conversationId: string | undefined): boolean {
  const draftKey = conversationId ? `composer-draft-${conversationId}` : 'composer-draft-home';
  const backupKey = `${draftKey}-backup`;
  try {
    const backup = localStorage.getItem(backupKey);
    if (!backup) return false;
    localStorage.setItem(draftKey, JSON.stringify(backup));
    localStorage.removeItem(backupKey);
    return true;
  } catch {
    // Storage unavailable (private mode, quota): nothing was restored.
    return false;
  }
}

interface ConversationSendSession {
  messages: ChatMessage[];
  isActive: boolean;
  isConnected: boolean;
  proposedNextSteps?: unknown[] | null;
  clearNextSteps: () => void;
  addOptimisticUserMessage: (message: string) => void;
  sendMessage: (
    message: string,
    model?: string,
    permissionMode?: string,
    attachments?: ContentBlockParam[],
    reasoningEffort?: string,
  ) => Promise<boolean>;
  enqueueMessage: (content: string) => Promise<void>;
}

export function useConversationSendHandlers(params: {
  conversationId?: string;
  provider: ConversationProvider;
  conversationPausedReason?: string | null;
  session: ConversationSendSession;
  setSessionOptimisticOngoing: (sessionId: string, provider?: ConversationProvider) => void;
  invalidateConversations: () => Promise<void>;
  restoreDraftFromBackup: () => void;
  setSessionFailureError: (value: string | null) => void;
  nextStepsDismissedRef: MutableRefObject<boolean>;
  /**
   * Pending highlight-notes the user attached to earlier assistant output.
   * Read through a stable getter so this hook's callback identity does not
   * change every time a note is added or removed.
   */
  getPendingAnnotations?: () => PendingAnnotation[];
  /** Called before the request goes, with the ids riding on it. */
  onAnnotationsSending?: (ids: string[]) => void;
  /** Called when the send is refused or fails, so those notes are pending again. */
  onAnnotationsReleased?: (ids: string[]) => void;
  /**
   * Called once the send resolves, with the ids that actually rode along, so a
   * note added while the request was in flight survives.
   */
  onAnnotationsSent?: (sentIds: string[]) => void;
}): {
  handleSendMessage: (
    message: string,
    workingDirectory?: string,
    model?: string,
    permissionMode?: string,
    attachments?: ContentBlockParam[],
    reasoningEffort?: string,
  ) => Promise<void>;
} {
  const {
    conversationId,
    provider,
    conversationPausedReason,
    session,
    setSessionOptimisticOngoing,
    invalidateConversations,
    restoreDraftFromBackup,
    setSessionFailureError,
    nextStepsDismissedRef,
    getPendingAnnotations,
    onAnnotationsSending,
    onAnnotationsReleased,
    onAnnotationsSent,
  } = params;

  const handleSendMessage = useCallback(async (
    message: string,
    _workingDirectory?: string,
    model?: string,
    permissionMode?: string,
    attachments?: ContentBlockParam[],
    reasoningEffort?: string,
  ) => {
    // Highlight-notes ride at the front of the outgoing message, before
    // whatever the user typed. Captured up front so a note added while the
    // request is in flight is not silently discarded by the clear below.
    const pendingAnnotations = getPendingAnnotations?.() ?? [];
    // A notes-only submit whose notes are already on an unresolved send is a
    // repeat click: there is nothing left to send.
    if (!message.trim() && !attachments?.length && pendingAnnotations.length === 0) return;
    const annotationIds = pendingAnnotations.map((annotation) => annotation.id);
    onAnnotationsSending?.(annotationIds);

    setSessionFailureError(null);

    if (session.proposedNextSteps && session.proposedNextSteps.length > 0) {
      nextStepsDismissedRef.current = true;
      session.clearNextSteps();
    }

    if (conversationId && conversationPausedReason) {
      void api.unifiedUpdateConversation(conversationId, { pausedReason: null });
    }

    const outgoingMessage = formatAnnotatedMessage(pendingAnnotations, message);

    try {
      session.addOptimisticUserMessage(outgoingMessage);
      if (conversationId) {
        setSessionOptimisticOngoing(conversationId, provider);
      }
      // A refused send has already shown its reason; the text goes back in
      // the composer and the notes stay pending for the next attempt.
      if (!await session.sendMessage(outgoingMessage, model, permissionMode, attachments, reasoningEffort)) {
        onAnnotationsReleased?.(annotationIds);
        restoreDraftFromBackup();
        return;
      }
      if (annotationIds.length > 0) {
        onAnnotationsSent?.(annotationIds);
      }
      void invalidateConversations();
    } catch (error) {
      console.error('[ConversationView] Send failed:', error);
      onAnnotationsReleased?.(annotationIds);
      setSessionFailureError(formatSessionFailureMessage(provider, error));
      restoreDraftFromBackup();
    }
  }, [
    conversationId,
    conversationPausedReason,
    provider,
    session,
    setSessionOptimisticOngoing,
    invalidateConversations,
    restoreDraftFromBackup,
    setSessionFailureError,
    nextStepsDismissedRef,
    getPendingAnnotations,
    onAnnotationsSending,
    onAnnotationsReleased,
    onAnnotationsSent,
  ]);

  return {
    handleSendMessage,
  };
}
