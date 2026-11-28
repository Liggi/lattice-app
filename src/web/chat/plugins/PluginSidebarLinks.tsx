import { type JSX, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Puzzle } from 'lucide-react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { pluginPagePath, usePlugins, type PluginLink } from './PluginsContext';
import { parseBadgeCount, partitionPluginLinks } from './plugin-sidebar-placement';

export function PluginLinkRow({ link, onNavigate }: { link: PluginLink; onNavigate: () => void }): JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const to = pluginPagePath(link.pluginId, link.path);
  const badge = link.useBadge?.() ?? null;
  const Icon = link.icon ?? Puzzle;
  const active = pathname === to;
  return (
    <button
      onClick={() => {
        void navigate(to);
        onNavigate();
      }}
      data-testid={`sidebar-plugin-${link.pluginId}`}
      aria-current={active ? 'page' : undefined}
      className={`flex w-full items-center justify-between gap-2 px-2 py-1.5 rounded-sm text-sm transition-colors cursor-pointer ${
        active ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:text-fg hover:bg-surface'
      }`}
    >
      {/* The icon sits in the cards' 28px icon column so labels line up with the rows below. */}
      <span className="flex items-center gap-2.5 min-w-0">
        <span className="flex w-7 shrink-0 justify-center"><Icon size={16} className={active ? 'text-fg-2' : 'text-fg-3'} /></span>
        <span className="truncate">{link.label}</span>
      </span>
      {badge ? <span className="shrink-0 font-mono text-[11px] text-accent">{badge}</span> : null}
    </button>
  );
}

/** Renders a list of plugin sidebar rows, each wrapped in its own error boundary. */
export function PluginSidebarLinks({
  links: explicitLinks,
  onNavigate,
}: {
  links?: readonly PluginLink[];
  onNavigate: () => void;
}): JSX.Element | null {
  const { links: allLinks } = usePlugins();
  const links = explicitLinks ?? partitionPluginLinks(allLinks).top;
  if (links.length === 0) return null;
  return (
    <>
      {links.map((link) => (
        <ErrorBoundary key={`${link.pluginId}:${link.path}`} name={`plugin link ${link.pluginId}`} fallback={null}>
          <PluginLinkRow link={link} onNavigate={onNavigate} />
        </ErrorBoundary>
      ))}
    </>
  );
}

function BadgeReporter({ link, onCount }: { link: PluginLink; onCount: (id: string, count: number) => void }): null {
  const badge = link.useBadge?.() ?? null;
  const count = parseBadgeCount(badge);
  useEffect(() => {
    onCount(link.pluginId, count);
    return () => onCount(link.pluginId, 0);
  }, [link.pluginId, count, onCount]);
  return null;
}

/** Safely reads badge counts from plugins consolidated into Inbox without violating Rules of Hooks. */
export function PluginBadgeWatcher({
  links,
  onCount,
}: {
  links: readonly PluginLink[];
  onCount: (id: string, count: number) => void;
}): JSX.Element | null {
  if (links.length === 0) return null;
  return (
    <>
      {links.map((link) => (
        <ErrorBoundary key={`${link.pluginId}:${link.path}`} name={`plugin badge ${link.pluginId}`} fallback={null}>
          <BadgeReporter link={link} onCount={onCount} />
        </ErrorBoundary>
      ))}
    </>
  );
}
