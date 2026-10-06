/**
 * Keeping a process's events for the server that takes it over.
 *
 * Each Claude process belongs to the server connection that spawned it, or
 * the one that last attached to it, and its events go to that connection
 * alone: a server that connects while another owns the process does not get
 * them twice, once live and once replayed. While that connection is gone (the
 * server restarting) the process runs on and its events are kept here; the
 * next server attaches and receives them in order, followed by any
 * permission request still waiting on an answer, which the previous server
 * may have received and never answered. A process that exits while nobody
 * is attached is kept for a while, so its last events and its exit still
 * reach the next server.
 */

import type { IPCEvent } from './types.js';

/** Events kept per process while no server is attached; the oldest go first beyond it. */
const HELD_EVENTS_MAX = 20_000;
/** How long an exited process nobody attached to is kept for the next server. */
export const RETIRED_KEEP_MS = 10 * 60_000;

interface Stream<Conn> {
  owner: Conn | null;
  held: IPCEvent[];
  dropped: number;
  /** Permission requests forwarded and not yet answered, by request id. */
  pendingControl: Map<string, IPCEvent>;
  conversationId: string | null;
  exited: boolean;
}

export interface AttachResult {
  events: IPCEvent[];
  /** Events dropped because more were kept than the limit. */
  dropped: number;
}

export class HeldStreams<Conn> {
  private streams = new Map<string, Stream<Conn>>();

  constructor(private isConnected: (conn: Conn) => boolean) {}

  /** A process was spawned for this connection. */
  own(streamingId: string, owner: Conn | null, conversationId: string | null): void {
    this.streams.set(streamingId, { owner, held: [], dropped: 0, pendingControl: new Map(), conversationId, exited: false });
  }

  /** Whether events for this process are routed here rather than broadcast. */
  has(streamingId: string): boolean {
    return this.streams.has(streamingId);
  }

  /**
   * Route a process's event: returns the connection to send it to, or null
   * when its owner is gone and the event is kept for the next one instead.
   */
  route(streamingId: string, event: IPCEvent): Conn | null {
    const stream = this.streams.get(streamingId);
    if (!stream) return null;
    if (event.event === 'claude-control-request') {
      const requestId = (event.data as { requestId?: string }).requestId;
      if (requestId) stream.pendingControl.set(requestId, event);
    }
    if (event.event === 'process-closed' || event.event === 'process-error') {
      stream.exited = true;
      stream.pendingControl.clear();
      if (stream.owner && this.isConnected(stream.owner)) {
        this.streams.delete(streamingId);
        return stream.owner;
      }
      setTimeout(() => {
        if (this.streams.get(streamingId) === stream) this.streams.delete(streamingId);
      }, RETIRED_KEEP_MS).unref();
    }
    if (stream.owner && this.isConnected(stream.owner)) return stream.owner;
    stream.held.push(event);
    if (stream.held.length > HELD_EVENTS_MAX) {
      stream.held.shift();
      stream.dropped += 1;
    }
    return null;
  }

  answered(streamingId: string, requestId: string): void {
    this.streams.get(streamingId)?.pendingControl.delete(requestId);
  }

  /** Make `conn` the process's owner and hand it what it missed. Null for a process not kept here. */
  attach(streamingId: string, conn: Conn): AttachResult | null {
    const stream = this.streams.get(streamingId);
    if (!stream) return null;
    const heldControl = new Set(stream.held.filter((e) => e.event === 'claude-control-request').map((e) => (e.data as { requestId?: string }).requestId));
    const unanswered = [...stream.pendingControl.entries()].filter(([id]) => !heldControl.has(id)).map(([, e]) => e);
    const result = { events: [...stream.held, ...unanswered], dropped: stream.dropped };
    stream.owner = conn;
    stream.held = [];
    stream.dropped = 0;
    if (stream.exited) this.streams.delete(streamingId);
    return result;
  }

  /** Whether an exited process's events are still waiting for a server. */
  waitingForServer(streamingId: string): boolean {
    const stream = this.streams.get(streamingId);
    return !!stream && !(stream.owner && this.isConnected(stream.owner));
  }

  conversationId(streamingId: string): string | null {
    return this.streams.get(streamingId)?.conversationId ?? null;
  }

  /** Exited processes still kept for the next server. */
  exitedWaiting(): string[] {
    return [...this.streams.entries()].filter(([id, s]) => s.exited && this.waitingForServer(id)).map(([id]) => id);
  }
}
