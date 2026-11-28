// @vitest-environment happy-dom

/**
 * Running's jobs as drawn from what the server counted (thread 38265): a job
 * is one Starting line until its first item, a count that can't be read says
 * why in full, a moving job gives its measured rate, a job whose process ended
 * short says where it stopped, and a jobs-changed frame for one of the
 * panel's sessions refetches the list at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '../../src/web/chat/components/ui/tooltip.js';
import type { JobProgress } from '../../src/services/sessions/job-progress.js';
import { foldProjectState, PROJECT_NOTED_EVENT, type ProjectNotedData } from '../../src/types/project-state.js';
import type { WorkerCardState } from '../../src/types/worker-events.js';

let frame: ((event: unknown) => void) | null = null;
vi.mock('../../src/web/chat/contexts/ActivityStreamContext.js', () => ({
  useActivityStreamSubscription: (_topic: unknown, callback: (event: unknown) => void) => { frame = callback; },
  useActivityStream: () => ({ isConnected: true, connectionState: { lastConnectedAt: null } }),
}));

const { NarrowPanel } = await import('../../src/web/chat/components/InsightsPanel/NarrowPanel.js');
const { StateOfPlaySection } = await import('../../src/web/chat/components/InsightsPanel/StateOfPlaySection.js');
const { jobStatus } = await import('../../src/web/chat/components/ConversationView/RunningJobsStrip.js');

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

describe('Running, for a lattice run job with no count', () => {
  const sweep = (over: Partial<JobProgress>): JobProgress => ({
    ...base, source: { kind: 'events' }, managed: true, label: 'Sweep finished', done: 0, total: 0,
    startedAt: now - 24 * MIN, movedAt: now - 24 * MIN, samples: [{ at: now - 24 * MIN, done: 0 }], ...over,
  });

  it('reads Running while its command prints and No output once it goes silent, never Starting', async () => {
    const served = [sweep({ lastOutputAt: now - MIN, stage: 'Run 2 of 3' }), sweep({ label: 'Quiet wait', lastOutputAt: now - 22 * MIN })];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jobs: served }), { status: 200 })));
    draw();
    const lines = await screen.findAllByTestId('panel-job-running');
    expect(lines.map((line) => line.textContent)).toEqual(['Quiet wait: no output for 22\u00a0min', 'Running: Sweep finished, 24\u00a0min']);
    expect(screen.getAllByTestId('panel-job').map((row) => row.getAttribute('data-job-state'))).toEqual(['silent', 'running']);
    expect(screen.getByTestId('panel-job-stage').textContent).toBe('Run 2 of 3');
    expect(screen.queryByTestId('panel-job-starting')).toBeNull();
  });

  it('says the same above the composer', () => {
    expect(jobStatus(sweep({ lastOutputAt: now - MIN }), now)).toEqual({ kind: 'plain', text: 'running, 24\u00a0min' });
    expect(jobStatus(sweep({ lastOutputAt: now - 22 * MIN }), now)).toEqual({ kind: 'caution', text: 'no output for 22\u00a0min' });
  });
});

describe('Running, for a worker whose thread waits', () => {
  const notes: Array<Partial<ProjectNotedData>> = [
    { kind: 'open', text: 'Frustration pilot', owner: { kind: 'worker', worker: 'conv-pilot' }, workers: ['conv-pilot'], waitingOn: { kind: 'resource', text: 'the daily model-call allowance to reset at midnight UTC' } }, // 1
    { kind: 'open', text: 'Finished study', owner: { kind: 'worker', worker: 'conv-closed' }, workers: ['conv-closed'] }, // 2
    { kind: 'close', text: 'done', ref: 2 }, // 3
    { kind: 'open', text: 'Panel rule', owner: { kind: 'user' }, workers: ['conv-yours'], waitingOn: { kind: 'decision', text: 'which rule the panel follows' } }, // 4
    { kind: 'open', text: 'Review', owner: { kind: 'coordinator' }, workers: ['conv-review'] }, // 5
  ];
  const project = foldProjectState(notes.map((data, index) => ({
    seq: index + 1, type: PROJECT_NOTED_EVENT, timestamp: index + 1, data: { text: '', by: 'coordinator', ...data },
  })));
  const reported = (id: string, thread: number | null): WorkerCardState => ({
    worker: id, provider: 'claude', model: null, task: `task of ${id}`, thread, startedAt: 0, phase: 'reported', question: null, since: 0,
    waitingOn: null, contextTokens: null, archived: false, reportReached: true, runtime: 'exited', activity: null,
  });

  it('keeps a reported worker while its open thread is held, with the hold as its wait, and drops one whose thread closed or that has none', async () => {
    render(
      <TooltipProvider>
        <StateOfPlaySection
          project={project}
          workers={[reported('conv-pilot', 1), reported('conv-closed', 2), reported('conv-loose', null)]}
          coordinatorId="conv-coord"
          coordinatorRunning={false}
        />
      </TooltipProvider>,
    );
    const rows = within(screen.getByTestId('panel-running')).getAllByTestId('worker-card');
    expect(rows.map((row) => row.getAttribute('data-worker'))).toEqual(['conv-pilot']);
    expect(within(rows[0]).getByTestId('worker-state').textContent).toBe('Waiting on the daily model-call allowance to reset at midnight UTC');
  });

  it('keeps a reported worker whose open thread waits on you, saying so, and one whose open thread waits on nothing, and opens either on a tap', async () => {
    const opened: string[] = [];
    render(
      <TooltipProvider>
        <StateOfPlaySection
          project={project}
          workers={[reported('conv-yours', 4), reported('conv-review', 5), reported('conv-closed', 2)]}
          coordinatorId="conv-coord"
          coordinatorRunning={false}
          onOpenWorker={(id) => opened.push(id)}
        />
      </TooltipProvider>,
    );
    const rows = within(screen.getByTestId('panel-running')).getAllByTestId('worker-card');
    expect(rows.map((row) => row.getAttribute('data-worker'))).toEqual(['conv-yours', 'conv-review']);
    expect(within(rows[0]).getByTestId('worker-state').textContent).toBe('Waiting on you');
    expect(within(rows[1]).getByTestId('worker-state').textContent).toBe('Reported');
    act(() => within(rows[0]).getAllByRole('button')[0].click());
    expect(opened).toEqual(['conv-yours']);
  });
});
