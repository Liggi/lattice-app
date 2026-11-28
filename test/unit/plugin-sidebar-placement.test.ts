import { describe, expect, it } from 'vitest';
import {
  parseBadgeCount,
  partitionPluginLinks,
  resolvePluginSidebarSection,
} from '../../src/web/chat/plugins/plugin-sidebar-placement.js';
import type { PluginLink } from '../../src/web/chat/plugins/PluginsContext.js';

function link(pluginId: string, section?: PluginLink['section']): PluginLink {
  return { pluginId, label: pluginId, path: '/', ...(section ? { section } : {}) };
}

describe('plugin-sidebar-placement', () => {
  it('assigns default sections for known plugins and falls back to tools', () => {
    expect(resolvePluginSidebarSection(link('agent-messages'))).toBe('inbox');
    expect(resolvePluginSidebarSection(link('pr-timeline'))).toBe('tools');
    expect(resolvePluginSidebarSection(link('run-monitor'))).toBe('hidden');
    expect(resolvePluginSidebarSection(link('local-models'))).toBe('experimental');
    expect(resolvePluginSidebarSection(link('some-new-plugin'))).toBe('tools');
  });

  it('honors an explicit section declared by the plugin', () => {
    expect(resolvePluginSidebarSection(link('local-models', 'top'))).toBe('top');
    expect(resolvePluginSidebarSection(link('pr-timeline', 'hidden'))).toBe('hidden');
  });

  it('partitions links cleanly by section', () => {
    const grouped = partitionPluginLinks([
      link('agent-messages'),
      link('pr-timeline'),
      link('run-monitor'),
      link('local-models'),
      link('pinned-thing', 'top'),
    ]);
    expect(grouped.top.map((l) => l.pluginId)).toEqual(['pinned-thing']);
    expect(grouped.inbox.map((l) => l.pluginId)).toEqual(['agent-messages']);
    expect(grouped.tools.map((l) => l.pluginId)).toEqual(['pr-timeline']);
    expect(grouped.experimental.map((l) => l.pluginId)).toEqual(['local-models']);
    expect(grouped.hidden.map((l) => l.pluginId)).toEqual(['run-monitor']);
  });

  it('extracts leading integer counts from plugin badge labels', () => {
    expect(parseBadgeCount('3 waiting')).toBe(3);
    expect(parseBadgeCount(' 12 ')).toBe(12);
    expect(parseBadgeCount('ready')).toBe(0);
    expect(parseBadgeCount('')).toBe(0);
    expect(parseBadgeCount(null)).toBe(0);
    expect(parseBadgeCount(undefined)).toBe(0);
  });
});
