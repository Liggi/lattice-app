import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, Check, Loader2, PanelLeft, RefreshCw, ShieldAlert } from 'lucide-react';
import { api } from '../../services/api';
import { feedbackInboxQueryKey } from '../../hooks/useFeedback';
import { LatticeLogo } from '../shared/LatticeLogo';
import type { FeedbackInboxItem, FeedbackInboxView } from '@/types/feedback';

const VIEWS: Array<[FeedbackInboxView, string]> = [
  ['unread', 'Unread'],
  ['all', 'All'],
  ['flagged', 'Flagged'],
];

const CATEGORY_LABEL: Record<FeedbackInboxItem['category'], string> = {
  bug: 'Bug',
  suggestion: 'Suggestion',
  other: 'Other',
};

const SCREEN_LABEL: Record<string, string> = {
  home: 'sent from the home screen',
  conversation: 'sent from a session',
  settings: 'sent from Settings',
  cli: 'proposed with the lattice command',
};

function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Flags({ item }: { item: FeedbackInboxItem }): JSX.Element | null {
  if (item.classificationState !== 'classified') {
    return (
      <span className="text-[11px] text-fg-3">
        {item.classificationState === 'failed' ? 'Could not be classified' : 'Not classified yet'}
      </span>
    );
  }
  const flags = [
    item.offTopic ? 'Off-topic' : null,
    item.abusive ? 'Abusive' : null,
  ].filter((flag): flag is string => flag !== null);
  if (flags.length === 0) return null;
  return (
    <span className={`flex items-center gap-1 text-[11px] ${item.abusive ? 'text-rose-300' : 'text-amber-300'}`}>
      <ShieldAlert size={12} />
      <span>Flagged {flags.join(' and ').toLowerCase()}{item.classificationReason ? `: ${item.classificationReason}` : ''}</span>
    </span>
  );
}

