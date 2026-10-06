/**
 * A process's events go to the server that owns it; while that server is
 * gone they are kept, and the next server to attach receives them in order,
 * then any permission request nobody answered.
 */

import { describe, expect, it } from 'vitest';
import { HeldStreams } from '../../src/process-daemon/held-streams.js';
import type { IPCEvent } from '../../src/process-daemon/types.js';

const msg = (n: number): IPCEvent => ({ event: 'claude-message', data: { streamingId: 's1', message: { n } } });
const control = (requestId: string): IPCEvent => ({ event: 'claude-control-request', data: { streamingId: 's1', requestId } });

describe('held streams', () => {
  it('routes to the owner, keeps events while it is gone, and replays them to the next server', () => {
    const connected = new Set(['old']);
    const streams = new HeldStreams<string>((c) => connected.has(c));
    streams.own('s1', 'old', 'conv-a');

    expect(streams.route('s1', msg(1))).toBe('old');
    expect(streams.route('s1', control('answered'))).toBe('old');
    expect(streams.route('s1', control('open'))).toBe('old');
    streams.answered('s1', 'answered');

    connected.delete('old');
    expect(streams.route('s1', msg(2))).toBeNull();
    expect(streams.route('s1', msg(3))).toBeNull();

    connected.add('new');
    // A server connecting does not take the process's events until it attaches.
    expect(streams.route('s1', msg(4))).toBeNull();
    const attached = streams.attach('s1', 'new')!;
    expect(attached.events).toEqual([msg(2), msg(3), msg(4), control('open')]);
    expect(streams.route('s1', msg(5))).toBe('new');
    expect(streams.conversationId('s1')).toBe('conv-a');
  });

  it('keeps an exit nobody heard for the next server, and forgets it once collected', () => {
    const connected = new Set<string>();
    const streams = new HeldStreams<string>((c) => connected.has(c));
    streams.own('s1', 'old', 'conv-a');
    const closed: IPCEvent = { event: 'process-closed', data: { streamingId: 's1', code: 0 } };
    streams.route('s1', msg(1));
    streams.route('s1', closed);
    expect(streams.exitedWaiting()).toEqual(['s1']);

    connected.add('new');
    expect(streams.attach('s1', 'new')!.events).toEqual([msg(1), closed]);
    expect(streams.has('s1')).toBe(false);
    expect(streams.attach('s1', 'new')).toBeNull();
  });
});
