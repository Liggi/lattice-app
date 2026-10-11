/**
 * Plugins in the web app: each loaded plugin's web entry, imported at runtime
 * from `/api/plugins/<id>/assets/web.js` with its stylesheet, and the pages
 * and sidebar links it registers (`@liggi/lattice-plugin-kit` has the
 * contract). The entry is built against the host's React, which is put on
 * `globalThis.__latticePluginHost` before the first import: a second copy of
 * React in the page breaks hooks.
 */
/* oxlint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import * as ReactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import { useNavigate } from 'react-router-dom';
import type { LatticeIcon, LatticeWebHost } from '@liggi/lattice-plugin-kit';

export interface PluginInfo {
  name: string;
  id: string | null;
  version: string | null;
  status: 'loaded' | 'failed';
  error?: string;
  web: boolean;
  css: boolean;
}

export interface PluginPage {
  component: ComponentType;
  title: string;
}

export interface PluginLink {
  pluginId: string;
  label: string;
  path: string;
  icon?: LatticeIcon;
  useBadge?: () => string | null;
}

interface PluginsState {
  plugins: PluginInfo[];
  /** Keyed by `/p/<id><path>`. */
  pages: ReadonlyMap<string, PluginPage>;
  links: PluginLink[];
  /** Why a plugin's web entry did not load, by plugin id. */
  webErrors: ReadonlyMap<string, string>;
  /** False until every web entry has been imported or has failed. */
  ready: boolean;
}

const EMPTY: PluginsState = { plugins: [], pages: new Map(), links: [], webErrors: new Map(), ready: false };
const PluginsContext = createContext<PluginsState>(EMPTY);

declare global {
  var __latticePluginHost: { React: typeof React; ReactDOM: typeof ReactDOM; jsxRuntime: typeof jsxRuntime } | undefined;
}

export function pluginPagePath(id: string, path = ''): string {
  const tail = path && !path.startsWith('/') ? `/${path}` : path;
  return `/p/${id}${tail === '/' ? '' : tail}`;
}

async function pluginRequest<T>(id: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/plugins/${encodeURIComponent(id)}${path.startsWith('/') ? path : `/${path}`}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data as T;
}

function addStylesheet(id: string): void {
  if (document.querySelector(`link[data-lattice-plugin="${id}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `/api/plugins/${encodeURIComponent(id)}/assets/web.css`;
  link.dataset.latticePlugin = id;
  document.head.appendChild(link);
}

export function PluginsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<PluginsState>(EMPTY);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let plugins: PluginInfo[] = [];
      try {
        const response = await fetch('/api/plugins');
        if (response.ok) plugins = ((await response.json()) as { plugins: PluginInfo[] }).plugins;
      } catch (error) {
        console.error('Could not list plugins:', error);
      }
      const pages = new Map<string, PluginPage>();
      const links: PluginLink[] = [];
      const webErrors = new Map<string, string>();
      globalThis.__latticePluginHost = { React, ReactDOM, jsxRuntime };
      for (const plugin of plugins) {
        const id = plugin.id;
        if (plugin.status !== 'loaded' || !id || !plugin.web) continue;
        if (plugin.css) addStylesheet(id);
        const host: LatticeWebHost = {
          id,
          page: (path, component, opts) => { pages.set(pluginPagePath(id, path), { component, title: opts.title }); },
          sidebarLink: (link) => { links.push({ pluginId: id, ...link }); },
          api: {
            get: (path) => pluginRequest(id, 'GET', path),
            post: (path, body) => pluginRequest(id, 'POST', path, body ?? {}),
          },
          navigate: (to) => { void navigateRef.current(to); },
          pagePath: (path) => pluginPagePath(id, path),
        };
        try {
          const mod = await import(/* @vite-ignore */ `/api/plugins/${encodeURIComponent(id)}/assets/web.js`) as { default?: unknown };
          if (typeof mod.default !== 'function') throw new Error('its web entry has no default export function');
          (mod.default as (web: LatticeWebHost) => void)(host);
        } catch (error) {
          console.error(`Plugin ${id} failed to load in the page:`, error);
          webErrors.set(id, error instanceof Error ? error.message : String(error));
        }
      }
      if (!cancelled) setState({ plugins, pages, links, webErrors, ready: true });
    })();
    return () => { cancelled = true; };
  }, []);

  return <PluginsContext.Provider value={state}>{children}</PluginsContext.Provider>;
}

export function usePlugins(): PluginsState {
  return useContext(PluginsContext);
}
