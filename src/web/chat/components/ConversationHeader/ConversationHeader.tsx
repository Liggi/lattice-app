/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import { type JSX, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Moon, ArrowLeft, ChevronRight, PanelRight, PanelLeft, Menu as MenuIcon, MoreHorizontal, Search, Settings, Import, MessageSquare } from 'lucide-react';
import { useCommandPalette } from '../CommandPalette/CommandPalette';
import { useLiveJobs } from '../ConversationView/RunningJobsStrip';
import { LatticeLogo } from '../shared/LatticeLogo';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/web/chat/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/web/chat/components/ui/popover';
import { useConversations } from '../../contexts/ConversationsContext';
import { SettingsDialog } from '../SettingsDialog/SettingsDialog';
import { PlanUsageControl, PlanUsageMenuRow, usePlanUsageAlert } from './PlanUsageControl';
import { planSignInWaiting } from '../SettingsDialog/ChatGPTPlanCard';
import { archivedSidebarQueryKey } from '../../hooks/useArchivedSidebarSessions';
import { removeConversationFromListCache, type ConversationListCacheData } from '../../utils/conversation-list-cache';
import { useToast } from '../Toast/Toast';
import { FeedbackDialog } from '../Feedback/FeedbackDialog';
import { noteViewing, offerUndo, runUndo, undoShowsOn, usePendingUndo } from './pending-undo';
import { UndoButton } from './UndoButton';
import { Contained } from '../ErrorBoundary';
import { conversationTitle } from '../CommandPalette/command-palette-search';

interface ConversationHeaderProps {
  sessionId?: string;
  isArchived?: boolean;
  isPinned?: boolean;
  subtitle?: {
    date?: string;
    repo?: string;
    commitSHA?: string;
    changes?: {
      additions: number;
      deletions: number;
    };
  };
  onPinToggle?: (isPinned: boolean) => void;
  /** What the session is about, resolved by the view so a worker with no sidebar row still has one. */
  title?: string | null;
  /** The project a worker was picked up from, resolved by the view; absent on ordinary sessions. */
  parentConversationId?: string | null;
  insightsPanelOpen?: boolean;
  onToggleInsightsPanel?: () => void;
  // Cross-session sidebar controls (for mobile)
  crossSessionSidebarOpen?: boolean;
  onToggleCrossSessionSidebar?: () => void;
}

