/**
 * Under the Start composer: the work left paused, so picking one back up is a
 * click. Sleeping projects (or sessions) first, then idle ones, newest used
 * first, at most five, fading down the list. Nothing shows when none are.
 */

import { type JSX, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UnifiedConversationSummary } from '../../types';
import { useConversations } from '../../contexts/ConversationsContext';
import { useSidebarLists } from '../../hooks/useSidebarLists';
import { useSessionAttentionMap } from '../../hooks/useAttentionFavicon';
import { deriveSessionActivity, lastUsedAt } from '../../utils/session-activity';
import { pausedConversations } from './start-screen';
import { useInboxFeed } from '../../hooks/useInboxFeed';
import { conversationTitle } from '../CommandPalette/command-palette-search';
import { formatAgo } from '@/types/project-state';
import { SessionStateIcon } from '../shared/session-state-icon/SessionStateIcon';

const FADE = ['opacity-100', 'opacity-[.85]', 'opacity-[.7]', 'opacity-[.55]', 'opacity-[.45]'];

export function PausedList({ kind }: { kind: 'project' | 'session' }): JSX.Element | null {
  const navigate = useNavigate();
  const { conversations } = useConversations();
  const attention = useSessionAttentionMap();
  const lists = useSidebarLists();
  const { data: inbox } = useInboxFeed();
  const paused = useMemo(() => {
    // Work waiting on the user belongs to the Inbox, not to Paused.
    const waiting = new Set(inbox?.items.map((item) => item.conversationId));
    const notWaiting = (list: UnifiedConversationSummary[]) => list.filter((c) => !waiting.has(c.conversationId));
    const isIdle = (c: UnifiedConversationSummary) =>
      deriveSessionActivity(c, conversations, (attention[c.conversationId] ?? 0) > 0).kind === 'idle';
    return kind === 'project'
      ? pausedConversations(notWaiting(lists.sleepingProjects), notWaiting(lists.projects), isIdle)
      : pausedConversations(notWaiting(lists.sleepingSessions), notWaiting([...lists.pinned, ...lists.sessions]), isIdle);
  }, [kind, lists, conversations, attention, inbox]);

  const sleepingIds = new Set([...lists.sleepingProjects, ...lists.sleepingSessions].map((c) => c.conversationId));
  if (paused.length === 0) return null;
  const now = Date.now();
  return (
    <div className="mt-4 md:mt-16 px-1" data-testid="paused-list">
      <div className="px-3 pb-2 text-[13px] font-medium text-fg-2">Paused</div>
      {paused.map((conversation, i) => (
        <button
          key={conversation.conversationId}
          type="button"
          onClick={() => void navigate(`/c/${conversation.conversationId}`)}
          className={`flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left hover:bg-surface ${FADE[i]}`}
        >
          <span className="flex w-4 shrink-0 justify-center text-fg-3">
            <SessionStateIcon state={{ kind: sleepingIds.has(conversation.conversationId) ? 'sleeping' : 'idle' }} variant={kind} size={16} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[14px] text-fg/90">{conversationTitle(conversation)}</span>
          <span className="shrink-0 text-[12.5px] tabular-nums text-fg-3">{formatAgo(now - lastUsedAt(conversation))}</span>
        </button>
      ))}
    </div>
  );
}
