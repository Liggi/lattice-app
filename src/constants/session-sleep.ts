/**
 * Quiet for longer than this, a session or project is Sleeping rather than
 * Idle. The sidebar reads it for the Idle/Sleeping split; the server's
 * auto-archive archives a session a week after it falls asleep.
 */
export const SLEEP_AFTER_MS = 3 * 60 * 60 * 1000;
