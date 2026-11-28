/**
 * The Inbox: everything across projects that waits on the user, as one
 * Linear-style list. Priority and All are quiet pill tabs; each row names
 * its project and kind over its real subject and why it is here. On a
 * desktop the selected row opens in a pane on the right, led by that subject,
 * with its status, real actions and a reply box that names who reads it; j/k
 * or the arrows move, Enter takes the marked action. On a phone a tapped row
 * opens the same content in place, under it.
 */

import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, ChevronUp, PanelLeft } from 'lucide-react';
import type { InboxFeedResponse, InboxItem } from '@/types/inbox-feed';
import { REPLY_HOLD_MS } from '@/types/held-replies';
import { formatAgo } from '@/types/project-state';
import { SessionStateIcon } from '../shared/session-state-icon/SessionStateIcon';
import { LatticeLogo } from '../shared/LatticeLogo';
import { ErrorBoundary } from '../ErrorBoundary';
import { FeedbackInboxBody } from '../Feedback/FeedbackInboxPage';
import { useFeedbackInboxUnread, useFeedbackStatus } from '../../hooks/useFeedback';
import { useInboxFeed, useRefreshInbox } from '../../hooks/useInboxFeed';
import { useActivityStreamSubscription } from '../../contexts/ActivityStreamContext';
import { pluginPagePath, usePlugins, type PluginLink } from '../../plugins/PluginsContext';
import { parseBadgeCount, partitionPluginLinks } from '../../plugins/plugin-sidebar-placement';
import { emptyText, inboxRows, itemQuestion, itemSubject, kindLabel, rowWhy, type InboxTab } from './inbox-view';
import { InboxBody, KindMark, openTarget, primaryAction, type InboxOutcome, type RunAction } from './InboxActions';

/** Session activity refetches the feed at most this often. */
const ACTIVITY_REFRESH_MS = 5_000;

function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function Row({ item, selected, expanded, outcome, now, onSelect }: {
  item: InboxItem;
  selected: boolean;
  expanded: boolean;
  outcome: InboxOutcome | undefined;
  now: number;
  onSelect: () => void;
}): JSX.Element {
  const answered = outcome?.state === 'held';
  const titleClass = expanded
    ? 'font-medium text-fg'
    : selected
      ? 'text-fg/95 md:font-medium md:text-fg'
      : 'text-fg/95 md:text-fg/90';
  const reasonClass = selected ? 'text-fg-3 md:text-fg-2' : 'text-fg-3';
  return (
    <button
      type="button"
      data-inbox-row={item.id}
      aria-current={selected ? 'true' : undefined}
      aria-expanded={expanded || undefined}
      onClick={onSelect}
      className={`flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors cursor-pointer ${selected ? 'md:bg-surface' : 'hover:bg-surface/60'} ${answered ? 'opacity-45' : ''}`}
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-[12px] leading-4 text-fg-3">
        <span className="min-w-0 truncate text-fg-2">{item.projectTitle}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <KindMark item={item} answered={answered} size={12} />
          <span>{kindLabel(item)}</span>
          <span className="w-7 text-right tabular-nums text-fg-3/80">{formatAgo(now - item.since)}</span>
          {expanded && <ChevronUp size={14} className="text-fg-3 md:hidden" aria-hidden="true" />}
        </span>
      </span>
      <span className={`line-clamp-2 w-full break-words text-[15px] md:text-[14px] leading-snug ${titleClass}`}>{itemSubject(item)}</span>
      <span className={`${expanded ? 'hidden md:block' : 'block'} w-full truncate text-[13px] md:text-[12.5px] ${reasonClass}`}>{rowWhy(item)}</span>
    </button>
  );
}

