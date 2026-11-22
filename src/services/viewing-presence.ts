/**
 * Which conversation each open Lattice page is showing while it is on screen.
 *
 * Pages report every few seconds while visible (`POST /api/notifications/viewing`),
 * and report `null` when hidden or closed. A conversation someone is looking at
 * on any device gets no notification, and a notification for a conversation
 * that has since been looked at is cleared on every device that next hears
 * from the server (see `clearable`).
 */

/** A page that stops reporting for this long is no longer counted as watching. */
const VIEWING_TTL_MS = 45_000;
/** How far back a viewed-after-notified conversation is still sent out to be cleared. */
const CLEAR_WINDOW_MS = 24 * 60 * 60_000;

interface Viewer { sessionId: string; at: number }

export class ViewingPresence {
  private static instance: ViewingPresence;
  private viewers = new Map<string, Viewer>();
  private lastViewedAt = new Map<string, number>();
  private lastNotifiedAt = new Map<string, number>();

  static getInstance(): ViewingPresence {
    if (!ViewingPresence.instance) ViewingPresence.instance = new ViewingPresence();
    return ViewingPresence.instance;
  }

  /** A page reports what it shows; `null` means it is hidden or closed. */
  note(clientId: string, sessionId: string | null, now = Date.now()): void {
    if (!sessionId) {
      this.viewers.delete(clientId);
      return;
    }
    this.viewers.set(clientId, { sessionId, at: now });
    this.lastViewedAt.set(sessionId, now);
  }

  isWatched(sessionId: string, now = Date.now()): boolean {
    for (const [clientId, viewer] of this.viewers) {
      if (now - viewer.at > VIEWING_TTL_MS) {
        this.viewers.delete(clientId);
        continue;
      }
      if (viewer.sessionId === sessionId) return true;
    }
    return false;
  }

  noteNotified(sessionId: string, now = Date.now()): void {
    this.lastNotifiedAt.set(sessionId, now);
  }

  /**
   * Conversations notified about and looked at since, with when they were
   * last looked at: a notification for one sent before that time is stale.
   */
  clearable(now = Date.now()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [sessionId, notifiedAt] of this.lastNotifiedAt) {
      const viewedAt = this.lastViewedAt.get(sessionId);
      if (now - notifiedAt > CLEAR_WINDOW_MS) {
        this.lastNotifiedAt.delete(sessionId);
        continue;
      }
      if (viewedAt !== undefined && viewedAt >= notifiedAt) out[sessionId] = viewedAt;
    }
    return out;
  }
}
