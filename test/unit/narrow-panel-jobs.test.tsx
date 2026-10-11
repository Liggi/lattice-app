// @vitest-environment happy-dom

/**
 * Running's jobs as drawn from what the server counted (thread 38265): a job
 * is one Starting line until its first item, a count that can't be read says
 * why in full, a moving job gives its measured rate, a job whose process ended
 * short says where it stopped, and a jobs-changed frame for one of the
 * panel's sessions refetches the list at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '../../src/web/chat/components/ui/tooltip.js';
import type { JobProgress } from '../../src/services/sessions/job-progress.js';

let frame: ((event: unknown) => void) | null = null;
vi.mock('../../src/web/chat/contexts/ActivityStreamContext.js', () => ({
  useActivityStreamSubscription: (_topic: unknown, callback: (event: unknown) => void) => { frame = callback; },
  useActivityStream: () => ({ isConnected: true, connectionState: { lastConnectedAt: null } }),
}));

const { NarrowPanel } = await import('../../src/web/chat/components/InsightsPanel/NarrowPanel.js');

const MIN = 60_000;
const now = Date.now();
const base = { session: 'conv-coord', source: { kind: 'files' as const, glob: '/x/*' }, startDone: 0, reportedAt: now };

const jobs: JobProgress[] = [
  { ...base, label: 'Culture briefs', done: 0, total: 11, startedAt: now - 4 * MIN, movedAt: now - 4 * MIN, samples: [{ at: now - 4 * MIN, done: 0 }] },
  {
    ...base, label: 'Heritages with final mottos', done: 30, total: 58, startedAt: now - 20 * MIN, movedAt: now - MIN,
    samples: [{ at: now - 20 * MIN, done: 0 }, { at: now - 11 * MIN, done: 10 }, { at: now - MIN, done: 30 }],
  },
  {
    ...base, label: 'Game years', done: 4, total: 20, startedAt: now - 9 * MIN, movedAt: now - 5 * MIN, samples: [{ at: now - 9 * MIN, done: 0 }, { at: now - 5 * MIN, done: 4 }],
    readError: { message: 'the command exited with code 1: ssh: connect to host 100.87.153.27 port 22: Operation timed out', since: now - 2 * MIN, failures: 3 },
  },
  { ...base, label: 'Contract events banked', done: 116, total: 180, startedAt: now - 30 * MIN, movedAt: now - 3 * MIN, stopped: 'Its process ended before the count reached the total' },
  { ...base, label: 'Thin mottos: heritages checked', done: 1, total: 59, startedAt: now - 60 * MIN, movedAt: now - 50 * MIN, stopped: 'worker finished its work without closing this job' },
];

let fetches = 0;
beforeEach(() => {
  fetches = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!String(url).endsWith('/jobs')) return new Response('', { status: 404 });
    fetches += 1;
    return new Response(JSON.stringify({ jobs }), { status: 200 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function draw() {
  return render(
    <TooltipProvider>
      <NarrowPanel coordinatorId="conv-coord" attention={[]} workers={[]} coordinatorRunning={false} renderWorker={() => null} />
    </TooltipProvider>,
  );
}

describe('Running, counted from the work', () => {
  it('draws each job as far as the server has counted it', async () => {
    draw();
    expect((await screen.findByText(/^Starting: Culture briefs/)).textContent).toBe('Starting: Culture briefs, 4\u00a0min');
    expect(screen.getByTestId('panel-job-pace').textContent).toBe('2 a minute, about 13 min left');
    expect(screen.getByTestId('panel-job-unreadable').textContent).toBe(
      "Can't read the count: the command exited with code 1: ssh: connect to host 100.87.153.27 port 22: Operation timed out",
    );
    expect(screen.getAllByTestId('panel-job-stopped').map((item) => item.textContent)).toEqual([
      'Stopped at 116 of 180 when its process ended.',
      'Stopped at 1 of 59. Worker finished its work without closing this job.',
    ]);
  });

  it('refetches when the server says one of its sessions\' jobs changed, and not for another project', async () => {
    draw();
    await waitFor(() => expect(fetches).toBe(1));
    act(() => frame?.({ type: 'jobs-changed', sessionId: 'conv-elsewhere' }));
    act(() => frame?.({ type: 'jobs-changed', sessionId: 'conv-coord' }));
    await waitFor(() => expect(fetches).toBe(2));
  });
});