function Detail({ item, outcome, run, onUndo, now }: {
  item: InboxItem;
  outcome: InboxOutcome | undefined;
  run: RunAction;
  onUndo: (item: InboxItem) => void;
  now: number;
}): JSX.Element {
  const navigate = useNavigate();
  const target = openTarget(item);
  const heading = itemQuestion(item) ?? itemSubject(item);
  const topic = (item.kind === 'decision' || item.kind === 'call') && item.title !== heading ? item.title : null;
  const answered = outcome?.state === 'held';
  return (
    <div className="mx-auto flex w-full max-w-[620px] flex-col px-10 pt-5 pb-10" data-testid="inbox-detail">
      <div className="flex min-w-0 items-center gap-2.5 text-[13px]">
        <SessionStateIcon state={{ kind: 'idle' }} variant="project" size={15} />
        <span className="min-w-0 truncate text-fg-2">{item.projectTitle}</span>
        {topic && (
          <>
            <span className="shrink-0 text-fg-3/45" aria-hidden="true">/</span>
            <span className="min-w-0 truncate text-fg-3">{topic}</span>
          </>
        )}
        <span className="shrink-0 tabular-nums text-fg-3">{formatAgo(now - item.since)} ago</span>
        <button type="button" onClick={() => void navigate(target.to)} className="ml-auto flex shrink-0 items-center gap-1 text-fg-3 hover:text-fg cursor-pointer">
          {target.label}<ArrowUpRight size={13} aria-hidden="true" />
        </button>
      </div>
      <div className="pt-6">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1.5 text-[13px]">
          <span className="inline-flex items-center gap-1.5 font-medium text-fg-2">
            <KindMark item={item} answered={answered} size={14} neutralPr />
            <span>{kindLabel(item)}</span>
          </span>
          {item.priorityReason && (
            <>
              <span className="text-fg-3/45" aria-hidden="true">—</span>
              <span className="text-fg-3">{item.priorityReason}</span>
            </>
          )}
        </div>
        <h2 className="text-[22px] font-medium leading-snug text-fg break-words">{heading}</h2>
      </div>
      <div className="pt-4"><InboxBody key={item.id} item={item} outcome={outcome} run={run} onUndo={onUndo} /></div>
    </div>
  );
}

