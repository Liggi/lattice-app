import { useSyncExternalStore } from 'react';

/** How long Undo replaces the button that archived or slept a session. */
export const UNDO_WINDOW_MS = 10_000;

export interface PendingUndo {
  action: 'archive' | 'sleep';
  conversationId: string;
  startedAt: number;
  /** The one session whose header shows it; archive's is claimed by the session it lands on. */
  shownOn?: string;
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
  set({ action, conversationId, startedAt: Date.now(), shownOn: action === 'sleep' ? conversationId : undefined, undo });
}

/** Called as a header shows a session: the first session after archiving claims the Undo, and moving to any other session drops it. */
export function noteViewing(sessionId: string | undefined): void {
  if (!pending || !sessionId) return;
  if (pending.action === 'archive' && sessionId === pending.conversationId) return;
  if (pending.shownOn === undefined) {
    pending = { ...pending, shownOn: sessionId };
    listeners.forEach((listener) => listener());
  } else if (pending.shownOn !== sessionId) {
    set(null);
  }
}

/** Whether the header of `sessionId` should show the pending undo, before or after it is claimed. */
export function undoShowsOn(undo: PendingUndo, sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  if (undo.shownOn !== undefined) return undo.shownOn === sessionId;
  return undo.action === 'archive' && sessionId !== undo.conversationId;
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
