import { useLocation } from 'react-router-dom';
import { PanelLeft } from 'lucide-react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { LatticeLogo } from '../components/shared/LatticeLogo';
import { usePlugins } from './PluginsContext';

/** A plugin's page under `/p/<id>…`: Lattice's header with the page's title, and the plugin's component below it. */
export function PluginPageView({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar: () => void }): JSX.Element {
  const { pathname } = useLocation();
  const { pages, ready } = usePlugins();
  const page = pages.get(pathname.replace(/\/+$/, ''));
  const Component = page?.component;

  return (
    <div className={`flex-1 min-w-0 flex flex-col h-full overflow-hidden ${sidebarOpen ? 'hidden md:flex' : ''}`}>
      <div className="relative flex items-center gap-3 h-[52px] px-4 bg-bg border-b border-line flex-shrink-0">
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
          <span className="text-sm text-fg-2 truncate">{page?.title ?? ''}</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto" data-testid="plugin-page" data-lattice-plugin={page ? pathname.split("/")[2] : undefined}>
        {Component ? (
          <ErrorBoundary name={`plugin page ${pathname}`}>
            <Component />
          </ErrorBoundary>
        ) : ready ? (
          <p className="max-w-3xl mx-auto px-4 py-8 text-sm text-fg-3">No plugin page is here. The plugin may not be installed, or failed to load: Settings, General, lists your plugins.</p>
        ) : null}
      </div>
    </div>
  );
}
