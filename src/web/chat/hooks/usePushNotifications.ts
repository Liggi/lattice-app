import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

export type PushSupportIssue =
  | 'ios-home-screen-required'
  | 'insecure-context'
  | 'missing-browser-apis';

interface PushStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  loading: boolean;
  publicKey: string | null;
  supportIssues: PushSupportIssue[];
}

interface UsePushNotificationsResult extends PushStatus {
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<boolean>;
  sendTest: () => Promise<{ success: boolean; sent: number; failed: number } | null>;
  refresh: () => Promise<void>;
}

/**
 * Convert a base64-encoded VAPID key to a Uint8Array for the Push API
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function isIOSBrowser(): boolean {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandaloneDisplayMode(): boolean {
  const standaloneByMedia = typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches;
  const standaloneByNavigator = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return standaloneByMedia || standaloneByNavigator;
}

export function usePushNotifications(): UsePushNotificationsResult {
  const [status, setStatus] = useState<PushStatus>({
    supported: false,
    permission: 'unsupported',
    subscribed: false,
    loading: true,
    publicKey: null,
    supportIssues: [],
  });

  const refresh = useCallback(async () => {
    const supportIssues: PushSupportIssue[] = [];
    const hasServiceWorker = 'serviceWorker' in navigator;
    const hasPushManager = 'PushManager' in window;
    const hasNotification = 'Notification' in window;
    const secureContext = window.isSecureContext;
    const iosBrowser = isIOSBrowser();
    const standalone = isStandaloneDisplayMode();

    if (!secureContext) {
      supportIssues.push('insecure-context');
    }
    if (iosBrowser && !standalone) {
      supportIssues.push('ios-home-screen-required');
    }
    if (!hasServiceWorker || !hasPushManager || !hasNotification) {
      supportIssues.push('missing-browser-apis');
    }

    const supported = supportIssues.length === 0;
    if (!supported) {
      setStatus({
        supported: false,
        permission: 'unsupported',
        subscribed: false,
        loading: false,
        publicKey: null,
        supportIssues,
      });
      return;
    }

    try {
      const serverStatus = await api.getWebPushStatus();
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      setStatus({
        supported: true,
        permission: Notification.permission,
        subscribed: !!subscription,
        loading: false,
        publicKey: serverStatus.publicKey || null,
        supportIssues: [],
      });
    } catch {
      setStatus(prev => ({ ...prev, supported: true, loading: false, supportIssues: [] }));
    }
  }, []);

  // Check current state on mount
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!status.supported || !status.publicKey) return false;

    setStatus(prev => ({ ...prev, loading: true }));

    try {
      // Request notification permission
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(prev => ({ ...prev, permission, loading: false }));
        return false;
      }

      // Get service worker registration
      const registration = await navigator.serviceWorker.ready;

      // Subscribe to push
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.publicKey!) as BufferSource,
      });

      // Register with backend
      await api.registerWebPush(subscription);

      setStatus(prev => ({
        ...prev,
        permission: 'granted',
        subscribed: true,
        loading: false,
      }));

      return true;
    } catch (err) {
      console.error('Push subscription failed:', err);
      setStatus(prev => ({ ...prev, loading: false }));
      return false;
    }
  }, [status.supported, status.publicKey]);

  const unsubscribe = useCallback(async (): Promise<boolean> => {
    setStatus(prev => ({ ...prev, loading: true }));

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        // Unregister from backend
        await api.unregisterWebPush(subscription.endpoint);
        // Unsubscribe locally
        await subscription.unsubscribe();
      }

      setStatus(prev => ({ ...prev, subscribed: false, loading: false }));
      return true;
    } catch (err) {
      console.error('Push unsubscribe failed:', err);
      setStatus(prev => ({ ...prev, loading: false }));
      return false;
    }
  }, []);

  const sendTest = useCallback(async () => {
    try {
      return await api.sendTestNotification();
    } catch (err) {
      console.error('Test notification failed:', err);
      return null;
    }
  }, []);

  return {
    ...status,
    subscribe,
    unsubscribe,
    sendTest,
    refresh,
  };
}
