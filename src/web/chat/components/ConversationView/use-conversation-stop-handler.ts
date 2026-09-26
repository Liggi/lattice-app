import { useCallback } from 'react';
import { api } from '../../services/api';

interface ConversationStopSession {
  stop: () => Promise<boolean>;
  forceKill: () => Promise<void>;
}

export function useConversationStopHandler(params: {
  session: ConversationStopSession;
  conversationId?: string;
  setStopRequested: (value: boolean) => void;
}): {
  handleStop: () => Promise<void>;
} {
  const { session, conversationId, setStopRequested } = params;

  const handleStop = useCallback(async () => {
    setStopRequested(true);

    if (!conversationId) {
      try {
        const stopped = await session.stop();
        if (!stopped) {
          console.warn('[stop] Graceful stop failed, escalating to force-kill');
          await session.forceKill();
        }
      } catch (err) {
        console.error('[stop] Stop/force-kill threw:', err);
      }
      setStopRequested(false);
      return;
    }

    // Escalate only when the turn this stop was aimed at did not end. The
    // session's status cannot say that: after a stop works, a queued message
    // or an auto-compaction opens the next turn within milliseconds, and
    // reading "ongoing" then force-killed that work — including compactions —
    // which nobody had asked to stop.
    try {
      const { ended } = await api.stopTurn(conversationId);
      if (!ended) {
        console.warn('[stop] The stopped turn did not end in time, sending force-kill', { conversationId });
        await api.unifiedForceKillConversation(conversationId);
      }
    } catch (err) {
      console.error('[stop] Unexpected error during stop sequence:', err);
    }

    setStopRequested(false);
  }, [session, conversationId, setStopRequested]);

  return { handleStop };
}
