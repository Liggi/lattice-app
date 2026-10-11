import { useLocation, useNavigate } from 'react-router-dom';
import { Puzzle } from 'lucide-react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { pluginPagePath, usePlugins, type PluginLink } from './PluginsContext';

function LinkRow({ link, onNavigate }: { link: PluginLink; onNavigate: () => void }): JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const to = pluginPagePath(link.pluginId, link.path);
  const badge = link.useBadge?.() ?? null;
  const Icon = link.icon ?? Puzzle;
  return (
    <button
      onClick={() => {
        void navigate(to);
        onNavigate();
      }}
      data-testid={`sidebar-plugin-${link.pluginId}`}
      className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm text-sm transition-colors cursor-pointer ${
        pathname === to ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:text-fg hover:bg-surface'
      }`}
    >
      {/* The icon sits in the cards' 28px icon column, as the Feedback link's does. */}
      <span className="flex items-center gap-2.5">
        <span className="flex w-7 shrink-0 justify-center"><Icon size={16} className="text-fg-3" /></span>
        <span>{link.label}</span>
      </span>
      {badge ? <span className="font-mono text-[11px] text-accent">{badge}</span> : null}
    </button>
  );
}

/** Plugins' links at the top of the sidebar, each with the count its plugin gives; the sidebar supplies their group. */
export function PluginSidebarLinks({ onNavigate }: { onNavigate: () => void }): JSX.Element | null {
  const { links } = usePlugins();
  if (links.length === 0) return null;
  return (
    <>
      {links.map((link) => (
        <ErrorBoundary key={`${link.pluginId}:${link.path}`} name={`plugin link ${link.pluginId}`} fallback={null}>
          <LinkRow link={link} onNavigate={onNavigate} />
        </ErrorBoundary>
      ))}
    </>
  );
}
