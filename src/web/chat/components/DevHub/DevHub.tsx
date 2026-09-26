/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Beaker,
  RefreshCw,
  Layers,
  ChevronRight,
  ArrowLeft,
  Archive,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import { api } from '../../services/api';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import type { UnifiedConversationSummary } from '../../types';

/**
 * DevHub - Developer discovery page for prototypes and archived sessions
 *
 * Flat house vocabulary: `bg-surface` cards on `bg-bg`, hairline borders,
 * Geist throughout, colour reserved for state.
 */

// Static list of prototypes with creation dates (from git history)
// Sorted by most recent first
const PROTOTYPES = [
  // Mar 7, 2026 - New session empty state treatments
  { path: '/prototype/new-session-empty-state', name: 'New Session Empty State', category: 'ui', created: '2026-03-07' },
  // Mar 7, 2026 - New session controls layout exploration
  { path: '/prototype/new-session-controls', name: 'New Session Controls', category: 'ui', created: '2026-03-07' },
  // Mar 7, 2026 - Session card density exploration
  { path: '/prototype/session-card-density', name: 'Session Card Density', category: 'ui', created: '2026-03-07' },

  // Feb 11, 2026 - Composer status/input rework exploration
  { path: '/prototype/composer-status-input', name: 'Composer Status + Input', category: 'ui', created: '2026-02-11' },

  // Feb 10, 2026 - New Session UI exploration
  { path: '/prototype/new-session-variants', name: 'New Session Variants', category: 'ui', created: '2026-02-10' },

  // Feb 9, 2026 - Action Queue (unified dev notes + recommendations)
  { path: '/prototype/action-queue', name: 'Action Queue', category: 'ui', created: '2026-02-09' },

  // Feb 7, 2026
  { path: '/prototype/ask-question-variants', name: 'Ask Question Variants', category: 'ui', created: '2026-02-07' },
  { path: '/prototype/session-card-title', name: 'Session Card Title', category: 'ui', created: '2026-02-07' },
  { path: '/prototype/recommendation-cards', name: 'Recommendation Cards', category: 'ui', created: '2026-02-07' },
  { path: '/prototype/geist-pixel', name: 'Geist Pixel', category: 'ui', created: '2026-02-07' },

  // Feb 6, 2026
  { path: '/prototype/session-skeleton-variants', name: 'Session Skeleton Variants', category: 'ui', created: '2026-02-06' },

  // Jan 27, 2026 - Brand typography exploration
  { path: '/prototype/font-showcase', name: 'Font Gallery', category: 'banner', created: '2026-01-27' },
  { path: '/prototype/session-sidebar', name: 'Session Sidebar Variations', category: 'ui', created: '2026-01-27' },

  // Jan 25, 2026
  { path: '/prototype/timeline-card', name: 'Timeline Cards', category: 'ui', created: '2026-01-25' },
  { path: '/prototype/archived-card', name: 'Archived Cards', category: 'ui', created: '2026-01-25' },

  // Jan 24, 2026 - SmartMenu redesign
  { path: '/prototype/toolbar', name: 'Toolbar', category: 'ui', created: '2026-01-24' },
  { path: '/prototype/menu-styles', name: 'Menu Styles', category: 'ui', created: '2026-01-24' },
  { path: '/prototype/smart-menu', name: 'Smart Menu', category: 'ui', created: '2026-01-24' },

  // Jan 21, 2026
  { path: '/prototype/mark-button', name: 'Mark Button', category: 'ui', created: '2026-01-21' },

  // Jan 18, 2026
  { path: '/prototype/session-start', name: 'Session Start', category: 'ui', created: '2026-01-18' },
  { path: '/prototype/permissions', name: 'Permissions', category: 'ui', created: '2026-01-18' },
  { path: '/prototype/styles', name: 'Style Gallery', category: 'banner', created: '2026-01-18' },
  { path: '/prototype/session-cards', name: 'Session Cards', category: 'banner', created: '2026-01-18' },
  { path: '/prototype/semantic', name: 'Semantic Gallery', category: 'banner', created: '2026-01-18' },
  { path: '/prototype/pipeline', name: 'Pipeline Gallery', category: 'banner', created: '2026-01-18' },
  { path: '/prototype/geometric', name: 'Geometric Gallery', category: 'banner', created: '2026-01-18' },
  { path: '/prototype/banners', name: 'Banners', category: 'banner', created: '2026-01-18' },
  { path: '/prototype/gallery', name: 'Banner Gallery', category: 'banner', created: '2026-01-18' },
  { path: '/prototype/permission-patterns', name: 'Permission Patterns', category: 'ui', created: '2026-01-18' },
];

