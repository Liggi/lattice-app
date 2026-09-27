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

/**
 * A turn began that no provider event announces: a message delivered into a
 * running turn that the provider then started as a turn of its own (the
 * `input:incorporated` with `where: 'next-turn'`, appended by the server, not
 * the provider). Harness setup forwards this to the registry's session-started
 * push, so the sidebar shows the turn and its end pushes idle again.
 */
export function noteTurnStarted(sessionId: string): void {
  emitter.emit('turn-started', sessionId);
}

export function onTurnStarted(listener: (sessionId: string) => void): () => void {
  emitter.on('turn-started', listener);
  return () => { emitter.off('turn-started', listener); };
}