export function ConversationHeader({
  sessionId,
  isArchived = false,
  parentConversationId = null,
  title = null,
  insightsPanelOpen,
  onToggleInsightsPanel,
  crossSessionSidebarOpen,
  onToggleCrossSessionSidebar,
}: ConversationHeaderProps): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { conversations, invalidateConversations } = useConversations();
  const [menuOpen, setMenuOpen] = useState(false);
  const palette = useCommandPalette();
  const [usageOpen, setUsageOpen] = useState(false);
  const usageAlert = usePlanUsageAlert();
  const runningJobs = useLiveJobs(sessionId);
  const [settingsOpen, setSettingsOpen] = useState(planSignInWaiting);
  // An agent's proposals appear as cards in the chat, not here.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { showToast } = useToast();
  const pendingUndo = usePendingUndo();
  useEffect(() => noteViewing(sessionId), [sessionId, pendingUndo]);

  const refreshLists = () => Promise.all([
    invalidateConversations(),
    queryClient.invalidateQueries({ queryKey: archivedSidebarQueryKey }),
  ]);

  // Archiving leaves the session, so changing your mind straight away should
  // not mean hunting for it in the Archived list. Undo follows to the session
  // archiving lands on, in the Archive button's place.
  const offerUndoArchive = (conversationId: string) => {
    offerUndo('archive', conversationId, async () => {
      await api.unifiedUpdateConversation(conversationId, { archived: false });
      await refreshLists();
      void navigate(`/c/${conversationId}`);
    });
  };

  const handleArchive = async () => {
    if (!sessionId) {
      return;
    }

    try {
      await api.unifiedUpdateConversation(sessionId, { archived: !isArchived });
      if (!isArchived) {
        queryClient.setQueriesData(
          {
            predicate: (query) => query.queryKey[0] === 'conversations' && query.queryKey[1] === 'list',
          },
          (oldData: unknown) => removeConversationFromListCache(
            oldData as ConversationListCacheData | undefined,
            sessionId
          )
        );
      }

      await refreshLists();
      void navigate('/', { replace: true });
      if (!isArchived) offerUndoArchive(sessionId);
    } catch (err) {
      console.error(`[Archive] Failed to ${isArchived ? 'unarchive' : 'archive'} session:`, err);
    }
  };

  const activeConversation = conversations.find(conv => conv.conversationId === sessionId);
  const isImported = Boolean(activeConversation?.importedAt);
  // Sleep moves a sidebar row into its Sleeping group now rather than after
  // three quiet hours; nothing stops. Pinned rows never move and a worker has
  // no row, so neither is offered it.
  const isSlept = Boolean(activeConversation?.sleptAt);
  const canSleep = Boolean(activeConversation) && !isArchived && !activeConversation?.pinned && !parentConversationId;

  const setSlept = async (slept: boolean) => {
    if (!sessionId) return;
    await api.unifiedUpdateConversation(sessionId, { slept });
    await invalidateConversations();
  };

  const handleSleep = async () => {
    try {
      await setSlept(!isSlept);
      if (!isSlept && sessionId) offerUndo('sleep', sessionId, () => setSlept(false));
    } catch (err) {
      console.error('[Sleep] Failed to change sleep:', err);
      showToast({ title: isSlept ? 'Could not wake it' : 'Could not put it to sleep', type: 'error' });
    }
  };
  // A worker's way back to the project it was picked up from. The view
  // resolves it, so an archived worker — not in the conversations list —
  // keeps the same way back as a live one.
  const projectId = parentConversationId;
  const projectRow = projectId ? conversations.find(conv => conv.conversationId === projectId) : undefined;
  const projectTitle = projectRow ? conversationTitle(projectRow) : null;
  // Archive's Undo shows on the session you land on, Sleep's on the session
  // slept; switching to another session drops it.
  const undoShown = pendingUndo && undoShowsOn(pendingUndo, sessionId) ? pendingUndo : null;
  const undoArchive = undoShown?.action === 'archive' ? undoShown : null;
  const undoSleep = undoShown?.action === 'sleep' ? undoShown : null;
  const undoHere = undoArchive ?? undoSleep;
  const undoNow = () => runUndo((action) => {
    showToast({ title: action === 'archive' ? 'Could not undo archive' : 'Could not undo sleep', type: 'error' });
  });
  const iconBtn = 'p-1.5 ui-icon-btn disabled:opacity-40 disabled:cursor-not-allowed';
  const menuItem = 'flex items-center gap-3 w-full px-3 py-2 rounded-sm text-sm text-fg-2 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';

  const menuRows = (
    <div className="flex flex-col gap-px">
      {/* Phone: the usage rings live here, not in the header; tapping the row shows the same figures as the desktop popover. */}
      <div className="sm:hidden">
        <Contained name="PlanUsage"><PlanUsageMenuRow open={usageOpen} onToggle={() => setUsageOpen((v) => !v)} className={`${menuItem} py-0`} /></Contained>
        <div className="border-t border-line my-1" />
      </div>
      {isImported && (
        <div className="flex items-center gap-3 px-3 py-2 text-sm text-fg-2">
          <Import size={16} />
          <span>Imported, read-only</span>
        </div>
      )}
      {canSleep && (
        <button
          onClick={() => {
            void handleSleep();
            setMenuOpen(false);
          }}
          aria-pressed={isSlept}
          className={menuItem}
          data-testid="session-sleep"
        >
          <Moon size={16} />
          <span>{isSlept ? 'Wake' : 'Sleep'}</span>
        </button>
      )}
      <button
        onClick={() => {
          void handleArchive();
          setMenuOpen(false);
        }}
        disabled={!sessionId}
        aria-label={isArchived ? 'Unarchive Task' : 'Archive Task'}
        className={menuItem}
      >
        <Archive size={16} />
        <span>{isArchived ? 'Restore' : 'Archive'}</span>
      </button>
      <button
        onClick={() => {
          setFeedbackOpen(true);
          setMenuOpen(false);
        }}
        disabled={!sessionId}
        className={menuItem}
        data-testid="session-feedback"
      >
        <MessageSquare size={16} />
        <span>Send feedback</span>
      </button>
      <div className="border-t border-line my-1" />
      <button
        onClick={() => {
          setSettingsOpen(true);
          setMenuOpen(false);
        }}
        className={menuItem}
      >
        <Settings size={16} />
        <span>Settings</span>
      </button>
    </div>
  );

  return (
    <TooltipProvider>
      {/* Full-width band with a hairline under it; the thread and the side panel both start beneath it. */}
      <div className="relative flex items-center gap-1 sm:gap-2 h-[52px] pl-1.5 pr-1.5 sm:pl-4 sm:pr-3 bg-bg border-b border-line flex-shrink-0">
        {/* Left: the sessions sidebar, then Back on a worker. The brand only
            shows on desktop while the sidebar, which carries it, is closed. */}
        <div className="flex items-center gap-1 sm:gap-2.5 shrink-0">
          {onToggleCrossSessionSidebar && (
            <button
              type="button"
              onClick={onToggleCrossSessionSidebar}
              aria-label={crossSessionSidebarOpen ? 'Close sessions sidebar' : 'Open sessions sidebar'}
              aria-pressed={Boolean(crossSessionSidebarOpen)}
              className="flex sm:hidden items-center justify-center w-10 h-10 ui-icon-btn touch-manipulation"
            >
              <MenuIcon size={20} />
            </button>
          )}
          {onToggleCrossSessionSidebar && !crossSessionSidebarOpen && (
            <>
              <button
                onClick={onToggleCrossSessionSidebar}
                aria-label="Open sessions sidebar"
                className={`hidden sm:block ${iconBtn}`}
              >
                <PanelLeft size={18} />
              </button>
              <span className="hidden sm:flex items-center gap-2 mr-2" aria-label="Lattice">
                <LatticeLogo size={24} interactive={true} colorScheme="gradient" />
                <span className="wordmark text-[15px] text-white">lattice</span>
              </span>
            </>
          )}
          {/* Phone: an arrow back to the project. Desktop: the project's name as
              a breadcrumb before the title, so it says where Back goes. */}
          {projectId && (
            <button
              type="button"
              data-testid="back-to-project"
              onClick={() => navigate(`/c/${projectId}`)}
              aria-label={projectTitle ? `Back to ${projectTitle}` : 'Back to project'}
              className="flex items-center justify-center sm:justify-start gap-1.5 w-10 h-10 sm:w-auto sm:h-auto sm:-ml-1.5 sm:px-1.5 sm:py-1 rounded-md text-fg-2 hover:text-fg sm:hover:bg-surface-2 cursor-pointer touch-manipulation transition-colors"
            >
              <ArrowLeft className="size-[18px] sm:size-[15px] flex-shrink-0" />
              <span className="hidden sm:inline whitespace-nowrap text-[15px] leading-[1.25]">{projectTitle ?? 'Project'}</span>
            </button>
          )}
          {projectId && <ChevronRight aria-hidden className="hidden sm:block size-[14px] text-fg-3 flex-shrink-0 -ml-1" />}
        </div>

        {/* What this session is about, wrapping to a second line rather than cut off. A session with no title yet shows the brand on a phone, where the sidebar carrying it is hidden. */}
        <h1
          data-testid="conversation-title"
          title={title ?? undefined}
          className="min-w-0 flex-1 line-clamp-2 break-words text-[14.5px] sm:text-[15px] font-medium leading-[1.25] text-fg"
        >
          {title ?? (
            <span className="flex sm:hidden items-center gap-2" aria-label="Lattice">
              <LatticeLogo size={20} interactive={false} colorScheme="gradient" />
              <span className="wordmark text-[14px] text-fg-2">lattice</span>
            </span>
          )}
        </h1>

        <div className="flex items-center gap-0.5 flex-shrink-0">
          <span className="hidden sm:inline mr-1.5"><Contained name="PlanUsage"><PlanUsageControl /></Contained></span>
          {isImported && (
            <span className="hidden sm:flex items-center gap-1.5 mr-2 text-xs text-fg-2"><Import size={13} />Read-only</span>
          )}
          <button
            type="button"
            onClick={palette.open}
            aria-label="Search"
            className="flex sm:hidden items-center justify-center w-10 h-10 ui-icon-btn touch-manipulation"
          >
            <Search size={19} />
          </button>
          {undoHere && <span className="hidden sm:inline-flex"><UndoButton pending={undoHere} onUndo={undoNow} variant="icon" /></span>}

          {/* Same panel icon as the sidebar's toggle, held open-styled while the panel shows. A session with no right panel (a worker) shows no panel control. */}
          {onToggleInsightsPanel && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggleInsightsPanel}
                  aria-label={insightsPanelOpen ? 'Hide panel' : 'Show panel'}
                  aria-pressed={Boolean(insightsPanelOpen)}
                  className={`relative flex items-center justify-center w-10 h-10 sm:w-auto sm:h-auto ${iconBtn} touch-manipulation ${insightsPanelOpen ? 'text-fg bg-surface' : ''}`}
                >
                  <PanelRight className="size-[19px] sm:size-4" />
                  {!insightsPanelOpen && <RunningCount count={runningJobs.length} place="right-0.5 top-0.5 sm:-right-1.5 sm:-top-1.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{insightsPanelOpen ? 'Hide panel' : 'Show panel'}</TooltipContent>
            </Tooltip>
          )}

          {/* On a phone Undo takes the menu button's place until its time runs out, since the menu closes when Sleep or Archive is tapped. */}
          {undoHere ? (
            <span className="sm:hidden"><UndoButton pending={undoHere} onUndo={undoNow} variant="menu" /></span>
          ) : null}
          <span className={undoHere ? 'hidden sm:inline-flex' : 'inline-flex'}>
            <Popover
              open={menuOpen}
              onOpenChange={(next) => { setMenuOpen(next); if (!next) setUsageOpen(false); }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={`relative flex items-center justify-center w-10 h-10 sm:w-auto sm:h-auto ${iconBtn} touch-manipulation ${menuOpen ? 'text-fg bg-surface' : ''}`}
                  aria-label={usageAlert ? `More, usage ${usageAlert === 'rose' ? 'used up or nearly' : 'runs out before the reset'}` : 'More'}
                >
                  <MoreHorizontal className="size-5 sm:size-4" />
                  {/* Phone only: the usage rings live in this menu, so a dot on its button says they need a look. */}
                  {usageAlert && (
                    <span
                      data-testid="usage-alert-dot"
                      aria-hidden
                      className={`sm:hidden absolute right-2 top-2 size-2 rounded-full ring-2 ring-bg ${usageAlert === 'rose' ? 'bg-rose-400' : 'bg-amber-400'}`}
                    />
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                sideOffset={8}
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
                className="w-64 max-w-[calc(100vw-24px)] p-1.5 bg-surface border border-line rounded-lg shadow-none z-[100]"
              >
                {menuRows}
              </PopoverContent>
            </Popover>
          </span>
        </div>
      </div>

      {/* Settings Dialog */}
      <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <FeedbackDialog
        isOpen={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        conversationId={sessionId ?? null}
        screen="conversation"
      />
    </TooltipProvider>
  );
}

/** How many jobs this chat (and a project's workers) has running, on the button that opens the panel listing them. */
function RunningCount({ count, place }: { count: number; place: string }) {
  if (count === 0) return null;
  return (
    <span
      data-testid="running-jobs-count"
      aria-label={`${count} ${count === 1 ? 'job' : 'jobs'} running`}
      className={`absolute ${place} flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums leading-none text-bg`}
    >
      {count}
    </span>
  );
}