/** The list and detail for a loaded feed; the page wraps it with the header and data. */
export function InboxView({ feed, onChanged }: { feed: InboxFeedResponse; onChanged: () => void }): JSX.Element {
  const navigate = useNavigate();
  const [tab, setTab] = useState<InboxTab>('priority');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, InboxOutcome | undefined>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const now = Date.now();

  const rows = useMemo(() => inboxRows(feed.items, tab), [feed.items, tab]);
  const priorityCount = useMemo(() => inboxRows(feed.items, 'priority').length, [feed.items]);
  const current = rows.find((item) => item.id === selectedId) ?? rows[0] ?? null;

  const run: RunAction = useCallback(async (item, label, perform) => {
    try {
      const undo = await perform();
      setOutcomes((all) => ({ ...all, [item.id]: { state: 'held', label, undo } }));
      // The feed drops the item once the reply has gone.
      setTimeout(onChanged, REPLY_HOLD_MS + 1_000);
    } catch (err) {
      setOutcomes((all) => ({ ...all, [item.id]: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
    }
  }, [onChanged]);

  const undo = useCallback((item: InboxItem) => {
    const outcome = outcomes[item.id];
    if (outcome?.state !== 'held' || !outcome.undo) return;
    setOutcomes((all) => ({ ...all, [item.id]: undefined }));
    outcome.undo().then(onChanged, (err: unknown) => {
      setOutcomes((all) => ({ ...all, [item.id]: { state: 'error', message: `Undo failed: ${err instanceof Error ? err.message : String(err)}` } }));
    });
  }, [outcomes, onChanged]);

  const open = useCallback((item: InboxItem) => {
    if (item.href && item.action?.kind === 'open') window.open(item.href, '_blank', 'noreferrer');
    else void navigate(`/c/${item.conversationId}`);
  }, [navigate]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || !isDesktop()) return;
      if (!rows.length) return;
      const at = Math.max(0, rows.findIndex((item) => item.id === current?.id));
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedId(rows[Math.min(rows.length - 1, at + 1)].id);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedId(rows[Math.max(0, at - 1)].id);
      } else if (event.key === 'Enter' && current && !outcomes[current.id]) {
        const take = primaryAction(current, run, open);
        if (take) { event.preventDefault(); take(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, current, outcomes, run, open]);

  useEffect(() => {
    if (current) listRef.current?.querySelector(`[data-inbox-row="${CSS.escape(current.id)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);

  const tabClass = (on: boolean): string =>
    `relative flex items-center gap-1.5 py-2.5 text-[13px] transition-colors cursor-pointer ${
      on
        ? 'font-medium text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-[1.5px] after:bg-fg/80'
        : 'text-fg-3 hover:text-fg-2'
    }`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex w-full shrink-0 flex-col md:w-[400px] md:border-r md:border-line">
        <div className="flex items-center gap-5 border-b border-line/60 px-[18px] md:px-[22px]" role="tablist" aria-label="Filter inbox">
          <button type="button" role="tab" aria-selected={tab === 'priority'} onClick={() => setTab('priority')} className={tabClass(tab === 'priority')}>
            Priority <span className={`tabular-nums text-[12px] ${tab === 'priority' ? 'text-fg-2' : 'text-fg-3/70'}`}>{priorityCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'all'} onClick={() => setTab('all')} className={tabClass(tab === 'all')}>
            All <span className={`tabular-nums text-[12px] ${tab === 'all' ? 'text-fg-2' : 'text-fg-3/70'}`}>{feed.items.length}</span>
          </button>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1.5 pb-6 md:px-2.5" data-testid="inbox-list">
          {rows.length === 0 && <div className="px-3 py-3 text-[13.5px] text-fg-3">{emptyText(tab)}</div>}
          {rows.map((item) => (
            <div key={item.id} className={expandedId === item.id ? 'border-b border-line/70 pb-1 md:border-b-0 md:pb-0' : undefined}>
              <Row
                item={item}
                now={now}
                selected={item.id === current?.id}
                expanded={expandedId === item.id}
                outcome={outcomes[item.id]}
                onSelect={() => {
                  setSelectedId(item.id);
                  if (!isDesktop()) setExpandedId((open) => (open === item.id ? null : item.id));
                }}
              />
              {expandedId === item.id && (
                <div data-inline-detail className="px-3 pb-4 pt-1 md:hidden">
                  <InboxBody item={item} outcome={outcomes[item.id]} run={run} onUndo={undo} compact />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 overflow-y-auto md:flex">
        {current && <Detail key={current.id} item={current} outcome={outcomes[current.id]} run={run} onUndo={undo} now={now} />}
      </div>
    </div>
  );
}

function PluginSectionTab({
  link,
  active,
  onSelect,
}: {
  link: PluginLink;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  const badge = link.useBadge?.() ?? null;
  const count = parseBadgeCount(badge);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`inbox-section-${link.pluginId}`}
      onClick={onSelect}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors cursor-pointer ${
        active ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:text-fg hover:bg-surface/60'
      }`}
    >
      <span>{link.label}</span>
      {count > 0 && <span className="tabular-nums text-[11px] text-fg-3">{count}</span>}
    </button>
  );
}

export function InboxPage({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar: () => void }): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isLoading, error, unavailable } = useInboxFeed();
  const refresh = useRefreshInbox();
  const lastActivityRefresh = useRef(0);
  const { links: pluginLinks, pages: pluginPages, ready: pluginsReady } = usePlugins();
  const inboxPlugins = useMemo(() => partitionPluginLinks(pluginLinks).inbox, [pluginLinks]);
  const feedbackInbox = useFeedbackStatus()?.inbox === true;
  const feedbackUnread = useFeedbackInboxUnread(feedbackInbox) ?? 0;

  const requestedTab = searchParams.get('tab') ?? 'work';
  const activePluginLink = inboxPlugins.find((link) => link.pluginId === requestedTab) ?? null;
  const activeSection: 'work' | 'feedback' | string = requestedTab === 'feedback' && feedbackInbox
    ? 'feedback'
    : activePluginLink
      ? activePluginLink.pluginId
      : 'work';

  const selectSection = useCallback((next: string) => {
    setSearchParams((prev) => {
      const updated = new URLSearchParams(prev);
      if (next === 'work') updated.delete('tab');
      else updated.set('tab', next);
      return updated;
    }, { replace: true });
  }, [setSearchParams]);

  useActivityStreamSubscription({ type: 'activity' }, () => {
    const at = Date.now();
    if (at - lastActivityRefresh.current < ACTIVITY_REFRESH_MS) return;
    lastActivityRefresh.current = at;
    refresh();
  });

  const status = unavailable
    ? 'Inbox needs a newer Lattice server'
    : error
      ? `Could not load the inbox: ${error instanceof Error ? error.message : String(error)}`
      : null;

  const showSectionTabs = inboxPlugins.length > 0 || feedbackInbox;
  const activePluginPage = activePluginLink
    ? pluginPages.get(pluginPagePath(activePluginLink.pluginId, activePluginLink.path))
    : undefined;
  const ActivePluginComponent = activePluginPage?.component;

  return (
    <div className={`flex h-full min-w-0 flex-1 flex-col overflow-hidden ${sidebarOpen ? 'hidden md:flex' : ''}`} data-testid="inbox-page">
      <div className="flex h-[52px] flex-shrink-0 items-center gap-1 border-b border-line bg-bg px-4 sm:gap-2.5">
        {!sidebarOpen && (
          <>
            <button type="button" onClick={onToggleSidebar} aria-label="Open sessions sidebar" className="flex h-10 w-10 items-center justify-center ui-icon-btn touch-manipulation sm:hidden">
              <PanelLeft size={20} />
            </button>
            <button type="button" onClick={onToggleSidebar} aria-label="Open sessions sidebar" className="hidden p-1.5 ui-icon-btn sm:block">
              <PanelLeft size={18} />
            </button>
            <span className="hidden items-center gap-2 sm:flex" aria-label="Lattice">
              <LatticeLogo size={24} interactive={true} colorScheme="gradient" />
              <span className="wordmark text-[15px] text-white">lattice</span>
            </span>
          </>
        )}
        {!showSectionTabs && <h1 className="text-[15px] text-fg">Inbox</h1>}
        {showSectionTabs && (
          <div className="flex items-center gap-1" role="tablist" aria-label="Inbox sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeSection === 'work'}
              data-testid="inbox-section-work"
              onClick={() => selectSection('work')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors cursor-pointer ${
                activeSection === 'work' ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:text-fg hover:bg-surface/60'
              }`}
            >
              <span>Work</span>
              {activeSection !== 'work' && (data?.priorityCount ?? 0) > 0 && (
                <span className="tabular-nums text-[11px] text-fg-3">{data?.priorityCount}</span>
              )}
            </button>
            {inboxPlugins.map((link) => (
              <ErrorBoundary key={`${link.pluginId}:${link.path}`} name={`inbox tab ${link.pluginId}`} fallback={null}>
                <PluginSectionTab
                  link={link}
                  active={activeSection === link.pluginId}
                  onSelect={() => selectSection(link.pluginId)}
                />
              </ErrorBoundary>
            ))}
            {feedbackInbox && (
              <button
                type="button"
                role="tab"
                aria-selected={activeSection === 'feedback'}
                data-testid="inbox-section-feedback"
                onClick={() => selectSection('feedback')}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors cursor-pointer ${
                  activeSection === 'feedback' ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:text-fg hover:bg-surface/60'
                }`}
              >
                <span>Feedback</span>
                {feedbackUnread > 0 && <span className="tabular-nums text-[11px] text-fg-3">{feedbackUnread}</span>}
              </button>
            )}
          </div>
        )}
      </div>
      {activeSection === 'work' ? (
        data && !unavailable
          ? <InboxView feed={data} onChanged={refresh} />
          : <div className="px-5 pt-3 text-[13.5px] text-fg-3">{isLoading ? '' : status ?? emptyText('all')}</div>
      ) : activeSection === 'feedback' ? (
        <FeedbackInboxBody />
      ) : (
        <div
          className="flex-1 overflow-y-auto"
          data-testid="plugin-page"
          data-lattice-plugin={activePluginLink?.pluginId}
        >
          {ActivePluginComponent ? (
            <ErrorBoundary name={`inbox plugin ${activePluginLink?.pluginId ?? activeSection}`}>
              <ActivePluginComponent />
            </ErrorBoundary>
          ) : pluginsReady ? (
            <p className="max-w-3xl mx-auto px-4 py-8 text-sm text-fg-3">This section is not available right now.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
