/**
 * Lattice Service Worker - Handles push notifications
 */

/* eslint-disable no-restricted-globals */

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {
      title: 'Lattice',
      message: event.data.text(),
    };
  }

  const title = payload.title || 'Lattice';
  const options = {
    body: payload.message || '',
    icon: '/icon-192x192.png',
    badge: '/favicon.png',
    tag: payload.tag || 'lattice-notification',
    // Merge notifications with the same tag
    renotify: true,
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  let url = '/';

  // Navigate to the relevant session if we have one
  if (data.sessionId) {
    url = `/c/${data.sessionId}`;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus an existing Lattice window if one is open
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(url);
    })
  );
});
