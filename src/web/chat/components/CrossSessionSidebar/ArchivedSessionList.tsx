import React, { useCallback, useMemo, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import type { UnifiedConversationSummary } from '../../types';

interface ArchivedSessionListProps {
  archivedSessions: UnifiedConversationSummary[];
  currentSessionId?: string;
  isLoading: boolean;
  onSelectSession: (conversationId: string) => void;
  onRestoreSession: (conversationId: string) => Promise<void>;
}

function formatRelativeTime(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);

  if (diffSecs < 10) return 'now';
  if (diffSecs < 60) return `${diffSecs}s`;
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

function archivedAgo(archivedAt: string): string {
  const relative = formatRelativeTime(archivedAt);
  return relative === 'now' ? 'archived just now' : `archived ${relative} ago`;
}

function getArchivedLabel(session: UnifiedConversationSummary): string {
  const insights = session.insights;
  const customName = session.customName?.trim();
  const prompt = session.initialPromptPreview?.trim();

  return customName
    || insights?.context?.mission
    || insights?.purpose
    || prompt
    || session.conversationId.slice(0, 8);
}

export function ArchivedSessionList({
  archivedSessions,
  currentSessionId,
  isLoading,
  onSelectSession,
  onRestoreSession,
}: ArchivedSessionListProps): JSX.Element {
  const [restoringSessionId, setRestoringSessionId] = useState<string | null>(null);

  const handleRestore = useCallback(async (conversationId: string) => {
    if (restoringSessionId) return;

    setRestoringSessionId(conversationId);
    try {
      await onRestoreSession(conversationId);
    } catch (error) {
      console.error('Failed to restore archived session:', error);
    } finally {
      setRestoringSessionId(null);
    }
  }, [onRestoreSession, restoringSessionId]);

  const cards = useMemo(() => archivedSessions.map((session) => {
    const label = getArchivedLabel(session);
    const isCurrent = session.conversationId === currentSessionId;
    const isRestoring = restoringSessionId === session.conversationId;

    return (
      <div
        key={session.conversationId}
        className={`group relative flex items-center gap-2.5 rounded-sm transition-colors ${
          isCurrent ? 'bg-surface' : 'hover:bg-surface-2'
        }`}
      >
        <button
          onClick={() => onSelectSession(session.conversationId)}
          className="flex min-w-0 flex-1 items-baseline gap-2.5 px-2 py-[5px] text-left text-[13px] cursor-pointer"
          type="button"
        >
          <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'text-fg' : 'text-fg-2'}`}>{label}</span>
          {/*
            Only a recorded archive time is shown. Rows archived before it was
            recorded show none: their last activity moves on every server boot,
            so it read as a misleading "32s". On touch the restore button is
            always shown, so the time sits left of it rather than under it.
          */}
          {session.archivedAt && (
            <span className="shrink-0 text-xs text-fg-3 tabular-nums group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:mr-7 pointer-coarse:opacity-100">
              {archivedAgo(session.archivedAt)}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void handleRestore(session.conversationId);
          }}
          disabled={Boolean(restoringSessionId)}
          // Hover-revealed on pointer devices, always shown on touch: there is
          // no hover there, and this is the only restore affordance.
          className={`absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-sm bg-surface-2 transition-colors cursor-pointer disabled:cursor-wait opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 ${
            isRestoring ? 'text-accent' : 'text-fg-3 hover:text-fg'
          }`}
          aria-label={`Restore ${label}`}
        >
          {isRestoring ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
        </button>
      </div>
    );
  }), [archivedSessions, currentSessionId, handleRestore, restoringSessionId, onSelectSession]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-px">
        {['archived-skeleton-1', 'archived-skeleton-2', 'archived-skeleton-3'].map((id) => (
          <div key={id} className="mx-2 my-1.5 h-3.5 w-3/4 animate-pulse rounded bg-surface" />
        ))}
      </div>
    );
  }

  if (archivedSessions.length === 0) {
    return (
      <div className="px-2 py-1.5 text-[13px] text-fg-3">
        No archived sessions
      </div>
    );
  }

  return <div className="flex flex-col gap-px">{cards}</div>;
}
