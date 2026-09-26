/**
 * Resolved permission requests used to live for the life of the server
 * process: the expiry sweep only ever looked at pending entries, so every
 * approval or denial stayed in the Map with its full toolInput attached.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionTracker } from '../../src/services/permission-tracker.js';

const MINUTE = 60_000;

describe('PermissionTracker resolved-request eviction', () => {
  let tracker: PermissionTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    tracker = new PermissionTracker();
  });

  afterEach(() => {
    tracker.stopExpiryCheck();
    tracker.clear();
    vi.useRealTimers();
  });

  it('keeps a resolved request queryable inside the retention window', () => {
    const request = tracker.addPermissionRequest('Bash', { command: 'ls' }, 'stream-1');
    expect(tracker.updatePermissionStatus(request.id, 'approved')).toBe(true);

    vi.setSystemTime(Date.now() + 5 * MINUTE);
    tracker.runExpirySweep();

    expect(tracker.getPermissionRequest(request.id)?.status).toBe('approved');
    expect(tracker.size()).toBe(1);
  });

  it('evicts approved and denied requests once the retention window passes', () => {
    const approved = tracker.addPermissionRequest('Bash', { command: 'ls' }, 'stream-1');
    const denied = tracker.addPermissionRequest('Write', { path: '/tmp/x' }, 'stream-1');
    tracker.updatePermissionStatus(approved.id, 'approved');
    tracker.updatePermissionStatus(denied.id, 'denied', { denyReason: 'nope' });
    expect(tracker.size()).toBe(2);

    vi.setSystemTime(Date.now() + 11 * MINUTE);
    tracker.runExpirySweep();

    expect(tracker.getPermissionRequest(approved.id)).toBeUndefined();
    expect(tracker.getPermissionRequest(denied.id)).toBeUndefined();
    expect(tracker.size()).toBe(0);
  });

  it('leaves pending requests alone until the hook timeout, then auto-denies as before', () => {
    const request = tracker.addPermissionRequest('Bash', { command: 'sleep 1' }, 'stream-1');

    // 9 minutes is inside the 605s hook timeout: untouched, still pending.
    vi.setSystemTime(Date.now() + 9 * MINUTE);
    tracker.runExpirySweep();
    expect(tracker.getPermissionRequest(request.id)?.status).toBe('pending');

    const updates: Array<{ id: string; status: string }> = [];
    tracker.on('permission_updated', (updated: { id: string; status: string }) => {
      updates.push({ id: updated.id, status: updated.status });
    });

    // Past 605s: the pre-existing auto-deny path fires and removes the entry.
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    tracker.runExpirySweep();

    expect(updates).toEqual([{ id: request.id, status: 'denied' }]);
    expect(tracker.getPermissionRequest(request.id)).toBeUndefined();
  });

  it('does not evict a request that has not been resolved yet, however old the sweep', () => {
    const request = tracker.addPermissionRequest('Bash', { command: 'ls' }, 'stream-1');
    tracker.updatePermissionStatus(request.id, 'approved');

    // Sweeping repeatedly inside the window must not lose the entry.
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + MINUTE);
      tracker.runExpirySweep();
    }
    expect(tracker.size()).toBe(1);

    vi.setSystemTime(Date.now() + 6 * MINUTE);
    tracker.runExpirySweep();
    expect(tracker.size()).toBe(0);
  });

  it('drops the resolution stamp alongside the request on streaming-id cleanup', () => {
    const request = tracker.addPermissionRequest('Bash', { command: 'ls' }, 'stream-9');
    tracker.updatePermissionStatus(request.id, 'approved');

    expect(tracker.removePermissionsByStreamingId('stream-9')).toBe(1);
    expect(tracker.size()).toBe(0);

    // A later sweep has nothing to do and must not throw on the orphan stamp.
    vi.setSystemTime(Date.now() + 20 * MINUTE);
    expect(() => tracker.runExpirySweep()).not.toThrow();
  });
});
