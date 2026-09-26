/**
 * Auto-dismisses transient network errors from the session error banner.
 *
 * When the browser resumes from sleep (mobile app switch, laptop lid open),
 * in-flight fetches fail with "Load failed" / "Failed to fetch". These errors
 * are transient — the network comes back in seconds — but the error banner
 * persists indefinitely because nothing clears session.error or
 * sessionFailureError for idle/completed sessions.
 *
 * This hook watches both error sources and auto-clears them after a delay
 * if they look like transient network errors.
 */
import { useEffect, useRef } from 'react';

const TRANSIENT_DISMISS_MS = 5_000;

const TRANSIENT_PATTERNS = [
  'Load failed',
  'Failed to fetch',
  'NetworkError',
  'network error',
  'Connection lost',
] as const;

export function isTransientNetworkError(error: string | null): boolean {
  if (!error) return false;
  return TRANSIENT_PATTERNS.some((pattern) => error.includes(pattern));
}

/**
 * If either error source contains a transient network error, schedule
 * a clear after TRANSIENT_DISMISS_MS.  Cancels if the error changes
 * or the component unmounts.
 */
export function useTransientErrorDismiss(params: {
  sessionError: string | null;
  sessionFailureError: string | null;
  clearSessionError: () => void;
  clearSessionFailureError: () => void;
}): void {
  const {
    sessionError,
    sessionFailureError,
    clearSessionError,
    clearSessionFailureError,
  } = params;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Clear previous timer on any change
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const shouldDismissSession = isTransientNetworkError(sessionError);
    const shouldDismissFailure = isTransientNetworkError(sessionFailureError);

    if (!shouldDismissSession && !shouldDismissFailure) return;

    timerRef.current = setTimeout(() => {
      if (shouldDismissSession) clearSessionError();
      if (shouldDismissFailure) clearSessionFailureError();
      timerRef.current = null;
    }, TRANSIENT_DISMISS_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [
    sessionError,
    sessionFailureError,
    clearSessionError,
    clearSessionFailureError,
  ]);
}
