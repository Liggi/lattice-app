/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../services/api';
import type { Preferences, Theme } from '../types';
import type { CoordinatorConfig } from '@/types/config';

interface ServerConfig {
  host?: string;
  port?: number;
  defaultPermissionMode?: string;
  defaultModel?: string;
  defaultWorkingDirectory?: string;
  tailscaleIp?: string;
  /** The Tailscale CLI that answered: `tailscale`, or a full path when it is not on PATH. */
  tailscaleCli?: string;
  /** The `tailscale serve` command that leaves other served addresses alone, or the address when already served. */
  tailscaleServe?: { command: string | null; url: string | null };
  cwd?: string;
  /** An ambient watcher has written a scan on this machine. */
  ambientScan?: boolean;
}

export interface PreferencesContextType {
  preferences: Preferences | null;
  serverConfig: ServerConfig | null;
  /** The config's `coordinator` section, for the defaults a new coordinator starts on. */
  coordinatorConfig: CoordinatorConfig | null;
  theme: Theme;
  updatePreferences: (updates: Partial<Preferences>) => Promise<void>;
  setServerConfig: (config: ServerConfig | null) => void;
  isLoading: boolean;
  error: Error | null;
  /** Developer mode - shows prototypes, debug tools */
  devMode: boolean;
}

const PreferencesContext = createContext<PreferencesContextType | undefined>(undefined);

// Dark mode only - no theme switching
const fixedTheme: Theme = {
  mode: 'dark',
  colorScheme: 'dark',
  toggle: () => {} // No-op
};

export function PreferencesProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [coordinatorConfig, setCoordinatorConfig] = useState<CoordinatorConfig | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        setIsLoading(true);
        const config = await api.getConfig();
        setPreferences((config.interface as Preferences | undefined) ?? null);
        setServerConfig((config.server as ServerConfig | undefined) ?? null);
        setCoordinatorConfig(config.coordinator ?? null);
        setDevMode(config.interface?.devMode === true);
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Failed to load preferences'));
      } finally {
        setIsLoading(false);
      }
    };

    void loadPreferences();
  }, []);

  const updatePreferences = useCallback(async (updates: Partial<Preferences>) => {
    try {
      const updatedConfig = await api.updateConfig({ interface: updates });
      setPreferences((updatedConfig.interface as Preferences | undefined) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to update preferences'));
      throw err;
    }
  }, []);

  const handleSetServerConfig = useCallback((config: ServerConfig | null) => {
    setServerConfig(config);
  }, []);

  const contextValue = useMemo<PreferencesContextType>(() => ({
    preferences,
    serverConfig,
    coordinatorConfig,
    theme: fixedTheme,
    updatePreferences,
    setServerConfig: handleSetServerConfig,
    isLoading,
    error,
    devMode,
  }), [
    preferences,
    serverConfig,
    coordinatorConfig,
    updatePreferences,
    handleSetServerConfig,
    isLoading,
    error,
    devMode,
  ]);

  return (
    <PreferencesContext.Provider value={contextValue}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferencesContext(): PreferencesContextType {
  const context = useContext(PreferencesContext);
  if (!context) {
    throw new Error('usePreferencesContext must be used within a PreferencesProvider');
  }
  return context;
}
