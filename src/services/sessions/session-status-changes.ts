/**
 * Pushes "this session's status changed" for the status fields that no
 * start/idle/end push covers: compacting, armed work (Waiting), and a
 * project's asks. The activity stream forwards each as
 * `session-status-changed` and the client refetches /api/sessions/status, so
 * those fields update as fast as running and idle do instead of on the next
 * 30s poll.
 */

import { EventEmitter } from 'events';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function noteStatusChanged(sessionId: string): void {
  emitter.emit('changed', sessionId);
}

export function onStatusChanged(listener: (sessionId: string) => void): () => void {
  emitter.on('changed', listener);
  return () => { emitter.off('changed', listener); };
}
