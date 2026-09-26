// @vitest-environment happy-dom

/*
 * Switching to a session remounts the conversation view, and the right-hand
 * panel used to start empty each time and wait for /workers: 0.4-1.7s on
 * real coordinators. A project seen before now shows its last
 * panel straight away, and the fetch that follows replaces it.
 */

import * as React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkersResponse } from '../../src/types/worker-events.js';

const getWorkers = vi.fn<(conversationId: string) => Promise<WorkersResponse>>();

vi.mock('../../src/web/chat/services/api.js', () => ({
  api: {
    getWorkers: (conversationId: string) => getWorkers(conversationId),
  },
}));

vi.mock('../../src/web/chat/contexts/ActivityStreamContext.js', () => ({
  useActivityStreamSubscription: () => undefined,
  useActivityStream: () => ({ connectionState: { lastConnectedAt: null } }),
}));

const { useWorkers } = await import('../../src/web/chat/hooks/useWorkers.js');

function roster(...tasks: string[]): WorkersResponse {
  return {
    workers: tasks.map((task) => ({ worker: `conv-${task}`, task })) as unknown as WorkersResponse['workers'],
    history: [],
    project: null,
    senders: {},
  };
}

function Panel({ id }: { id: string }): JSX.Element {
  const { workers } = useWorkers(id, 1, 'idle', '');
  return <div data-testid="tasks">{workers.map((worker) => worker.task).join(',')}</div>;
}

function deferred(): { promise: Promise<WorkersResponse>; resolve: (value: WorkersResponse) => void } {
  let resolve!: (value: WorkersResponse) => void;
  const promise = new Promise<WorkersResponse>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useWorkers on a session switch', () => {
  beforeEach(() => getWorkers.mockReset());

  it('shows the last panel seen for a project at once, then the fresh one', async () => {
    getWorkers.mockResolvedValueOnce(roster('first'));
    const first = render(<Panel id="conv-seen" />);
    await act(async () => {});
    expect(first.getByTestId('tasks').textContent).toBe('first');
    first.unmount();

    const pending = deferred();
    getWorkers.mockReturnValueOnce(pending.promise);
    const again = render(<Panel id="conv-seen" />);
    expect(again.getByTestId('tasks').textContent).toBe('first');

    await act(async () => pending.resolve(roster('first', 'second')));
    expect(again.getByTestId('tasks').textContent).toBe('first,second');
  });

  it('starts empty for a project not seen before', () => {
    getWorkers.mockReturnValueOnce(deferred().promise);
    const view = render(<Panel id="conv-new" />);
    expect(view.getByTestId('tasks').textContent).toBe('');
  });
});
