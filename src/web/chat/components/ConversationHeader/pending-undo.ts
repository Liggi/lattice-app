import { useSyncExternalStore } from 'react';

/** How long Undo replaces the button that archived or slept a session. */
export const UNDO_WINDOW_MS = 10_000;

export interface PendingUndo {
  action: 'archive' | 'sleep';
  conversationId: string;
  startedAt: number;
  undo: () => Promise<void>;
}

// Held outside the header because archiving navigates to another session,
// and the Undo belongs on that session's header too.
let pending: PendingUndo | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(next: PendingUndo | null): void {
  pending = next;
  clearTimeout(timer);
  if (next) timer = setTimeout(() => set(null), UNDO_WINDOW_MS);
  listeners.forEach((listener) => listener());
}

export function offerUndo(action: PendingUndo['action'], conversationId: string, undo: () => Promise<void>): void {
  set({ action, conversationId, startedAt: Date.now(), undo });
}

/** Takes the pending undo off screen, then runs it; `onError` hears a failure. */
export function runUndo(onError: (action: PendingUndo['action']) => void): void {
  if (!pending) return;
  const { action, undo } = pending;
  set(null);
  undo().catch((err: unknown) => {
    console.error(`[Undo] Failed to undo ${action}:`, err);
    onError(action);
  });
}

export function usePendingUndo(): PendingUndo | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
  );
}
