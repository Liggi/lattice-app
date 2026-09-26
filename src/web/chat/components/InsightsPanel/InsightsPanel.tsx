/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { useState, useEffect, useCallback } from 'react';
import { Circle, Loader2, X, GitBranch, Check, RefreshCw, AlertTriangle, LocateFixed } from 'lucide-react';
import type { SessionInsights, Turn } from '../../types';
import { api } from '../../services/api';
import { useActivityStreamSubscription } from '../../contexts/ActivityStreamContext';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '../ui/tooltip';
import { useToast } from '../Toast/Toast';

/** Sync state for insights freshness */
export interface SyncState {
  lastUpdateTime: string | null;
}

/** Get seconds since a timestamp */
function getSecondsSince(timestamp: string | null | undefined): number {
  if (!timestamp) return 0;
  return Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
}

/** Format a timestamp as relative time, e.g. "10s ago", "2m ago" */
function formatRelativeTime(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;

  const diffSeconds = getSecondsSince(timestamp);

  if (diffSeconds < 5) return 'just now';
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getTurnOutcome(actions: string[]): string | null {
  const validActions = actions
    .filter(action => typeof action === 'string')
    .map(action => action.trim())
    .filter(action => action.length > 0 && action !== 'Details unavailable' && action !== 'Outcome unavailable');

  if (validActions.length === 0) {
    return null;
  }

  // Legacy turns may contain multiple entries; prefer the last item (usually the final outcome).
  return validActions[validActions.length - 1];
}

const mobileSafeAreaInsetsStyle: React.CSSProperties = {
  paddingTop: 'env(safe-area-inset-top, 0px)',
  paddingRight: 'env(safe-area-inset-right, 0px)',
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  paddingLeft: 'env(safe-area-inset-left, 0px)',
};

interface InsightsPanelProps {
  insights: SessionInsights | null;
  isLoading?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
  syncState?: SyncState;
  isPendingInsightsUpdate?: boolean;  // Show subtle indicator while waiting for insights patch
  sessionId?: string;  // For fetching turns
  onBranch?: (newSessionId: string) => void;  // Callback when user branches from a turn
  canBranch?: boolean;  // Provider contract may hide branching until history can be preserved
  onJumpToTurn?: (turn: Turn) => void | Promise<void>;  // Navigate to matching turn in message timeline
}

export function InsightsPanel({ insights, isLoading, isOpen, onClose, syncState, isPendingInsightsUpdate: _isPendingInsightsUpdate = false, sessionId, onBranch, canBranch = true, onJumpToTurn }: InsightsPanelProps): JSX.Element | null {
  const { showToast } = useToast();
  const [, setTick] = useState(0); // Force re-render for relative time updates
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());
  const [branchingTurn, setBranchingTurn] = useState<number | null>(null);
  const [branchSuccess, setBranchSuccess] = useState<number | null>(null);

  // API credit status — reactively updated via SSE
  const [creditsExhausted, setCreditsExhausted] = useState(false);
  const [creditCheckLoading, setCreditCheckLoading] = useState(false);

  const handleRetryCredits = useCallback(async () => {
    setCreditCheckLoading(true);
    try {
      const result = await api.checkAnthropicCredits();
      if (!result.creditsExhausted) {
        setCreditsExhausted(false);
        showToast({ title: 'Credits Restored', message: 'Insights will resume.', type: 'success', duration: 5000 });
      } else {
        showToast({ title: 'Still Exhausted', message: 'Credits are still insufficient.', type: 'error', duration: 3000 });
      }
    } catch {
      // Endpoint failed — leave state unchanged
    } finally {
      setCreditCheckLoading(false);
    }
  }, [showToast]);

  // Fetch turns when sessionId changes
  useEffect(() => {
    if (!sessionId) {
      setTurns([]);
      return;
    }

    setTurnsLoading(true);
    api.getSessionTurns(sessionId)
      .then(data => setTurns(data.turns || []))
      .catch(() => setTurns([]))
      .finally(() => setTurnsLoading(false));
  }, [sessionId]);

  // Subscribe to API health events (credit exhaustion / recovery)
  const handleApiHealth = useCallback((event: unknown) => {
    const data = event as { type?: string; creditsExhausted?: boolean };
    if (data.type === 'api-health' && typeof data.creditsExhausted === 'boolean') {
      setCreditsExhausted(data.creditsExhausted);
      if (data.creditsExhausted) {
        showToast({
          title: 'Anthropic API Credits Exhausted',
          message: 'Insights and analysis are paused until credits are added.',
          type: 'error',
          duration: 0,  // persistent
        });
      }
    }
  }, [showToast]);

  useActivityStreamSubscription({ type: 'activity' }, handleApiHealth);

  const toggleTurnExpanded = (id: string) => {
    setExpandedTurns(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Handle branching from a turn
  const handleBranch = useCallback(async (turnNumber: number, timestamp: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger row expansion
    if (!sessionId || branchingTurn !== null || branchSuccess !== null) return;

    setBranchingTurn(turnNumber);
    try {
      // Pass timestamp to correctly locate the turn in JSONL (handles DB/JSONL turn count mismatch)
      const result = await api.unifiedBranchConversation(sessionId, turnNumber, timestamp);
      if (result.success && onBranch) {
        // Show success state briefly before navigating
        setBranchingTurn(null);
        setBranchSuccess(turnNumber);
        setTimeout(() => {
          onBranch(result.conversationId ?? result.newSessionId);
        }, 500);
      }
    } catch (error) {
      console.error('Failed to branch session:', error);
      setBranchingTurn(null);
    }
  }, [sessionId, branchingTurn, branchSuccess, onBranch]);

  // Update relative time display periodically
  // Tick every second when under 1 minute, every 10 seconds after
  useEffect(() => {
    if (!syncState?.lastUpdateTime) return;

    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      const seconds = getSecondsSince(syncState.lastUpdateTime);
      const delay = seconds < 60 ? 1000 : 10_000;
      timeoutId = setTimeout(() => {
        setTick(t => t + 1);
        scheduleNext();
      }, delay);
    };

    scheduleNext();
    return () => clearTimeout(timeoutId);
  }, [syncState?.lastUpdateTime]);

  // Turn tags read as plain labels. Only 'friction' is a state worth a hue.
  const getTagColors = (tag: string): { text: string } => {
    switch (tag) {
      case 'friction':
        return { text: 'text-rose-300' };
      default:
        return { text: 'text-fg-3' };
    }
  };

  // Don't render if closed
  if (isOpen === false) {
    return null;
  }

  // Loading state
  if (isLoading && !insights) {
    return (
      <>
        {/* Mobile: Full-screen overlay */}
        <div
          className="md:hidden fixed inset-0 z-50 bg-bg overflow-y-auto"
          style={mobileSafeAreaInsetsStyle}
        >
          <div className="p-5">
            <div className="flex items-center gap-2 text-sm text-fg-3">
              <Loader2 size={14} className="animate-spin" />
              <span>Loading history...</span>
            </div>
          </div>
        </div>
        {/* Desktop: Sidebar */}
        <aside className="hidden md:block w-[360px] border-l border-line bg-bg flex-shrink-0 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-center gap-2 text-sm text-fg-3">
              <Loader2 size={14} className="animate-spin" />
              <span>Loading history...</span>
            </div>
          </div>
        </aside>
      </>
    );
  }

  // No insights yet — if credits are exhausted, explain why
  if (!insights) {
    if (creditsExhausted) {
      return (
        <>
          {/* Mobile */}
          <div
            className="md:hidden fixed inset-0 z-50 bg-bg overflow-y-auto"
            style={mobileSafeAreaInsetsStyle}
          >
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-medium text-fg-2">Insights</span>
                <button onClick={onClose} className="p-1 ui-icon-btn">
                  <X size={16} />
                </button>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-[rgb(var(--color-amber-rgb)/0.1)]">
                <AlertTriangle size={16} className="text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="text-[13px]">
                  <div className="font-medium text-amber-400">Anthropic API credits exhausted</div>
                  <div className="text-fg-2 mt-1">Insights and analysis are paused.</div>
                  <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener noreferrer"
                    className="text-accent mt-2 inline-block text-xs">
                    Add credits →
                  </a>
                </div>
              </div>
            </div>
          </div>
          {/* Desktop */}
          <aside className="hidden md:block w-[360px] border-l border-line bg-bg overflow-y-auto">
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-medium text-fg-2">Insights</span>
                <button onClick={onClose} className="p-1 ui-icon-btn">
                  <X size={16} />
                </button>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-[rgb(var(--color-amber-rgb)/0.1)]">
                <AlertTriangle size={16} className="text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="text-[13px]">
                  <div className="font-medium text-amber-400">Anthropic API credits exhausted</div>
                  <div className="text-fg-2 mt-1">Insights and analysis are paused.</div>
                  <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener noreferrer"
                    className="text-accent mt-2 inline-block text-xs">
                    Add credits →
                  </a>
                </div>
              </div>
            </div>
          </aside>
        </>
      );
    }

    return (
      <>
        {/* Mobile */}
        <div
          className="md:hidden fixed inset-0 z-50 bg-bg overflow-y-auto"
          style={mobileSafeAreaInsetsStyle}
        >
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-medium text-fg-2">History</span>
              <button onClick={onClose} className="p-1 ui-icon-btn">
                <X size={16} />
              </button>
            </div>
            <div className="flex items-center gap-2 text-[13px] text-fg-3 mt-8">
              <Circle size={6} className="text-fg-3 animate-pulse" />
              <span>History will appear as the session progresses.</span>
            </div>
          </div>
        </div>

        {/* Desktop */}
        <aside className="hidden md:block w-[360px] border-l border-line bg-bg flex-shrink-0 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-center gap-2 text-[13px] text-fg-3 mt-8">
              <Circle size={6} className="text-fg-3 animate-pulse" />
              <span>History will appear as the session progresses.</span>
            </div>
          </div>
        </aside>
      </>
    );
  }

  // Check what content we have available
  const hasHistory = turns.length > 0;
  const hasMission = !!insights?.context?.mission;

  // Shared panel content
  const panelContent = (
      <div className="p-5 space-y-6">
        {/* Credit exhaustion warning — visible at top when updates are paused */}
        {creditsExhausted && (
          <div className="flex items-start gap-2 p-2.5 rounded-md bg-[rgb(var(--color-amber-rgb)/0.1)] mb-3">
            <AlertTriangle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="text-[12px] flex-1">
              <span className="text-amber-400">API credits exhausted</span>
              <span className="text-fg-2"> — updates paused. </span>
              <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener noreferrer"
                className="text-accent">
                Add credits →
              </a>
            </div>
            <button
              onClick={handleRetryCredits}
              disabled={creditCheckLoading}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs text-fg-2 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
              title="Check if credits have been restored"
            >
              {creditCheckLoading
                ? <Loader2 size={10} className="animate-spin" />
                : <RefreshCw size={10} />
              }
              <span>Retry</span>
            </button>
          </div>
        )}

        {/* Section: History (Turns) - newest first */}
        {turns.length > 0 && (
          <div className="flex flex-col min-h-0 flex-1">
            <div className="text-xs font-medium text-fg-2 mb-3">
              History
              {turnsLoading && <Loader2 size={10} className="inline ml-2 animate-spin" />}
            </div>

            <div className="space-y-0 overflow-y-auto flex-1 min-h-0">
              {[...turns].reverse().map((turn, i, arr) => {
                // Clean tag: strip trailing emoji that Haiku sometimes includes (e.g., "explore 🔍" → "explore")
                // Include Variation_Selector for compound emojis like 🏗️ (U+1F3D7 + U+FE0F)
                // If tag is emoji-only or empty after cleaning, fall back to "action"
                const strippedTag = turn.tag.replace(/[\p{Extended_Pictographic}\p{Variation_Selector}\s]+/gu, '').trim();
                const cleanTag = strippedTag || 'action';
                const tagColors = getTagColors(cleanTag);
                const expanded = expandedTurns.has(turn.id);
                const turnOutcome = getTurnOutcome(turn.actions);
                const hasOutcome = !!turnOutcome;

                return (
                  <div key={turn.id} data-testid={`turn-${turn.turnNumber}`}>
                    <div className="py-2">
                      <div className="group relative">
                        <button
                          onClick={() => toggleTurnExpanded(turn.id)}
                          className="w-full text-left flex items-start gap-2 cursor-pointer rounded-md px-2 -mx-2 py-1.5 -my-1.5 hover:bg-surface transition-colors"
                        >
                          {/* Left: icon + tag stacked */}
                          <div className="flex flex-col items-center w-14 flex-shrink-0 overflow-visible">
                            <span className="text-sm">{turn.icon}</span>
                            <span className={`text-[11px] ${tagColors.text} mt-0.5`}>{cleanTag}</span>
                          </div>

                          {/* Right: content */}
                          <div className="flex-1 min-w-0 pr-16">
                            <div className={`text-[13px] text-fg leading-snug ${expanded ? '' : 'line-clamp-2'}`}>
                              {turn.headline}
                            </div>
                            <div className="text-xs text-fg-3 mt-1">
                              {formatRelativeTime(turn.timestamp)}
                              {turn.toolCount > 0 && ` · ${turn.toolCount} tools`}
                              {hasOutcome && !expanded && ' · outcome'}
                            </div>
                          </div>
                        </button>

                        {/* Turn action buttons - appear on hover */}
                        {(onJumpToTurn || onBranch) && (
                          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                            {onJumpToTurn && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void onJumpToTurn(turn);
                                      }}
                                      className="p-1.5 rounded-md opacity-0 group-hover:opacity-100
                                        transition-colors duration-100 cursor-pointer text-fg-3
                                        hover:text-fg hover:bg-surface-2"
                                      aria-label={`Go to turn ${turn.turnNumber}`}
                                    >
                                      <LocateFixed size={14} />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="left">
                                    <p>Jump to this point in the conversation</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}

                            {onBranch && canBranch && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      onClick={(e) => handleBranch(turn.turnNumber, turn.timestamp, e)}
                                      disabled={branchingTurn !== null || branchSuccess !== null}
                                      className={`p-1.5 rounded-md transition-colors duration-100 cursor-pointer
                                        ${branchSuccess === turn.turnNumber
                                          ? 'opacity-100 text-emerald-400 bg-[rgb(var(--color-emerald-rgb)/0.1)]'
                                          : 'opacity-0 group-hover:opacity-100 text-fg-3 hover:text-fg hover:bg-surface-2'
                                        }
                                        disabled:cursor-not-allowed`}
                                      aria-label={`Branch from turn ${turn.turnNumber}`}
                                    >
                                      {branchingTurn === turn.turnNumber ? (
                                        <Loader2 size={14} className="animate-spin" />
                                      ) : branchSuccess === turn.turnNumber ? (
                                        <Check size={14} />
                                      ) : (
                                        <GitBranch size={14} />
                                      )}
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="left">
                                    <p>{branchSuccess === turn.turnNumber ? 'Branched!' : 'Start a new direction from this point — original history is preserved'}</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Expanded: single outcome summary */}
                      {expanded && (
                        <div className="mt-3 space-y-1.5">
                          <div className="text-xs font-medium text-fg-2 px-1">Outcome</div>
                          <div className="w-full bg-surface rounded-lg px-3 py-2.5 text-[13px] text-fg leading-relaxed">
                            {turnOutcome ?? 'Outcome unavailable'}
                          </div>
                        </div>
                      )}
                    </div>
                    {i < arr.length - 1 && (
                      <div className="border-t border-line" />
                    )}
                  </div>
                );
              })}

            </div>
          </div>
        )}

        {/* Empty state: insights exist but no history yet */}
        {!hasHistory && hasMission && (
          <div className="flex flex-col gap-4">
            <div className="text-xs font-medium text-fg-2">
              Mission
            </div>
            <div className="text-sm text-fg leading-relaxed">
              {insights.context?.mission}
            </div>
            <div className="flex items-center gap-2 text-xs text-fg-3 mt-2">
              <Circle size={6} className="text-fg-3 animate-pulse" />
              <span>History will appear as the session progresses</span>
            </div>
          </div>
        )}
      </div>
  );

  return (
    <>
      {/* Mobile: Full-screen overlay */}
      <div
        className="md:hidden fixed inset-0 z-50 bg-bg flex flex-col"
        style={mobileSafeAreaInsetsStyle}
      >
        {/* Header with close button */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line flex-shrink-0">
          <span className="text-xs font-medium text-fg-2">Session history</span>
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 -m-2 text-fg-2 hover:text-fg transition-colors"
              aria-label="Close history"
            >
              <X size={20} />
            </button>
          )}
        </div>
        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {panelContent}
        </div>
      </div>

      {/* Desktop: Sidebar */}
      <aside data-testid="insights-panel" className="hidden md:flex md:flex-col w-[360px] border-l border-line bg-bg flex-shrink-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto scrollbar-auto-hide">
          {panelContent}
        </div>
      </aside>
    </>
  );
}
