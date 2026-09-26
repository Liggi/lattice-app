import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/index.css'
import App from './App'
import { installBrowserConsoleCapture, installBrowserIncidentCapture, sendBrowserIncident } from './chat/services/browser-incidents'

// Auto-reload on stale chunk errors (after builds swap dist/, old chunk hashes 404).
// Dynamic import failures surface as unhandled rejections, not error events.
function handleStaleChunkError(message: string): void {
  if (!message.includes('dynamically imported module') &&
      !message.includes('Failed to fetch dynamically imported module') &&
      !message.includes('Loading chunk')) return;
  const reloadKey = 'lattice:chunk-reload';
  const lastReload = sessionStorage.getItem(reloadKey);
  // Prevent reload loops — only auto-reload once per 30s
  if (!lastReload || Date.now() - Number(lastReload) > 30_000) {
    sessionStorage.setItem(reloadKey, String(Date.now()));
    window.location.reload();
  }
}
window.addEventListener('error', (e) => handleStaleChunkError(e.message ?? ''));
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? '');
  handleStaleChunkError(msg);
});
installBrowserIncidentCapture();
installBrowserConsoleCapture();

// Force dark mode - light mode not supported
document.documentElement.setAttribute('data-theme', 'dark');
document.documentElement.classList.add('dark');

// Mark browser vs standalone display mode for CSS safe-area behavior.
// iOS Home Screen apps can report standalone via either media query or navigator.standalone.
const standaloneByMedia = typeof window.matchMedia === 'function'
  && window.matchMedia('(display-mode: standalone)').matches;
const standaloneByNavigator = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
document.documentElement.setAttribute(
  'data-display-mode',
  standaloneByMedia || standaloneByNavigator ? 'standalone' : 'browser'
);


ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Register service worker for push notifications
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('Service worker registration failed:', err);
    sendBrowserIncident({
      type: 'service-worker-registration-failed',
      severity: 'warn',
      message: err instanceof Error ? err.message : String(err),
    });
  });
}
