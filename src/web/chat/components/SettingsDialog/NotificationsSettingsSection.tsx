import { type JSX, useEffect, useState } from 'react';
import { api } from '../../services/api';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { Switch } from '../Feedback/FeedbackSettingsSection';

/** Settings → General: notifications on this device, which each device turns on for itself. */
export function NotificationsSettingsSection(): JSX.Element {
  const push = usePushNotifications();
  const [httpsUrl, setHttpsUrl] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const insecure = push.supportIssues.includes('insecure-context');

  useEffect(() => {
    if (!insecure) return;
    api.detectTailscale()
      .then((detected) => setHttpsUrl(detected.tailscaleServe?.command ? null : detected.tailscaleServe?.url ?? null))
      .catch(() => setHttpsUrl(null));
  }, [insecure]);

  const sendTest = async () => {
    setTestResult(null);
    const result = await push.sendTest();
    setTestResult(result ? `Sent to ${result.sent} device${result.sent === 1 ? '' : 's'}${result.failed ? `; ${result.failed} refused it, try again in a minute` : ''}.` : 'The test could not be sent.');
  };

  let reason: string | null = null;
  if (insecure) {
    reason = 'Only works on the secure (https) address.';
  } else if (push.supportIssues.includes('ios-home-screen-required')) {
    reason = 'On iPhone, add Lattice to your home screen first (Share → Add to Home Screen) and open it from there.';
  } else if (push.supportIssues.includes('missing-browser-apis')) {
    reason = 'This browser cannot show notifications from a web page.';
  } else if (push.permission === 'denied') {
    reason = 'Blocked in this browser. Allow notifications for Lattice in the browser’s site settings.';
  }

  return (
    <div className="border-t border-line pt-4 space-y-3" data-testid="notification-settings">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-fg-2">Notifications on this device</p>
          <p className="text-xs text-fg-3">
            When a session replies or an agent needs you.
          </p>
        </div>
        <Switch
          checked={push.subscribed}
          disabled={!push.supported || push.loading || push.permission === 'denied'}
          onChange={(next) => void (next ? push.subscribe() : push.unsubscribe())}
          label="Notifications on this device"
          testId="notifications-device-switch"
        />
      </div>
      {reason && <p className="text-xs text-fg-3">{reason}</p>}
      {insecure && httpsUrl && (
        <a href={`${httpsUrl}${window.location.pathname}`} className="ui-action-btn inline-block px-3 py-1.5 text-[13px] no-underline cursor-pointer">
          Open secure page
        </a>
      )}
      {push.subscribed && (
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => void sendTest()} className="ui-action-btn px-3 py-1.5 text-[13px] cursor-pointer">
            Send a test
          </button>
          {testResult && <span className="text-xs text-fg-3">{testResult}</span>}
        </div>
      )}
    </div>
  );
}
