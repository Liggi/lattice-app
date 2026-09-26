/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
/**
 * SessionCard - one row in the sidebar's session list.
 *
 * State icon (what the session is doing, in words on hover), title, and one
 * line about where the session stands.
 */

import React from 'react';
import { Tooltip, TooltipContentPlain, TooltipTrigger } from '../ui/tooltip';
import { useSessionAttention } from '../../hooks/useAttentionFavicon';
import type { UnifiedConversationSummary } from '../../types';
import { useConversations } from '../../contexts/ConversationsContext';
import { deriveSessionActivity, describeSessionActivity } from '../../utils/session-activity';
import { SessionStateIcon } from './session-state-icon/SessionStateIcon';
import { SessionStateTooltip } from './session-state-icon/SessionStateTooltip';
import type { TeamRuntimeStatus } from '../../hooks/useTeamStatus';
import { lastUsedAt } from '../../utils/sidebar-ordering';
import type { AmbientRead } from '../AmbientPortfolio/ambient-types';
import { ARROW_PRESENTATION, resolveCardOrientation, resolveCardTitle } from './session-card-orientation';

// ============================================================================
// HELPERS
// ============================================================================

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);

  if (diffSecs < 10) return 'now';
  if (diffSecs < 60) return `${diffSecs}s`;
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export interface SessionCardProps {
  conversation: UnifiedConversationSummary;
  teamStatus?: TeamRuntimeStatus;
  isCurrent?: boolean;
  onClick?: () => void;
  /** @deprecated No longer rendered — kept for caller compatibility */
  recentActions?: unknown[];
  /** Transient badge: session just completed (auto-clears) */
  recentlyCompleted?: boolean;
  /** Optional sidebar action to rename session manually */
  onRenameSessionName?: (conversation: UnifiedConversationSummary, nextName: string) => Promise<void> | void;
  /** Optional loading state for rename action */
  isRenamingSessionName?: boolean;
  /**
   * Argus's latest read for this session, when the ambient scan has one.
   * Supplies the stable purpose and relationship line; absence is normal.
   */
  ambientRead?: AmbientRead | null;
  /**
   * When the reader last sent into this session, from `user-send-marks`. A
   * send newer than the read's boundary clears a reply-shaped arrow it answered.
   */
  userSentAt?: number | null;
}

