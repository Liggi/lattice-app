/**
 * ⌘K / Ctrl+K: jump to any project, session, archived session or pull
 * request, or run one of the app's few actions. The provider owns the
 * shortcut and the open state, so the sidebar and the phone header can open
 * the same palette; archived sessions and the current project's pull requests
 * are only fetched once it opens.
 */

import { createContext, type JSX, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Archive, ArrowRight, GitPullRequest, Inbox, Plus, Settings } from 'lucide-react';
import { useConversations } from '../../contexts/ConversationsContext';
import { useArchivedSidebarSessions } from '../../hooks/useArchivedSidebarSessions';
import { usePlugins, pluginPagePath } from '../../plugins/PluginsContext';
import { resolvePluginSidebarSection } from '../../plugins/plugin-sidebar-placement';
import { useFeedbackStatus } from '../../hooks/useFeedback';
import { SettingsDialog } from '../SettingsDialog/SettingsDialog';
import { SessionStateIcon } from '../shared/session-state-icon/SessionStateIcon';
import { Kbd } from '../shared/StateGlyph';
import { conversationItem, searchPalette, type PaletteItem } from './command-palette-search';
import type { ProjectShipping } from '@/services/sessions/project-shipping';

interface CommandPaletteApi {
  open: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteApi>({ open: () => {} });

/** Opens the palette from a trigger (the sidebar's Search row, the phone header). */
export function useCommandPalette(): CommandPaletteApi {
  return useContext(CommandPaletteContext);
}

export function CommandPaletteProvider({ children }: { children: ReactNode }): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  const open = useCallback(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsOpen(true);
  }, []);
  const close = useCallback((restoreFocus: boolean) => {
    setIsOpen(false);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (restoreFocus && target?.isConnected) requestAnimationFrame(() => target.focus());
  }, []);

  // Capture phase, so the shortcut still reaches us while the composer has focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      event.stopPropagation();
      if (isOpen) close(true);
      else open();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close, isOpen, open]);

  const api = useMemo(() => ({ open }), [open]);
  return (
    <CommandPaletteContext.Provider value={api}>
      {children}
      {isOpen && <CommandPalette onClose={close} onOpenSettings={() => setSettingsOpen(true)} />}
      <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </CommandPaletteContext.Provider>
  );
}

