import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSidebarLists } from './useSidebarLists';
import { sidebarOrderedIds } from '../utils/sidebar-ordering';

/**
 * Enables Ctrl+Tab / Ctrl+Shift+Tab to cycle through sessions in sidebar visual order.
 * Designed for PWA context where these shortcuts are not captured by the browser.
 */
export function useSessionTabNavigation(currentSessionId: string | undefined): void {
  const navigate = useNavigate();
  const lists = useSidebarLists();
  const orderedIds = useMemo(() => sidebarOrderedIds(lists), [lists]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== 'Tab') return;
      if (orderedIds.length === 0) return;

      e.preventDefault();

      const currentIndex = currentSessionId ? orderedIds.indexOf(currentSessionId) : -1;
      let nextIndex: number;

      if (e.shiftKey) {
        // Ctrl+Shift+Tab → previous
        nextIndex = currentIndex <= 0 ? orderedIds.length - 1 : currentIndex - 1;
      } else {
        // Ctrl+Tab → next
        nextIndex = currentIndex >= orderedIds.length - 1 ? 0 : currentIndex + 1;
      }

      const nextId = orderedIds[nextIndex];
      if (nextId && nextId !== currentSessionId) {
        void navigate(`/c/${nextId}`);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [orderedIds, currentSessionId, navigate]);
}
