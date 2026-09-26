import { useCallback, useState } from 'react';

const DESKTOP_MIN_WIDTH = 768;

// The panel is a docked sidebar on desktop and a full-screen overlay on mobile,
// so the stored flag is a desktop preference. A mobile view always starts
// closed: ConversationView is keyed by conversation, so a remembered "open"
// would put the overlay back over every session navigated to — a worker card
// opened from the panel would land on a blank screen with its messages behind.
function isDesktopViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth >= DESKTOP_MIN_WIDTH;
}

function persistPreference(open: boolean): void {
  if (!isDesktopViewport()) return;
  try {
    localStorage.setItem('insightsPanelOpen', String(open));
  } catch {
    // Ignore localStorage write failures.
  }
}

export function useInsightsPanelState(): {
  insightsPanelOpen: boolean;
  toggleInsightsPanel: () => void;
  closeInsightsPanel: () => void;
} {
  const [insightsPanelOpen, setInsightsPanelOpen] = useState(() => {
    if (!isDesktopViewport()) return false;
    try {
      const stored = localStorage.getItem('insightsPanelOpen');
      if (stored !== null) return stored === 'true';
    } catch {
      // Ignore localStorage read failures.
    }
    return true;
  });

  const toggleInsightsPanel = useCallback(() => {
    setInsightsPanelOpen((prev) => {
      const next = !prev;
      persistPreference(next);
      return next;
    });
  }, []);

  const closeInsightsPanel = useCallback(() => {
    persistPreference(false);
    setInsightsPanelOpen(false);
  }, []);

  return {
    insightsPanelOpen,
    toggleInsightsPanel,
    closeInsightsPanel,
  };
}
