import { useEffect } from 'react';

/** Under the server's 45 s cut-off, so a page on screen is never counted as gone. */
const REPORT_EVERY_MS = 15_000;

/** One id per tab, so two tabs on two devices are told apart. */
const clientId = (() => {
  const key = 'lattice-viewing-client';
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  // Not crypto.randomUUID: it exists only on https pages, and over plain http it threw before the app mounted.
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem(key, id);
  return id;
})();

function report(sessionId: string | null): Promise<Record<string, number> | null> {
  return fetch('/api/notifications/viewing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, sessionId }),
    keepalive: true,
  })
    .then((res) => (res.ok ? res.json() as Promise<{ clear?: Record<string, number> }> : null))
    .then((body) => body?.clear ?? null)
    .catch(() => null);
}

/**
 * Closes this device's notifications for conversations looked at since they
 * were sent, here or on any other device: the server says when each was last
 * looked at.
 */
async function closeSeen(clear: Record<string, number> | null, current: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  for (const note of await registration.getNotifications()) {
    const data = (note.data ?? {}) as { sessionId?: string; sentAt?: number };
    if (!data.sessionId) continue;
    const seenAt = data.sessionId === current ? Date.now() : clear?.[data.sessionId];
    if (seenAt !== undefined && (data.sentAt ?? 0) <= seenAt) note.close();
  }
}

/**
 * Tells the server which conversation this page shows while it is on screen,
 * so no device is notified about it, and clears notifications already seen.
 */
export function useViewingPresence(conversationId: string | undefined): void {
  useEffect(() => {
    if (!conversationId) return;
    let timer: ReturnType<typeof setInterval> | undefined;

    const onScreen = () => {
      void report(conversationId).then((clear) => closeSeen(clear, conversationId));
      clearInterval(timer);
      timer = setInterval(() => { void report(conversationId); }, REPORT_EVERY_MS);
    };
    const offScreen = () => {
      clearInterval(timer);
      void report(null);
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? onScreen() : offScreen());

    if (document.visibilityState === 'visible') onScreen();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', offScreen);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', offScreen);
      offScreen();
    };
  }, [conversationId]);
}