function currentConversationId(pathname: string): string | null {
  const match = /^\/c\/([^/]+)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function usePaletteItems(): PaletteItem[] {
  const { conversations } = useConversations();
  const { links } = usePlugins();
  const feedbackInbox = useFeedbackStatus()?.inbox === true;
  const { archivedSessions } = useArchivedSidebarSessions({ enabled: true });
  const { pathname } = useLocation();
  const currentId = currentConversationId(pathname);
  const current = conversations.find((conversation) => conversation.conversationId === currentId);
  const shippingId = current?.coordinator ? current.conversationId : null;
  const { data: shipping } = useQuery({
    queryKey: ['command-palette', 'shipping', shippingId],
    queryFn: async (): Promise<ProjectShipping | null> => {
      const response = await fetch(`/api/conv/${encodeURIComponent(shippingId!)}/shipping`);
      return response.ok ? response.json() as Promise<ProjectShipping> : null;
    },
    enabled: Boolean(shippingId),
    staleTime: 30_000,
  });

  return useMemo(() => {
    // A worker a coordinator dispatched is reachable from its project, as in the sidebar.
    const ids = new Set(conversations.map((conversation) => conversation.conversationId));
    const live = conversations
      .filter((conversation) => !conversation.archived && !conversation.conversationId.startsWith('pending-'))
      .filter((conversation) => conversation.coordinator || !(conversation.pickedUpFrom && ids.has(conversation.pickedUpFrom)))
      .map((conversation) => conversationItem(conversation));
    const archived = archivedSessions.map((conversation) => conversationItem(conversation, true));
    const prs: PaletteItem[] = (shipping?.items ?? [])
      .filter((item) => item.href && item.stage !== 'closed')
      .map((item) => ({
        id: `pr:${item.key}`,
        group: 'Pull requests',
        kind: 'pr',
        title: item.title,
        subtitle: item.stageLabel,
        lastUsed: item.at,
        target: { type: 'external', href: item.href! },
      }));
    const pages: PaletteItem[] = links
      .filter((link) => resolvePluginSidebarSection(link) !== 'hidden')
      .map((link) => {
        const section = resolvePluginSidebarSection(link);
        return {
          id: `page:${link.pluginId}:${link.path}`,
          group: 'Go to',
          kind: 'page',
          title: link.label,
          target: {
            type: 'navigate',
            to: section === 'inbox' ? `/inbox?tab=${encodeURIComponent(link.pluginId)}` : pluginPagePath(link.pluginId, link.path),
          },
        };
      });
    if (feedbackInbox) {
      pages.push({
        id: 'page:feedback',
        group: 'Go to',
        kind: 'page',
        title: 'Feedback',
        target: { type: 'navigate', to: '/inbox?tab=feedback' },
      });
    }
    const actions: PaletteItem[] = [
      { id: 'action:inbox', group: 'Actions', kind: 'action', title: 'Open Inbox', keywords: 'inbox decisions calls waiting priority messages feedback', target: { type: 'navigate', to: '/inbox' } },
      { id: 'action:new-project', group: 'Actions', kind: 'action', title: 'New project', target: { type: 'navigate', to: '/new?coordinator=1&mode=bypassPermissions' } },
      { id: 'action:new-session', group: 'Actions', kind: 'action', title: 'New session', target: { type: 'navigate', to: '/new?provider=claude&mode=bypassPermissions' } },
      { id: 'action:settings', group: 'Actions', kind: 'action', title: 'Settings', target: { type: 'settings' } },
    ];
    return [...live, ...prs, ...pages, ...actions, ...archived];
  }, [archivedSessions, conversations, feedbackInbox, links, shipping]);
}

function ItemIcon({ item }: { item: PaletteItem }): JSX.Element {
  const tone = 'text-fg-3';
  switch (item.kind) {
    case 'project':
      return <span className={tone}><SessionStateIcon state={{ kind: 'idle' }} variant="project" size={17} /></span>;
    case 'session':
      return <span className={tone}><SessionStateIcon state={{ kind: 'idle' }} variant="session" size={17} /></span>;
    case 'archived':
      return <Archive size={15} className={tone} />;
    case 'pr':
      return <GitPullRequest size={15} className={tone} />;
    case 'page':
      return <ArrowRight size={15} className={tone} />;
    case 'action':
      if (item.target.type === 'settings') return <Settings size={15} className={tone} />;
      return item.id === 'action:inbox' ? <Inbox size={15} className={tone} /> : <Plus size={15} className={tone} />;
  }
}

function CommandPalette({ onClose, onOpenSettings }: { onClose: (restoreFocus: boolean) => void; onOpenSettings: () => void }): JSX.Element {
  const navigate = useNavigate();
  const items = usePaletteItems();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const results = useMemo(() => searchPalette(items, query), [items, query]);
  const active = Math.min(cursor, Math.max(0, results.length - 1));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.target.type === 'navigate') {
      onClose(false);
      void navigate(item.target.to);
    } else if (item.target.type === 'external') {
      window.open(item.target.href, '_blank', 'noopener,noreferrer');
      onClose(true);
    } else {
      onClose(false);
      onOpenSettings();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setCursor(Math.min(results.length - 1, active + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(Math.max(0, active - 1)); }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); choose(results[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex justify-center bg-black/55 px-3 pt-3 md:pt-[14vh]"
      onMouseDown={() => onClose(true)}
      data-testid="command-palette-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex h-fit max-h-[min(76vh,640px)] w-full max-w-[600px] flex-col overflow-hidden rounded-xl border border-line-2 bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      >
        <div className="flex h-[54px] shrink-0 items-center gap-3 border-b border-line px-4">
          <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
            onKeyDown={onKeyDown}
            placeholder="Jump to project, session, or PR…"
            aria-label="Search projects, sessions and pull requests"
            aria-activedescendant={results[active] ? `palette-row-${active}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-[15.5px] text-fg placeholder:text-fg-3 outline-none"
          />
          <button type="button" onClick={() => onClose(true)} aria-label="Close" className="hidden shrink-0 md:inline-flex"><Kbd>Esc</Kbd></button>
          <button type="button" onClick={() => onClose(true)} className="shrink-0 text-[14px] text-fg-2 md:hidden">Close</button>
        </div>
        <div ref={listRef} role="listbox" className="overflow-y-auto overscroll-contain p-2">
          {results.length === 0 && <div className="px-3 py-6 text-[14px] text-fg-3">No match for “{query.trim()}”</div>}
          {results.map((item, index) => {
            const head = index === 0 || results[index - 1]?.group !== item.group ? item.group : null;
            const on = index === active;
            return (
              <div key={`${item.group}:${item.id}`}>
                {head && <div className={`px-3 pb-1.5 text-[12.5px] text-fg-3 ${index === 0 ? 'pt-1.5' : 'pt-4'}`}>{head}</div>}
                <button
                  type="button"
                  id={`palette-row-${index}`}
                  role="option"
                  aria-selected={on}
                  data-palette-index={index}
                  data-palette-kind={item.kind}
                  onMouseMove={() => { if (!on) setCursor(index); }}
                  onClick={() => choose(item)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 text-left ${on && item.subtitle ? 'py-2' : 'min-h-[40px] py-2'} ${on ? 'bg-surface-2' : ''}`}
                >
                  <span className="flex w-[18px] shrink-0 justify-center"><ItemIcon item={item} /></span>
                  <span className="min-w-0 flex-1">
                    <span className={`block break-words text-[14.5px] leading-snug ${on ? 'text-fg' : 'text-fg-2'}`}>{item.title}</span>
                    {on && item.subtitle && <span className="block break-words pt-0.5 text-[12px] text-fg-3">{item.subtitle}</span>}
                  </span>
                  {item.keys && <span className="flex shrink-0 gap-1">{item.keys.map((key) => <Kbd key={key}>{key}</Kbd>)}</span>}
                  {on && !item.keys && <span className="hidden shrink-0 md:inline-flex"><Kbd>↵</Kbd></span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