function InboxItem({ item, onMark }: { item: FeedbackInboxItem; onMark: (changes: { read?: boolean; done?: boolean }) => void }): JSX.Element {
  const unread = !item.readAt && !item.doneAt;
  const context = [
    item.scope === 'session' ? 'About a session' : 'About Lattice',
    item.provider ? (item.model ? `${item.provider}, ${item.model}` : item.provider) : null,
    item.latticeVersion ? `Lattice ${item.latticeVersion}` : null,
    SCREEN_LABEL[item.screen] ?? null,
  ].filter(Boolean);
  return (
    <article className="px-4 py-3 border-b border-line space-y-2" data-testid="feedback-inbox-item">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[11px] uppercase tracking-wider ${unread ? 'text-accent' : 'text-fg-3'}`}>
            {CATEGORY_LABEL[item.category]}
          </span>
          {item.source === 'agent' && (
            <span className="flex items-center gap-1 text-[11px] text-fg-3">
              <Bot size={12} />
              From an agent
            </span>
          )}
          {item.doneAt && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-400">
              <Check size={12} />
              Done
            </span>
          )}
        </div>
        <time className="shrink-0 text-[11px] text-fg-3" dateTime={item.receivedAt} title={new Date(item.receivedAt).toLocaleString()}>
          {ago(item.receivedAt)}
        </time>
      </div>

      {/* Inert text: never rendered as markdown or HTML, no links fetched. */}
      <p className={`text-sm whitespace-pre-wrap break-words ${unread ? 'text-fg' : 'text-fg-2'}`}>{item.message}</p>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-fg-3">{context.join(', ')}</span>
          <Flags item={item} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onMark({ read: !(item.readAt || item.doneAt) })}
            className="px-2 py-1 rounded-md text-xs text-fg-3 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer"
          >
            {item.readAt || item.doneAt ? 'Mark unread' : 'Mark read'}
          </button>
          <button
            onClick={() => onMark({ done: !item.doneAt })}
            className="px-2 py-1 rounded-md text-xs text-accent hover:bg-accent-soft transition-colors cursor-pointer"
          >
            {item.doneAt ? 'Not done' : 'Done'}
          </button>
        </div>
      </div>
    </article>
  );
}

/** The collector owner's feedback inbox: newest first, read and done kept locally. */
export function FeedbackInboxPage({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  const [view, setView] = useState<FeedbackInboxView>('unread');
  const [refreshing, setRefreshing] = useState(false);
  const { data, error, isLoading } = useQuery({
    queryKey: [...feedbackInboxQueryKey, 'list', view],
    queryFn: () => api.getFeedbackInbox(view),
    refetchInterval: 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: feedbackInboxQueryKey });

  const mark = async (id: string, changes: { read?: boolean; done?: boolean }) => {
    await api.markFeedbackInboxItem(id, changes);
    await invalidate();
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.refreshFeedbackInbox();
    } finally {
      await invalidate();
      setRefreshing(false);
    }
  };

  const emptyText = view === 'unread' ? 'Nothing unread.' : view === 'flagged' ? 'Nothing flagged.' : 'No feedback yet.';

  return (
    <div className={`flex-1 min-w-0 flex flex-col h-full overflow-hidden ${sidebarOpen ? 'hidden md:flex' : ''}`}>
      <div className="relative flex items-center justify-between gap-3 h-[52px] px-4 bg-bg border-b border-line flex-shrink-0">
        <div className="flex items-center gap-1 sm:gap-2.5 min-w-0">
          {!sidebarOpen && (
            <>
              <button type="button" onClick={onToggleSidebar} aria-label="Open sessions sidebar" className="flex sm:hidden items-center justify-center w-10 h-10 ui-icon-btn touch-manipulation">
                <PanelLeft size={20} />
              </button>
              <button onClick={onToggleSidebar} aria-label="Open sessions sidebar" className="hidden sm:block p-1.5 ui-icon-btn">
                <PanelLeft size={18} />
              </button>
              <span className="hidden sm:flex items-center gap-2" aria-label="Lattice">
                <LatticeLogo size={24} interactive={true} colorScheme="gradient" />
                <span className="wordmark text-[15px] text-white">lattice</span>
              </span>
            </>
          )}
          <span className="text-sm text-fg-2">Feedback</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-fg-3">
          {data?.lastRefreshAt && <span className="hidden sm:inline">Updated {ago(data.lastRefreshAt)}</span>}
          <button onClick={() => void refresh()} disabled={refreshing} aria-label="Check for new feedback" className="p-1.5 ui-icon-btn disabled:opacity-50">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-1 px-4 pt-3 pb-2">
            {VIEWS.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`flex items-center gap-1.5 px-3 py-1 text-[13px] rounded-md transition-colors cursor-pointer ${
                  view === key ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:text-fg'
                }`}
              >
                <span>{label}</span>
                {data && <span className="font-mono text-[11px] text-fg-3">{data.counts[key]}</span>}
              </button>
            ))}
          </div>

          {data?.refreshError && (
            <div className="mx-4 mb-2 flex items-start gap-2 text-xs text-amber-300">
              <AlertTriangle size={14} className="shrink-0 mt-px" />
              <span>
                Could not check for new feedback: {data.refreshError}
                {data.lastRefreshAt ? ` Showing what arrived up to ${new Date(data.lastRefreshAt).toLocaleString()}.` : ''}
              </span>
            </div>
          )}
          {error && <p className="px-4 py-2 text-xs text-rose-300">{error instanceof Error ? error.message : String(error)}</p>}
          {isLoading && <Loader2 size={16} className="mx-4 my-3 animate-spin text-fg-3" />}
          {data && data.items.length === 0 && <p className="px-4 py-6 text-sm text-fg-3">{emptyText}</p>}
          <div className="border-t border-line">
            {data?.items.map((item) => (
              <InboxItem key={item.id} item={item} onMark={(changes) => void mark(item.id, changes)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
