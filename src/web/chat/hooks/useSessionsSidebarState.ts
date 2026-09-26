import { useCallback, useState } from 'react';

const STORAGE_KEY = 'crossSessionSidebarOpen';
const DESKTOP_MIN_WIDTH = 768;
const DEFAULT_OPEN_MIN_WIDTH = 1024;

function isDesktopViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth >= DESKTOP_MIN_WIDTH;
}

function persistPreference(open: boolean): void {
  if (!isDesktopViewport()) return;
  try {
    localStorage.setItem(STORAGE_KEY, String(open));
  } catch {
    // Ignore localStorage write failures.
  }
}

/**
 * Sidebar open state, shared by every route that renders the sessions sidebar.
 * The stored flag is a desktop preference: the sidebar is a docked column there
 * and a full-screen drawer on a phone, where it always starts closed.
 */
export function useSessionsSidebarState(): {
  sidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
} {
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (!isDesktopViewport()) return false;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) return stored === 'true';
    } catch {
      // Ignore localStorage read failures.
    }
    return window.innerWidth >= DEFAULT_OPEN_MIN_WIDTH;
  });

  const openSidebar = useCallback(() => {
    persistPreference(true);
    setSidebarOpen(true);
  }, []);

  const closeSidebar = useCallback(() => {
    persistPreference(false);
    setSidebarOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      persistPreference(next);
      return next;
    });
  }, []);

  return { sidebarOpen, openSidebar, closeSidebar, toggleSidebar };
}
