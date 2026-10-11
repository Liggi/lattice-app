import { AlertTriangle } from 'lucide-react';
import { usePlugins } from './PluginsContext';

/** Settings → General: the plugins config.json names, so none runs unseen. Absent when there are none. */
export function PluginsSettingsSection(): JSX.Element | null {
  const { plugins, webErrors } = usePlugins();
  if (plugins.length === 0) return null;
  return (
    <div className="border-t border-line pt-4 space-y-3" data-testid="plugins-settings">
      <div className="space-y-1">
        <p className="text-xs font-medium text-fg-2">Plugins</p>
        <p className="text-xs text-fg-3">
          A plugin runs with all of Lattice&apos;s access to your sessions, files and keys. Keep only ones you trust.
        </p>
      </div>
      <ul className="space-y-2.5">
        {plugins.map((plugin) => {
          const error = plugin.error ?? (plugin.id ? webErrors.get(plugin.id) : undefined);
          return (
            <li key={plugin.name} className="space-y-0.5" data-testid="plugins-settings-row">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm text-fg break-all">{plugin.name}</span>
                {plugin.version && <span className="font-mono text-[11px] text-fg-3">{plugin.version}</span>}
              </div>
              {error && (
                <p className="flex items-start gap-1.5 text-xs text-rose-300">
                  <AlertTriangle size={13} className="shrink-0 mt-px" />
                  <span className="break-words">Not loaded: {error}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
