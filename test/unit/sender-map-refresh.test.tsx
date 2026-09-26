// @vitest-environment happy-dom

/**
 * A message from a session we have not heard from before must resolve its name
 * when it arrives, not when some unrelated event happens next. Agent messages
 * reach an already-open recipient on the harness stream, which carries no
 * worker event and need not change the recipient's status — so the sender map
 * has to be keyed on the senders actually seen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWorkers } from '../../src/web/chat/hooks/useWorkers';

const getWorkers = vi.fn();
vi.mock('../../src/web/chat/services/api', () => ({
  api: { getWorkers: (id: string) => getWorkers(id) },
}));
// A stream that stays connected, so no reconnect adds refetches of its own.
const connectedStream = { connectionState: { status: 'connected', lastConnectedAt: new Date(0) } };
vi.mock('../../src/web/chat/contexts/ActivityStreamContext', () => ({
  useActivityStreamSubscription: () => {},
  useActivityStream: () => connectedStream,
}));

const reply = (senders: Record<string, { name: string; role: string }>) =>
  ({ workers: [], history: [], project: null, senders });

beforeEach(() => {
  getWorkers.mockReset();
  getWorkers.mockResolvedValue(reply({}));
});

describe('sender map refresh', () => {
  it('refetches when a peer never heard from before sends a message', async () => {
    const { rerender } = renderHook(
      ({ seen }) => useWorkers('conv-me', 1, 'ongoing', seen),
      { initialProps: { seen: '' } },
    );
    await waitFor(() => expect(getWorkers).toHaveBeenCalledTimes(1));

    // Same worker seq, same status: only the new sender differs.
    rerender({ seen: 'conv-peer' });
    await waitFor(() => expect(getWorkers).toHaveBeenCalledTimes(2));
  });

  it('exposes the resolved identity once the refetch lands', async () => {
    getWorkers.mockResolvedValue(
      reply({ 'conv-peer': { name: 'Widen the canary window', role: 'worker' } }),
    );
    const { result } = renderHook(() => useWorkers('conv-me', 1, 'ongoing', 'conv-peer'));
    await waitFor(() =>
      expect(result.current.senders['conv-peer']).toEqual({
        name: 'Widen the canary window',
        role: 'worker',
      }),
    );
  });

  it('does not refetch again while the same senders keep talking', async () => {
    const { rerender } = renderHook(
      ({ seen }) => useWorkers('conv-me', 1, 'ongoing', seen),
      { initialProps: { seen: 'conv-peer' } },
    );
    await waitFor(() => expect(getWorkers).toHaveBeenCalledTimes(1));
    rerender({ seen: 'conv-peer' });
    rerender({ seen: 'conv-peer' });
    expect(getWorkers).toHaveBeenCalledTimes(1);
  });

  it('settles rather than retrying when the server cannot name the sender', async () => {
    // The honest-fallback case: the map comes back without the id. The key has
    // already changed once, so nothing re-triggers and the raw id simply stands.
    const { rerender } = renderHook(
      ({ seen }) => useWorkers('conv-me', 1, 'ongoing', seen),
      { initialProps: { seen: '' } },
    );
    await waitFor(() => expect(getWorkers).toHaveBeenCalledTimes(1));
    rerender({ seen: 'conv-deleted' });
    await waitFor(() => expect(getWorkers).toHaveBeenCalledTimes(2));
    rerender({ seen: 'conv-deleted' });
    expect(getWorkers).toHaveBeenCalledTimes(2);
  });
});
