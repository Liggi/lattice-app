/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  PanelLeft,
  Plus,
  ChevronDown, ChevronRight,
  Inbox,
  Moon,
} from 'lucide-react';
import { useFeedbackInboxUnread, useFeedbackStatus } from '../../hooks/useFeedback';
import { SessionCard } from '../shared/SessionCard';
import { LatticeLogo } from '../shared/LatticeLogo';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { ArchivedSessionList } from './ArchivedSessionList';
import { useConversations } from '../../contexts/ConversationsContext';
import { archivedSidebarQueryKey, useArchivedSidebarSessions } from '../../hooks/useArchivedSidebarSessions';
import { useTeamStatus, type TeamRuntimeStatus } from '../../hooks/useTeamStatus';
import { useAmbientReads } from '../../hooks/useAmbientReads';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { useUserSendMarks } from '../shared/user-send-marks';
import { api } from '../../services/api';
import { useSidebarLists } from '../../hooks/useSidebarLists';
import type { UnifiedConversationSummary } from '../../types';
import { parseJson } from '../../../../utils/json.js';


const COLLAPSED_KEY = 'lattice-sidebar-collapsed';

function loadCollapsed(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY);
    if (!stored) return {};
    const parsed: unknown = parseJson(stored);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

type SessionNameAction = 'rename';

// ============================================================================
// COLLAPSIBLE GROUP
// ============================================================================