export function SessionCard({
  conversation,
  teamStatus: _teamStatus,
  isCurrent,
  onClick,
  recentlyCompleted: _recentlyCompleted = false,
  onRenameSessionName,
  isRenamingSessionName = false,
  ambientRead,
  userSentAt,
}: SessionCardProps): JSX.Element {
  const needsAttention = useSessionAttention(conversation.conversationId);
  const insights = conversation.insights;

  // Two-tier identity:
  // - mission: frozen at session start (what it was meant to do)
  // - purpose: current focus (evolves on pivots) - only show if different from mission
  // - initialPromptPreview: first user message (preview) (shown for free users who don't have AI-generated mission)
  const mission = insights?.context?.mission || insights?.purpose || conversation.initialPromptPreview || 'New session';
  const customName = conversation.customName?.trim() || '';
  // The card carries one description, not two. Argus's read is the clearest
  // account of what the session exists to accomplish, so it becomes the title
  // rather than sitting in a second block restating the frozen mission.
  const orientation = resolveCardOrientation({ ambientRead, mission, userSentAt });
  const sessionName = resolveCardTitle({
    customName,
    projectName: conversation.projectName,
    description: orientation.description,
    conversationId: conversation.conversationId,
  });
  // When showing raw user prompt (no AI mission, no custom name), clamp to 1 line
  const isShowingRawPrompt = !customName && !insights?.context?.mission && !insights?.purpose && !!conversation.initialPromptPreview;
  const arrowPresentation = orientation.arrow && orientation.arrow.kind !== 'nothing-pending'
    ? ARROW_PRESENTATION[orientation.arrow.kind]
    : null;
  const [isInlineRenaming, setIsInlineRenaming] = React.useState(false);
  const [renameDraft, setRenameDraft] = React.useState(sessionName);
  const renameDraftRef = React.useRef(renameDraft);
  renameDraftRef.current = renameDraft;
  const renameInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const wasRenameBusyRef = React.useRef(isRenamingSessionName);
  const renameCommitInFlightRef = React.useRef(false);

  const autosizeRenameInput = React.useCallback(() => {
    const textarea = renameInputRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    const minHeight = 42;
    const maxHeight = 128;
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
  }, []);

  React.useEffect(() => {
    if (!isInlineRenaming) {
      setRenameDraft(sessionName);
    }
  }, [isInlineRenaming, sessionName]);

  React.useEffect(() => {
    if (!isInlineRenaming || !renameInputRef.current) return;
    renameInputRef.current.focus();
    renameInputRef.current.select();
    autosizeRenameInput();
  }, [autosizeRenameInput, isInlineRenaming]);

  React.useEffect(() => {
    if (!isInlineRenaming) return;
    autosizeRenameInput();
  }, [autosizeRenameInput, isInlineRenaming, renameDraft]);

  React.useEffect(() => {
    if (wasRenameBusyRef.current && !isRenamingSessionName && isInlineRenaming) {
      setIsInlineRenaming(false);
    }
    wasRenameBusyRef.current = isRenamingSessionName;
  }, [isInlineRenaming, isRenamingSessionName]);

  const commitInlineRename = React.useCallback(async () => {
    if (!onRenameSessionName || isRenamingSessionName || renameCommitInFlightRef.current) return;
    // Read from ref to avoid stale closure over renameDraft
    const trimmed = renameDraftRef.current.trim();
    if (!trimmed) {
      setRenameDraft(sessionName);
      setIsInlineRenaming(false);
      return;
    }
    if (trimmed === sessionName) {
      setIsInlineRenaming(false);
      return;
    }
    renameCommitInFlightRef.current = true;
    // Close the inline editor immediately so user sees the new text
    setIsInlineRenaming(false);
    try {
      await onRenameSessionName(conversation, trimmed);
    } catch {
      // Parent handler logs/presents errors.
    } finally {
      renameCommitInFlightRef.current = false;
    }
  }, [conversation, onRenameSessionName, sessionName, isRenamingSessionName]);

  const { conversations } = useConversations();
  const activity = deriveSessionActivity(conversation, conversations, needsAttention);
  const activityLabel = describeSessionActivity(activity, conversation);
  const iconState = activity.kind === 'working' ? { kind: activity.kind, level: activity.level }
    : activity.kind === 'needs-you' ? { kind: activity.kind, strength: activity.strength }
    : { kind: activity.kind };
  // Phones have no hover, so a tap on the icon toggles its card instead of
  // opening the session; a tap anywhere else, or a scroll, closes it. The card
  // is fully controlled: hover on desktop reaches it through onOpenChange.
  const [iconTipOpen, setIconTipOpen] = React.useState(false);
  const iconTestId = `session-image-${conversation.conversationId}`;
  React.useEffect(() => {
    if (!iconTipOpen) return;
    const close = () => setIconTipOpen(false);
    document.addEventListener('scroll', close, true);
    return () => document.removeEventListener('scroll', close, true);
  }, [iconTipOpen]);
  // Radix closes an open card on a pointerdown on its trigger; on touch the
  // click below decides instead, so a second tap on the icon closes it.
  const handleIconPointerDown = React.useCallback((event: React.PointerEvent) => {
    if (event.pointerType === 'touch') event.preventDefault();
  }, []);
  const ignoreIconTap = React.useCallback((event: Event) => {
    if ((event.target as Element | null)?.closest?.(`[data-testid="${iconTestId}"]`)) event.preventDefault();
  }, [iconTestId]);
  const handleIconClick = React.useCallback((event: React.MouseEvent) => {
    if (!window.matchMedia('(hover: none)').matches) return;
    event.preventDefault();
    event.stopPropagation();
    setIconTipOpen(open => !open);
  }, []);

  // Staleness: cards quietly recede as they age. Fade starts at 6h, floors at
  // 60% by ~48h. Current/attention cards never fade.
  //
  // Age comes from lastUsedAt (newest harness event), not updatedAt. updatedAt
  // only moves on the legacy /resume route and on segment changes, so a session
  // worked in this afternoon can carry a timestamp from yesterday — which was
  // fading live sessions out.
  const lastActivityTs = lastUsedAt(conversation);
  const staleHours = Math.max(0, (Date.now() - lastActivityTs) / 3_600_000);
  const staleOpacity = isCurrent || activity.kind === 'needs-you'
    ? 1
    : Math.max(0.6, 1 - Math.max(0, staleHours - 6) * (0.4 / 42));
  const staleAgeLabel = staleHours >= 6 ? formatRelativeTime(lastActivityTs) : null;
  const isCardInteractive = Boolean(!isInlineRenaming && onClick);
  const handleCardKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isCardInteractive || !onClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  }, [isCardInteractive, onClick]);

  const asksForYou = needsAttention || orientation.arrow?.kind === 'your-move';

  // One line under the title: a status block wins over the arrow, and both are
  // the same quiet second line rather than a panel nested inside the row.
  const statusLine: { label: string; text: string; labelClassName: string } | null = conversation.importedAt
    ? { label: 'Read-only', text: 'Imported session', labelClassName: 'text-fg-2' }
    : conversation.pausedReason
      ? { label: 'Paused', text: conversation.pausedReason, labelClassName: 'text-fg-2' }
      : orientation.arrow && arrowPresentation
        ? { label: arrowPresentation.label, text: orientation.arrow.text, labelClassName: arrowPresentation.labelClassName }
        : null;

  return (
    <div
      data-testid={`session-${conversation.conversationId}`}
      className={`group relative flex items-start gap-2.5 px-2 py-1.5 rounded-sm cursor-pointer transition-colors ${
        isCurrent ? 'bg-surface' : 'hover:bg-surface-2'
      }`}
      style={{ opacity: staleOpacity }}
      onClick={isCardInteractive ? onClick : undefined}
      onKeyDown={isCardInteractive ? handleCardKeyDown : undefined}
      role="button"
      tabIndex={isCardInteractive ? 0 : -1}
    >
      <Tooltip delayDuration={0} open={iconTipOpen} onOpenChange={setIconTipOpen}>
        <TooltipTrigger asChild>
          <span
            data-testid={iconTestId}
            data-activity={activity.kind}
            aria-label={activityLabel}
            onPointerDown={handleIconPointerDown}
            onClick={handleIconClick}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] ${isCurrent ? 'text-fg-2' : 'text-fg-3'}`}
          >
            <SessionStateIcon state={iconState} variant={conversation.coordinator ? 'project' : 'session'} />
          </span>
        </TooltipTrigger>
        <TooltipContentPlain side="bottom" align="start" alignOffset={-4} collisionPadding={8} className="p-0" onPointerDownOutside={ignoreIconTap}>
          <SessionStateTooltip activity={activity} conversation={conversation} conversations={conversations} />
        </TooltipContentPlain>
      </Tooltip>

      {/* Text column is at least the tile's height and centres within it, so a
          one-line name sits level with the icon; longer content grows past it
          and the tile stays with the first line. */}
      <div className="flex min-h-7 min-w-0 flex-1 flex-col justify-center">
        <div className="flex items-baseline gap-2">
          <div className="min-w-0 flex-1">
            {isInlineRenaming ? (
              <textarea
                ref={renameInputRef}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void commitInlineRename();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setRenameDraft(sessionName);
                    setIsInlineRenaming(false);
                  }
                }}
                onBlur={() => {
                  void commitInlineRename();
                }}
                disabled={isRenamingSessionName}
                rows={2}
                className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1 text-sm leading-snug text-fg focus:outline-none focus:border-accent resize-none overflow-y-auto"
                placeholder="Session name"
                aria-label="Session name"
              />
            ) : (
              <div
                data-testid={`session-mission-${conversation.conversationId}`}
                // Rename lost its button when the strip narrowed to pin and
                // archive. Double-clicking the name still opens the editor, so
                // the capability survives without spending a slot on it.
                onDoubleClick={onRenameSessionName ? (event) => {
                  event.stopPropagation();
                  setRenameDraft(sessionName);
                  setIsInlineRenaming(true);
                } : undefined}
                title={onRenameSessionName ? 'Double-click to rename' : undefined}
                className={`text-sm leading-snug ${isCurrent ? 'text-fg' : 'text-fg-2'} ${isShowingRawPrompt ? 'line-clamp-1' : 'line-clamp-2'}`}
              >
                {sessionName}
              </div>
            )}
          </div>
          {staleAgeLabel && !isInlineRenaming && (
            <span className="shrink-0 text-xs text-fg-3 tabular-nums">{staleAgeLabel}</span>
          )}
        </div>

        {statusLine && (
          <div className="mt-0.5 flex items-baseline gap-1.5 text-[12.5px] leading-[1.35]">
            <span className={`shrink-0 font-medium ${statusLine.labelClassName}`}>{statusLine.label}</span>
            <span className={`truncate ${isCurrent || asksForYou ? 'text-fg-2' : 'text-fg-3'}`}>{statusLine.text}</span>
          </div>
        )}
      </div>

    </div>
  );
}