// Category styling — the icon carries the distinction, not a hue.
const CATEGORY_CONFIG: Record<string, {
  label: string;
  icon: React.ReactNode;
  textColor: string;
  borderColor: string;
}> = {
  banner: {
    label: 'Banner / identity',
    icon: <Layers size={14} />,
    textColor: 'text-fg',
    borderColor: 'border-line',
  },
  ui: {
    label: 'UI components',
    icon: <Beaker size={14} />,
    textColor: 'text-fg',
    borderColor: 'border-line',
  },
};

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}


function TimelineCard({
  session,
  onRestore,
}: {
  session: UnifiedConversationSummary;
  onRestore: () => void;
}) {
  const { insights, updatedAt, conversationId, customName, identityImage } = session;

  // Get display name: custom name > purpose > truncated conversation ID
  const displayName = customName || insights?.context?.mission || insights?.purpose || conversationId.slice(0, 8);

  return (
    <div className="flex gap-3 group">
      {/* Timeline spine */}
      <div className="flex flex-col items-center flex-shrink-0 pt-2">
        <div className="w-2.5 h-2.5 rounded-full bg-surface-2 border-2 border-line-2 group-hover:bg-fg-3 group-hover:border-fg-3 transition-colors" />
        <div className="w-px flex-1 bg-line mt-1" />
      </div>

      {/* Card - matches sidebar treatment */}
      <div className="flex-1 pb-4 min-w-0">
        <div className="rounded-lg border border-line bg-surface overflow-hidden hover:border-line-2 transition-colors">
          {/* Banner image - full width like sidebar */}
          {identityImage ? (
            <div
              className="w-full h-16"
              style={{
                backgroundImage: `url(data:image/png;base64,${identityImage})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
          ) : (
            <div className="w-full h-16 bg-surface-2" />
          )}

          {/* Content below banner */}
          <div className="p-2.5 space-y-2">
            {/* Status row with tags - matches sidebar layout */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-fg-3">
                {formatRelativeTime(updatedAt)}
              </span>

              {/* Tags inline - matching sidebar's tag treatment */}
              <div className="flex flex-wrap gap-1 ml-auto">
                {insights?.context?.scope && (
                  <span className="text-xs px-1.5 py-0.5 rounded-sm font-medium bg-surface-2 text-fg-2">
                    {insights.context.scope}
                  </span>
                )}
                {insights?.theme && (
                  <span className="text-xs px-1.5 py-0.5 rounded-sm font-medium bg-surface-2 text-fg-2">
                    {insights.theme}
                  </span>
                )}
                {insights?.tags?.complexity && insights.tags.complexity !== 'routine' && (
                  <span className="text-xs px-1.5 py-0.5 rounded-sm font-medium bg-surface-2 text-fg-2">
                    {insights.tags.complexity}
                  </span>
                )}
              </div>
            </div>

            {/* Mission panel - matching sidebar's LabeledPanel style */}
            <div className="border border-line rounded-lg p-3 bg-bg">
              <div className="text-xs font-medium text-fg-2 mb-2 flex items-center gap-1.5">
                Mission
              </div>
              <div className="text-xs leading-relaxed text-fg-2 line-clamp-2">
                {displayName}
              </div>
            </div>

            {/* Restore button - right aligned */}
            <div className="flex justify-end">
              <button
                onClick={onRestore}
                className="ui-action-btn flex items-center gap-1.5 px-3 py-1.5 text-[13px] cursor-pointer"
              >
                <RotateCcw size={12} />
                <span>Restore</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatPrototypeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Get the Monday of the week containing the given date */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0, Sunday = 6
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Format a week label relative to now */
function formatWeekLabel(weekStart: Date): string {
  const now = new Date();
  const currentWeekStart = getWeekStart(now);
  const diffWeeks = Math.round((currentWeekStart.getTime() - weekStart.getTime()) / (7 * 24 * 60 * 60 * 1000));

  if (diffWeeks === 0) return 'This Week';
  if (diffWeeks === 1) return 'Last Week';

  // Check if same month as current week start
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  // Use "Week of Mon DD" for older weeks
  return `Week of ${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

type PrototypeEntry = typeof PROTOTYPES[0];
interface WeekGroup {
  label: string;
  weekStart: Date;
  prototypes: PrototypeEntry[];
}

/** Group prototypes by week, newest first */
function groupPrototypesByWeek(prototypes: PrototypeEntry[]): WeekGroup[] {
  const groups = new Map<string, WeekGroup>();

  for (const p of prototypes) {
    const date = new Date(p.created);
    const weekStart = getWeekStart(date);
    const key = weekStart.toISOString();

    if (!groups.has(key)) {
      groups.set(key, {
        label: formatWeekLabel(weekStart),
        weekStart,
        prototypes: [],
      });
    }
    groups.get(key)!.prototypes.push(p);
  }

  // Sort groups newest first, prototypes within each group newest first
  return Array.from(groups.values())
    .sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime())
    .map(group => ({
      ...group,
      prototypes: group.prototypes.sort(
        (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()
      ),
    }));
}

function PrototypeCard({ prototype, categoryConfig }: {
  prototype: typeof PROTOTYPES[0];
  categoryConfig: typeof CATEGORY_CONFIG[string];
}) {
  return (
    <Link
      to={prototype.path}
      className={`
        flex items-center gap-3 p-3 rounded-lg
        bg-surface border ${categoryConfig.borderColor}
        hover:bg-surface-2
        transition-colors duration-100 group
        no-underline hover:no-underline
        ${categoryConfig.textColor}
      `}
    >
      <div className={`p-1.5 rounded-sm border ${categoryConfig.borderColor} text-fg-3 group-hover:text-fg transition-colors`}>
        {categoryConfig.icon}
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-fg block truncate">
          {prototype.name}
        </span>
        <span className="text-xs text-fg-3">
          {formatPrototypeDate(prototype.created)}
        </span>
      </div>
      <ChevronRight size={12} className="text-fg-3 group-hover:text-fg transition-colors" />
    </Link>
  );
}

type TabType = 'archived' | 'prototypes';

const ARCHIVE_INITIAL_SIZE = 10;
const ARCHIVE_PAGE_SIZE = 25;

export function DevHub(): JSX.Element {
  const { devMode } = usePreferencesContext();
  const [archivedSessions, setArchivedSessions] = useState<UnifiedConversationSummary[]>([]);
  const [archiveTotal, setArchiveTotal] = useState(0);
  const [archiveOffset, setArchiveOffset] = useState(0);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveLoadingMore, setArchiveLoadingMore] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('archived');

  // Ref for infinite scroll sentinel
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const fetchArchivedSessions = useCallback(async (reset = false) => {
    const isInitialLoad = reset || archivedSessions.length === 0;
    if (isInitialLoad) {
      setArchiveLoading(true);
    } else {
      setArchiveLoadingMore(true);
    }

    try {
      const offset = reset ? 0 : archiveOffset;
      const data = await api.listUnifiedConversations({
        archived: true,
        includeIdentityImage: true,
      });
      // Server order: most recently archived first.
      const archived = (data.conversations || []).filter((conversation) => conversation.archived);
      const nextOffset = Math.min(
        archived.length,
        reset ? ARCHIVE_INITIAL_SIZE : offset + ARCHIVE_PAGE_SIZE
      );
      setArchivedSessions(archived.slice(0, nextOffset));
      setArchiveOffset(nextOffset);
      setArchiveTotal(archived.length);
    } catch (err) {
      console.error('Failed to fetch archived sessions:', err);
    } finally {
      setArchiveLoading(false);
      setArchiveLoadingMore(false);
    }
  }, [archiveOffset, archivedSessions.length]);

  const handleRestoreSession = async (sessionId: string) => {
    try {
      await api.unifiedUpdateConversation(sessionId, { archived: false });
      // Remove from local state
      setArchivedSessions(prev => prev.filter(s => s.conversationId !== sessionId));
      setArchiveTotal(prev => prev - 1);
    } catch (err) {
      console.error('Failed to restore session:', err);
    }
  };

  // Infinite scroll observer
  useEffect(() => {
    if (activeTab !== 'archived') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && !archiveLoading && !archiveLoadingMore) {
          // Check if there are more to load
          if (archivedSessions.length < archiveTotal) {
            void fetchArchivedSessions(false);
          }
        }
      },
      { threshold: 0.1 }
    );

    const sentinel = loadMoreRef.current;
    if (sentinel) {
      observer.observe(sentinel);
    }

    return () => {
      if (sentinel) {
        observer.unobserve(sentinel);
      }
    };
  }, [activeTab, archiveLoading, archiveLoadingMore, archivedSessions.length, archiveTotal, fetchArchivedSessions]);

  // Fetch archived sessions on mount and when switching to that tab
  useEffect(() => {
    if (activeTab === 'archived' && archivedSessions.length === 0 && !archiveLoading) {
      void fetchArchivedSessions(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Only trigger on tab change; other deps are guards
  }, [activeTab]);

  return (
    <div className="min-h-dvh bg-bg text-fg relative">
      {/* Header */}
      <header className="relative border-b border-line bg-bg sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <Link
              to="/"
              className="ui-icon-btn p-2 -ml-2 flex-shrink-0"
            >
              <ArrowLeft size={18} />
            </Link>
            <div className="min-w-0">
              <h1 className="text-base font-medium text-fg truncate">
                {devMode ? 'Dev hub' : 'Archive'}
              </h1>
              <p className="hidden sm:block text-xs text-fg-3">
                {devMode ? 'Prototypes and archive' : 'Archived sessions'}
              </p>
            </div>
          </div>

          {/* Tab switcher - collapses to icon-only on narrow screens */}
          <div className="flex items-center gap-1 p-1 rounded-md bg-bg border border-line flex-shrink-0">
            <button
              onClick={() => setActiveTab('archived')}
              title="Archived sessions"
              className={`
                flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-sm
                text-[13px]
                transition-colors duration-100
                ${activeTab === 'archived'
                  ? 'bg-surface-2 text-fg border border-transparent'
                  : 'text-fg-2 hover:text-fg border border-transparent'
                }
              `}
            >
              <Archive size={12} />
              <span className="hidden md:inline">Archived</span>
              {archivedSessions.length > 0 && (
                <span className="hidden md:inline text-xs text-fg-3 tabular-nums">({archivedSessions.length})</span>
              )}
            </button>
            {devMode && (
              <button
                onClick={() => setActiveTab('prototypes')}
                title="Prototypes"
                className={`
                  flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-sm
                  text-[13px]
                  transition-colors duration-100
                  ${activeTab === 'prototypes'
                    ? 'bg-surface-2 text-fg border border-transparent'
                    : 'text-fg-2 hover:text-fg border border-transparent'
                  }
                `}
              >
                <Beaker size={12} />
                <span className="hidden md:inline">Prototypes</span>
                <span className="hidden md:inline text-xs text-fg-3 tabular-nums">({PROTOTYPES.length})</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="relative max-w-3xl mx-auto px-6 py-8">
        {activeTab === 'archived' ? (
          <div>
            {/* Section header with refresh */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="flex items-center gap-2 text-xs font-medium text-fg-2">
                <Archive size={14} />
                Archived sessions
                {archiveTotal > 0 && (
                  <span className="text-fg-3 text-xs font-normal tabular-nums">
                    ({archivedSessions.length} of {archiveTotal})
                  </span>
                )}
              </h2>
              <button
                onClick={() => fetchArchivedSessions(true)}
                disabled={archiveLoading}
                className="ui-action-btn flex items-center gap-1.5 px-2.5 py-1 text-xs cursor-pointer disabled:opacity-50"
              >
                <RefreshCw size={10} className={archiveLoading ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>

            {archiveLoading && archivedSessions.length === 0 ? (
              <div className="text-center py-16 text-fg-3 text-sm">
                Loading archived sessions...
              </div>
            ) : archivedSessions.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-fg-2 text-sm mb-2">
                  No archived sessions.
                </p>
                <p className="text-fg-3 text-xs">
                  Archive sessions from the header to move them here.
                </p>
              </div>
            ) : (
              <div className="max-w-xl ml-4">
                {archivedSessions.map((session) => (
                  <TimelineCard
                    key={session.conversationId}
                    session={session}
                    onRestore={() => handleRestoreSession(session.conversationId)}
                  />
                ))}

                {/* Infinite scroll sentinel */}
                <div ref={loadMoreRef} className="py-4 ml-5">
                  {archiveLoadingMore && (
                    <div className="flex items-center justify-center gap-2 text-fg-3 text-sm">
                      <Loader2 size={14} className="animate-spin" />
                      <span>Loading more...</span>
                    </div>
                  )}
                  {!archiveLoadingMore && archivedSessions.length >= archiveTotal && archivedSessions.length > 0 && (
                    <div className="text-center text-fg-3 text-xs">
                      End of archived sessions
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : devMode ? (
          <div>
            {/* Section header */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="flex items-center gap-2 text-xs font-medium text-fg-2">
                <Beaker size={14} />
                Prototypes
                <span className="text-fg-3 text-xs tabular-nums">({PROTOTYPES.length})</span>
              </h2>
            </div>

            {/* Grouped by week, newest first */}
            <div className="space-y-6">
              {groupPrototypesByWeek(PROTOTYPES).map((group) => (
                <div key={group.weekStart.toISOString()}>
                  {/* Week header */}
                  <div className="flex items-center gap-3 mb-3">
                    <h3 className="text-xs font-medium text-fg-2 whitespace-nowrap">
                      {group.label}
                    </h3>
                    <div className="flex-1 h-px bg-line" />
                    <span className="text-xs text-fg-3 tabular-nums">
                      {group.prototypes.length}
                    </span>
                  </div>

                  {/* Prototypes in this week */}
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {group.prototypes.map((p) => {
                      const config = CATEGORY_CONFIG[p.category];
                      return (
                        <PrototypeCard key={p.path} prototype={p} categoryConfig={config} />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
