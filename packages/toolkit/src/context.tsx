import React, { createContext, useContext } from 'react';

export interface ToolkitConfig {
  /** Controls shiki code theme selection. Tailwind dark: classes use the parent's `dark` class. */
  theme: 'light' | 'dark';
  /** Resolve an agent/team member name to a color key (blue, green, yellow, purple, red, cyan). */
  resolveAgentColor?: (name: string) => string | undefined;
}

const ToolkitContext = createContext<ToolkitConfig>({ theme: 'dark' });

export function ToolkitProvider({
  children,
  ...config
}: ToolkitConfig & { children: React.ReactNode }): React.JSX.Element {
  return (
    <ToolkitContext.Provider value={config}>
      {children}
    </ToolkitContext.Provider>
  );
}

export function useToolkitTheme(): 'light' | 'dark' {
  return useContext(ToolkitContext).theme;
}

export function useAgentColor(name: string | undefined): string | undefined {
  const { resolveAgentColor } = useContext(ToolkitContext);
  if (!name || !resolveAgentColor) return undefined;
  return resolveAgentColor(name);
}
