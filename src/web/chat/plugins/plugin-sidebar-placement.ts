import type { PluginLink } from './PluginsContext';

export type PluginSidebarSection = 'top' | 'inbox' | 'tools' | 'experimental' | 'hidden';

/**
 * Default sidebar placement for plugins that do not declare a `section` on
 * `sidebarLink`. Keeps the top rail quiet: inbox feeds consolidate into Inbox,
 * rarely-used utilities collapse under Tools, experimental surfaces collapse
 * under Experimental, and chat-card-only plugins stay out of the sidebar.
 */
const DEFAULT_PLUGIN_SECTIONS: Record<string, PluginSidebarSection> = {
  'agent-messages': 'inbox',
  'pr-timeline': 'tools',
  'run-monitor': 'hidden',
  'local-models': 'experimental',
};

export function resolvePluginSidebarSection(link: Pick<PluginLink, 'pluginId' | 'section'>): PluginSidebarSection {
  if (link.section) return link.section;
  return DEFAULT_PLUGIN_SECTIONS[link.pluginId] ?? 'tools';
}

export function partitionPluginLinks(links: readonly PluginLink[]): Record<PluginSidebarSection, PluginLink[]> {
  const buckets: Record<PluginSidebarSection, PluginLink[]> = {
    top: [],
    inbox: [],
    tools: [],
    experimental: [],
    hidden: [],
  };
  for (const link of links) {
    buckets[resolvePluginSidebarSection(link)].push(link);
  }
  return buckets;
}

/** Extracts a leading integer from a plugin badge string (e.g. "3 waiting" -> 3). */
export function parseBadgeCount(badge: string | null | undefined): number {
  if (!badge) return 0;
  const match = /^\s*(\d+)/.exec(badge);
  return match ? Number(match[1]) : 0;
}