// A group is a label row and its items. The label is text, not a bar: 12px
// medium in the tertiary grey, with the count beside it and a chevron that only
// shows on hover. Group colour does not encode state; the rows do.
function CollapsibleGroup({
  title, count, isCollapsed, onToggle, headerRight, children
}: {
  title: string; count?: number; isCollapsed?: boolean; onToggle: () => void;
  headerRight?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        className="group/sec w-full flex items-center gap-1.5 px-2 py-1 mb-0.5 rounded-sm text-xs font-medium text-fg-3 hover:text-fg-2 cursor-pointer"
      >
        <span>{title}</span>
        {count !== undefined && <span className="tabular-nums">{count}</span>}
        <span className="opacity-0 group-hover/sec:opacity-100 transition-opacity">
          {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
        {headerRight && <span className="ml-auto">{headerRight}</span>}
      </button>
      {!isCollapsed && (
        <div className="flex flex-col gap-px">
          {children}
        </div>
      )}
    </div>
  );
}

// A list's Sleeping rows, folded under one quiet row at the end of the list.
// It sits in the list like a row: a moon in the cards' icon column and the
// label in their title column, lighter and dimmer than the section title, with
// the chevron after the label. It gets extra space when an awake row is above.
function SleepingGroup({
  isCollapsed, onToggle, testId, children,
}: {
  isCollapsed: boolean; onToggle: () => void; testId: string; children: React.ReactNode;
}) {
  const Chevron = isCollapsed ? ChevronRight : ChevronDown;
  return (
    <div data-testid={testId} className="flex flex-col gap-px not-first:mt-2">
      <button
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        className="flex w-full items-center gap-2.5 px-2 py-1 rounded-sm text-[11.5px] text-fg-3/70 hover:text-fg-2 hover:bg-surface-2 cursor-pointer"
      >
        <span className="flex w-7 shrink-0 justify-center"><Moon size={13} strokeWidth={1.75} /></span>
        <span>Sleeping</span>
        <Chevron size={11} className="-ml-1.5 opacity-60" />
      </button>
      {!isCollapsed && children}
    </div>
  );
}

// ============================================================================
// MAIN SIDEBAR COMPONENT
// ============================================================================

interface CrossSessionSidebarProps {
  currentSessionId?: string;
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
}

export function CrossSessionSidebar({
  currentSessionId,
  isOpen,
  onClose,
  onOpen: _onOpen,
}: CrossSessionSidebarProps): JSX.Element | null {
  const navigate = useNavigate();
  const location = useLocation();
  const onFeedbackPage = location.pathname === '/feedback';
  const feedbackInbox = useFeedbackStatus()?.inbox === true;
  const feedbackUnread = useFeedbackInboxUnread(feedbackInbox);
  const queryClient = useQueryClient();
  const { loading, recentActions, invalidateConversations, recentlyCompletedSessions } = useConversations();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [sessionNameActions, setSessionNameActions] = useState<Record<string, SessionNameAction | undefined>>({});

  const toggleCollapse = useCallback((group: string, defaultCollapsed = false) => {
    setCollapsed(prev => {
      const currentState = prev[group] ?? defaultCollapsed;
      const next = { ...prev, [group]: !currentState };
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // A project is a coordinator conversation: opening it lands in the
  // coordinator's thread, and its name is the conversation's custom name.
  // Projects, pinned sessions and sessions each keep a fixed order, newest
  // created first, and sleeping ones drop into a Sleeping group; see sidebarLists.
  const {
    projects, sleepingProjects, pinned: pinnedSessions, sessions: unpinnedSessions, sleepingSessions,
  } = useSidebarLists();
  const activeSessions = useMemo(
    () => [...pinnedSessions, ...unpinnedSessions, ...sleepingSessions],
    [pinnedSessions, unpinnedSessions, sleepingSessions]
  );
  const sleepingProjectsCollapsed = collapsed.sleepingProjects ?? true;
  const sleepingSessionsCollapsed = collapsed.sleepingSessions ?? true;
  const archivedCollapsed = collapsed.archived ?? true;
  const { archivedSessions, isLoading: archivedLoading } = useArchivedSidebarSessions({
    enabled: isOpen && !archivedCollapsed,
  });
  const workspaceArchivedSessions = useMemo(
    () => archivedSessions,
    [archivedSessions]
  );
  // Argus's reads supply each card's stable purpose and relationship line. Only polled while
  // the sidebar is open — a closed sidebar renders no cards to put them on — and only on a
  // machine where an ambient watcher has written a scan.
  const { serverConfig } = usePreferencesContext();
  const { readsBySessionId: ambientReads } = useAmbientReads({ enabled: isOpen && serverConfig?.ambientScan === true });
  // Argus's arrow is as old as the scan that produced it. These marks say where
  // the reader has already acted since, so a card stops asking for a reply they
  // has sent while the next scan catches up.
  const userSendMarks = useUserSendMarks();
  const { teamStatuses } = useTeamStatus(activeSessions);
  const getTeamStatusForSession = useCallback((teamName?: string | null): TeamRuntimeStatus | undefined => {
    const normalized = teamName?.trim();
    if (!normalized) return undefined;
    return teamStatuses[normalized];
  }, [teamStatuses]);

  const handleSessionClick = useCallback((conversationId: string) => {
    if (conversationId.startsWith('pending-')) {
      return;
    }
    if (conversationId !== currentSessionId) {
      void navigate(`/c/${conversationId}`);
      // Auto-close sidebar on narrow screens after selecting a session
      if (window.innerWidth < 768) {
        onClose();
      }
    }
  }, [currentSessionId, navigate, onClose]);

  const markSessionNameAction = useCallback((conversationId: string, action?: SessionNameAction) => {
    setSessionNameActions((prev) => ({ ...prev, [conversationId]: action }));
  }, []);

  const handleRenameSessionName = useCallback(async (conversation: UnifiedConversationSummary, nextName: string) => {
    const { conversationId } = conversation;
    if (!conversationId || conversationId.startsWith('pending-')) return;
    if (sessionNameActions[conversationId]) return;

    const trimmed = nextName.trim();
    if (!trimmed) return;

    markSessionNameAction(conversationId, 'rename');
    try {
      await api.unifiedUpdateConversation(conversationId, { customName: trimmed });
      await invalidateConversations();
    } catch (error) {
      console.error('Failed to rename session:', error);
    } finally {
      markSessionNameAction(conversationId, undefined);
    }
  }, [invalidateConversations, markSessionNameAction, sessionNameActions]);

  const handleRestoreArchivedSession = useCallback(async (conversationId: string) => {
    if (!conversationId || conversationId.startsWith('pending-')) return;
    try {
      await api.unifiedUpdateConversation(conversationId, { archived: false });
      await Promise.all([
        invalidateConversations(),
        queryClient.invalidateQueries({ queryKey: archivedSidebarQueryKey }),
      ]);
    } catch (error) {
      console.error('Failed to restore archived session:', error);
      throw error;
    }
  }, [invalidateConversations, queryClient]);

  const renderCard = (conversation: UnifiedConversationSummary, withTeamStatus: boolean) => (
    <SessionCard
      key={conversation.conversationId}
      conversation={conversation}
      ambientRead={ambientReads.get(conversation.conversationId) ?? null}
      userSentAt={userSendMarks[conversation.conversationId] ?? null}
      teamStatus={withTeamStatus ? getTeamStatusForSession(conversation.teamName) : undefined}
      isCurrent={conversation.conversationId === currentSessionId}
      onClick={() => handleSessionClick(conversation.conversationId)}
      recentActions={recentActions[conversation.conversationId]}
      recentlyCompleted={recentlyCompletedSessions.has(conversation.conversationId)}
      onRenameSessionName={handleRenameSessionName}
      isRenamingSessionName={sessionNameActions[conversation.conversationId] === 'rename'}
    />
  );

  // Don't render anything when sidebar is closed - header has the toggle button
  if (!isOpen) {
    return null;
  }

  return (
    <TooltipProvider>
    <aside className="relative w-full md:w-[288px] md:max-w-[288px] bg-bg-2 flex-shrink-0 flex flex-col h-full">
      {/* Brand and close. The wordmark lives here, not in the header, so the
          header can carry what the session is about. */}
      <div className="flex items-center justify-between pl-5 pr-4 pt-4 pb-1.5">
        <span className="flex items-center gap-2" aria-label="Lattice">
          <LatticeLogo size={28} interactive={true} colorScheme="gradient" />
          <span className="wordmark text-[15px] text-white">lattice</span>
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onClose}
              className="p-1.5 ui-icon-btn text-fg-3"
              aria-label="Close sidebar"
            >
              <PanelLeft size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Close sidebar
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Session list */}
      <div className="relative flex-1 overflow-y-auto px-3 pt-2 pb-3 flex flex-col gap-5">
        {feedbackInbox && (
          <button
            onClick={() => {
              void navigate('/feedback');
              if (window.innerWidth < 768) onClose();
            }}
            data-testid="sidebar-feedback-inbox"
            className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-sm transition-colors cursor-pointer ${
              onFeedbackPage ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:text-fg hover:bg-surface'
            }`}
          >
            {/* The icon sits in the cards' 28px icon column, so it and the label line up with the rows below. */}
            <span className="flex items-center gap-2.5">
              <span className="flex w-7 shrink-0 justify-center"><Inbox size={16} className="text-fg-3" /></span>
              <span>Feedback</span>
            </span>
            {feedbackUnread ? <span className="font-mono text-[11px] text-accent">{feedbackUnread} unread</span> : null}
          </button>
        )}

        <div data-testid="projects-section">
          <div className="flex items-center justify-between px-2 pb-1.5 text-xs font-medium text-fg-3">
            <span>Projects</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    void navigate('/new?coordinator=1&mode=bypassPermissions');
                    if (window.innerWidth < 768) onClose();
                  }}
                  className="p-0.5 rounded-[4px] text-fg-3 hover:text-fg hover:bg-surface-2 cursor-pointer"
                  aria-label="New project"
                >
                  <Plus size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent>New project</TooltipContent>
            </Tooltip>
          </div>
          {!loading && projects.length === 0 && sleepingProjects.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-fg-3">No projects yet</div>
          )}
          {(projects.length > 0 || sleepingProjects.length > 0) && (
            <div className="flex flex-col gap-px">
              {projects.map(project => renderCard(project, false))}
              {sleepingProjects.length > 0 && (
                <SleepingGroup
                  testId="sleeping-projects"
                  isCollapsed={sleepingProjectsCollapsed} onToggle={() => toggleCollapse('sleepingProjects', true)}
                >
                  {sleepingProjects.map(project => renderCard(project, false))}
                </SleepingGroup>
              )}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between px-2 pb-1.5 text-xs font-medium text-fg-3">
            <span>Sessions</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    void navigate('/new?provider=claude&mode=bypassPermissions');
                    if (window.innerWidth < 768) onClose();
                  }}
                  className="p-0.5 rounded-[4px] text-fg-3 hover:text-fg hover:bg-surface-2 cursor-pointer"
                  aria-label="New session"
                >
                  <Plus size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent>New session</TooltipContent>
            </Tooltip>
          </div>

          {loading ? (
            // Loading skeleton - mirrors the SessionCard row: tile, title, second line
            <div className="flex flex-col gap-px">
              {['session-skeleton-1', 'session-skeleton-2', 'session-skeleton-3'].map((skeletonId) => (
                <div key={skeletonId} className="flex items-start gap-2.5 px-2 py-1.5 animate-pulse">
                  <div className="mt-0.5 h-7 w-7 rounded-[7px] bg-surface" />
                  <div className="flex-1 space-y-1.5 pt-1">
                    <div className="h-3 w-4/5 rounded bg-surface" />
                    <div className="h-2.5 w-3/5 rounded bg-surface" />
                  </div>
                </div>
              ))}
            </div>
          ) : activeSessions.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-fg-3">
              No active sessions
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {/* Pinned sessions sit above the rest */}
              {pinnedSessions.length > 0 && (
                <CollapsibleGroup
                  title="Pinned" count={pinnedSessions.length}
                  isCollapsed={collapsed.pinned} onToggle={() => toggleCollapse('pinned')}
                >
                  {pinnedSessions.map(session => renderCard(session, true))}
                </CollapsibleGroup>
              )}

              {(unpinnedSessions.length > 0 || sleepingSessions.length > 0) && (
                <div className="flex flex-col gap-px">
                  {unpinnedSessions.map(session => renderCard(session, true))}
                  {sleepingSessions.length > 0 && (
                    <SleepingGroup
                      testId="sleeping-sessions"
                      isCollapsed={sleepingSessionsCollapsed} onToggle={() => toggleCollapse('sleepingSessions', true)}
                    >
                      {sleepingSessions.map(session => renderCard(session, true))}
                    </SleepingGroup>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {!loading && (
          <CollapsibleGroup
            title="Archived"
            isCollapsed={archivedCollapsed}
            onToggle={() => toggleCollapse('archived', true)}
          >
            <ArchivedSessionList
              archivedSessions={workspaceArchivedSessions}
              currentSessionId={currentSessionId}
              isLoading={archivedLoading}
              onSelectSession={handleSessionClick}
              onRestoreSession={handleRestoreArchivedSession}
            />
          </CollapsibleGroup>
        )}
      </div>
    </aside>

    </TooltipProvider>
  );
}
