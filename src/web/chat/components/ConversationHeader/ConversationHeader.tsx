/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import { type JSX, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Moon, ArrowLeft, PanelRight, PanelLeft, Menu, X, Settings, Import, MessageSquare } from 'lucide-react';
import { useLiveJobs } from '../ConversationView/RunningJobsStrip';
import { LatticeLogo } from '../shared/LatticeLogo';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/web/chat/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/web/chat/components/ui/popover';
import { useConversations } from '../../contexts/ConversationsContext';
import { SettingsDialog } from '../SettingsDialog/SettingsDialog';
import { planSignInWaiting } from '../SettingsDialog/ChatGPTPlanCard';
import { archivedSidebarQueryKey } from '../../hooks/useArchivedSidebarSessions';
import { removeConversationFromListCache, type ConversationListCacheData } from '../../utils/conversation-list-cache';
import { useToast } from '../Toast/Toast';
import { FeedbackDialog } from '../Feedback/FeedbackDialog';
import { noteViewing, offerUndo, runUndo, undoShowsOn, usePendingUndo } from './pending-undo';
import { UndoButton } from './UndoButton';

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
  insightsPanelOpen,
  onToggleInsightsPanel,
  crossSessionSidebarOpen,
  onToggleCrossSessionSidebar,
}: ConversationHeaderProps): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { conversations, invalidateConversations } = useConversations();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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

  return (
    <TooltipProvider>
      {/* Full-width band with a hairline under it; the thread and the side panel both start beneath it. */}
      <div className="relative flex justify-between items-center gap-3 h-[52px] pl-4 pr-4 bg-bg border-b border-line flex-shrink-0">
        {/* Left: the sessions sidebar, then Back on a worker. On desktop the
            brand follows the toggle; on mobile it is centred on the viewport
            (below), so it cannot sit in this group. */}
        <div className="flex items-center gap-1 sm:gap-2.5">
          {onToggleCrossSessionSidebar && (
            <button
              type="button"
              onClick={onToggleCrossSessionSidebar}
              aria-label={crossSessionSidebarOpen ? 'Close sessions sidebar' : 'Open sessions sidebar'}
              aria-pressed={Boolean(crossSessionSidebarOpen)}
              className="flex sm:hidden items-center justify-center w-10 h-10 ui-icon-btn touch-manipulation"
            >
              <PanelLeft size={20} />
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
              <span className="hidden sm:flex items-center gap-2" aria-label="Lattice">
                <LatticeLogo size={24} interactive={true} colorScheme="gradient" />
                <span className="wordmark text-[15px] text-white">lattice</span>
              </span>
            </>
          )}
          {projectId && (
            <button
              type="button"
              data-testid="back-to-project"
              onClick={() => navigate(`/c/${projectId}`)}
              aria-label="Back to project"
              /* Mobile drops the word and keeps a full tap target, so the
                 centred brand has the middle of the band to itself. */
              className="flex items-center justify-center sm:justify-start gap-1 w-10 h-10 sm:w-auto sm:h-auto text-xs text-fg-2 hover:text-fg cursor-pointer touch-manipulation"
            >
              <ArrowLeft className="size-[18px] sm:size-[13px] flex-shrink-0" />
              <span className="hidden sm:inline">Back</span>
            </button>
          )}
        </div>

        {/* Mobile brand: positioned against the band, which spans the viewport
            here, so it stays centred on the screen however many controls sit
            on either side of it. Not a click target — the sidebar toggle is. */}
        <span
          className="sm:hidden absolute left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-none"
          aria-label="Lattice"
        >
          <LatticeLogo size={22} interactive={false} colorScheme="gradient" />
          <span className="wordmark text-[15px] text-white">lattice</span>
        </span>

        <div className="flex-1 min-w-0" />

        {/* Right: icon actions with tooltips */}
        <div className="hidden sm:flex items-center gap-0.5 flex-shrink-0">
          {isImported && (
            <span className="flex items-center gap-1.5 mr-2 text-xs text-fg-2">
              <Import size={13} />
              Imported · read-only
            </span>
          )}
          {undoSleep ? (
            <UndoButton pending={undoSleep} onUndo={undoNow} variant="icon" />
          ) : canSleep && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => void handleSleep()}
                  aria-label={isSlept ? 'Wake' : 'Sleep'}
                  aria-pressed={isSlept}
                  className={`${iconBtn} ${isSlept ? 'text-fg bg-surface' : ''}`}
                  data-testid="session-sleep"
                >
                  <Moon size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent>{isSlept ? 'Wake' : 'Sleep'}</TooltipContent>
            </Tooltip>
          )}
          {undoArchive ? (
            <UndoButton pending={undoArchive} onUndo={undoNow} variant="icon" />
          ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleArchive}
                disabled={!sessionId}
                aria-label={isArchived ? "Unarchive Task" : "Archive Task"}
                className={iconBtn}
              >
                <Archive size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{isArchived ? 'Restore' : 'Archive'}</TooltipContent>
          </Tooltip>
          )}

          {/* Same panel icon as the sidebar's toggle, held open-styled while the panel shows */}
          {onToggleInsightsPanel && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onToggleInsightsPanel}
                  aria-label={insightsPanelOpen ? "Hide panel" : "Show panel"}
                  aria-pressed={Boolean(insightsPanelOpen)}
                  className={`relative ${iconBtn} ${insightsPanelOpen ? 'text-fg bg-surface' : ''}`}
                >
                  <PanelRight size={16} />
                  {!insightsPanelOpen && <RunningCount count={runningJobs.length} place="-right-1.5 -top-1.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{insightsPanelOpen ? 'Hide panel' : 'Show panel'}</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setFeedbackOpen(true)}
                disabled={!sessionId}
                aria-label="Send feedback about this session"
                className={iconBtn}
                data-testid="session-feedback"
              >
                <MessageSquare size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Send feedback about this session</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setSettingsOpen(true)}
                aria-label="Settings"
                className={iconBtn}
              >
                <Settings size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>

        {/* Mobile controls - shown below sm breakpoint: the menu, then the
            right panel at the far right. A session with no right panel (a
            worker) shows no panel control, exactly as on desktop. */}
        <div className="flex items-center gap-1 sm:hidden">
          {/* The menu closes when Sleep or Archive is tapped, so Undo takes
              the menu button's place until its time runs out. */}
          {undoHere ? (
            <UndoButton pending={undoHere} onUndo={undoNow} variant="menu" />
          ) : (
          <Popover
            open={mobileMenuOpen}
            onOpenChange={setMobileMenuOpen}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex items-center justify-center w-10 h-10 ui-icon-btn touch-manipulation"
                aria-label="Menu"
              >
                {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              className="w-52 p-1.5 bg-surface border border-line rounded-lg shadow-none z-[100]"
            >
              <div className="flex flex-col gap-px">
                {isImported && (
                  <div className="flex items-center gap-3 px-3 py-2 text-sm text-fg-2">
                    <Import size={16} />
                    <span>Imported · read-only</span>
                  </div>
                )}
                {canSleep && (
                  <button
                    onClick={() => {
                      void handleSleep();
                      setMobileMenuOpen(false);
                    }}
                    className={menuItem}
                  >
                    <Moon size={16} />
                    <span>{isSlept ? 'Wake' : 'Sleep'}</span>
                  </button>
                )}
                <button
                  onClick={() => {
                    void handleArchive();
                    setMobileMenuOpen(false);
                  }}
                  disabled={!sessionId}
                  className={menuItem}
                >
                  <Archive size={16} />
                  <span>{isArchived ? 'Restore' : 'Archive'}</span>
                </button>

                <button
                  onClick={() => {
                    setFeedbackOpen(true);
                    setMobileMenuOpen(false);
                  }}
                  disabled={!sessionId}
                  className={menuItem}
                >
                  <MessageSquare size={16} />
                  <span>Send feedback</span>
                </button>

                <div className="border-t border-line my-1" />

                <button
                  onClick={() => {
                    setSettingsOpen(true);
                    setMobileMenuOpen(false);
                  }}
                  className={menuItem}
                >
                  <Settings size={16} />
                  <span>Settings</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>
          )}
          {onToggleInsightsPanel && (
            <button
              type="button"
              onClick={onToggleInsightsPanel}
              aria-label={insightsPanelOpen ? 'Hide panel' : 'Show panel'}
              aria-pressed={Boolean(insightsPanelOpen)}
              className={`relative flex items-center justify-center w-10 h-10 ui-icon-btn touch-manipulation ${insightsPanelOpen ? 'text-fg bg-surface' : ''}`}
            >
              <PanelRight size={20} />
              {!insightsPanelOpen && <RunningCount count={runningJobs.length} place="right-0.5 top-0.5" />}
            </button>
          )}
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
