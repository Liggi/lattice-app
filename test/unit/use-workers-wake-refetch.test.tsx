// @vitest-environment happy-dom

/*
 * Regression guard for a worker card that goes on saying Working after the
 * worker has stopped.
 *
 * The panel used to refetch only when a frame arrived: a coordinator event, a
 * status change, or the server's worker-activity push. Those are pushes on a
 * live stream, and a phone drops the stream every time it sleeps. A worker
 * stopping during that gap rings a bell nobody hears, and nothing asks the
 * endpoint again — reproduced on the trial at phone width on 2026-09-21, where
 * a card read "Working · Polling the health endpoint" for a worker the
 * endpoint had already reported idle.
 *
 * So the hook also refetches when the stream connects and when the page
 * becomes visible. These tests assert on fetch counts, which is what was
 * broken.
 */

import * as React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkersResponse } from '../../src/types/worker-events.js';

const getWorkers = vi.fn<(conversationId: string) => Promise<WorkersResponse>>();

vi.mock('../../src/web/chat/services/api.js', () => ({
  api: {
    getWorkers: (conversationId: string) => getWorkers(conversationId),
  },
}));

let connectedAt: Date | null = new Date(1_000);

vi.mock('../../src/web/chat/contexts/ActivityStreamContext.js', () => ({
  useActivityStreamSubscription: () => undefined,
  useActivityStream: () => ({ connectionState: { lastConnectedAt: connectedAt } }),
}));

const { useWorkers } = await import('../../src/web/chat/hooks/useWorkers.js');

const EMPTY_RESPONSE: WorkersResponse = { workers: [], history: [], project: null, senders: {} };

function Harness(): JSX.Element {
  const { workers } = useWorkers('conv-coordinator', 1, 'idle', '');
  return <div data-testid="count">{workers.length}</div>;
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useWorkers freshness after a gap in the stream', () => {
  beforeEach(() => {
    connectedAt = new Date(1_000);
    getWorkers.mockReset();
    getWorkers.mockImplementation(() => Promise.resolve(EMPTY_RESPONSE));
  });

  afterEach(() => {
    vi.clearAllMocks();
    setVisibility('visible');
  });

  it('refetches when the activity stream reconnects', async () => {
    const view = render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    expect(getWorkers).toHaveBeenCalledTimes(1);

    // The stream came back: whatever it pushed during the gap is lost.
    connectedAt = new Date(2_000);
    await act(async () => {
      view.rerender(<Harness />);
      await Promise.resolve();
    });

    expect(getWorkers).toHaveBeenCalledTimes(2);
  });

  it('refetches when the page becomes visible again', async () => {
    render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    expect(getWorkers).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility('hidden');
      await Promise.resolve();
    });
    expect(getWorkers).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility('visible');
      await Promise.resolve();
    });

    expect(getWorkers).toHaveBeenCalledTimes(2);
  });

  it('does not refetch while nothing has changed', async () => {
    const view = render(<Harness />);
    await act(async () => { await Promise.resolve(); });

    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        view.rerender(<Harness />);
        await Promise.resolve();
      });
    }

    expect(getWorkers).toHaveBeenCalledTimes(1);
  });
});
