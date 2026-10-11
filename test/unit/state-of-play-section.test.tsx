// @vitest-environment happy-dom

/**
 * The panel as drawn: Your calls first, each row its short name over its ask,
 * fading with age; a row opens in place to be answered, and parking says so
 * in place with Undo. Which call is listed, and how it fades, is pinned in
 * your-calls.test.ts; this is the rendering.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '../../src/web/chat/components/ui/tooltip.js';
import { foldProjectState, PROJECT_NOTED_EVENT, type ProjectEventLike, type ProjectNotedData } from '../../src/types/project-state.js';

// Running's jobs are refetched on the activity stream's jobs-changed frames; no stream here.
vi.mock('../../src/web/chat/contexts/ActivityStreamContext.js', () => ({
  useActivityStreamSubscription: () => undefined,
  useActivityStream: () => ({ isConnected: false, connectionState: { lastConnectedAt: null } }),
}));

const { StateOfPlaySection } = await import('../../src/web/chat/components/InsightsPanel/StateOfPlaySection.js');

const HOUR = 60 * 60 * 1000;
let seq = 0;
function note(data: Partial<ProjectNotedData>, ago: number): ProjectEventLike {
  seq += 1;
  return { seq, type: PROJECT_NOTED_EVENT, timestamp: Date.now() - ago, data: { text: '', by: 'coordinator', ...data } };
}

const project = foldProjectState([
  note({ kind: 'open', text: 'Ship 0.4.1', name: 'Release', owner: { kind: 'user' }, label: 'Publish 0.4.1?' }, 0.1 * HOUR), // 1
  note({ kind: 'open', text: 'Queued idea', owner: { kind: 'coordinator' } }, HOUR), // 2
  note({ kind: 'open', text: 'Scenes can be judged in context', owner: { kind: 'user' }, waitingOn: { kind: 'decision', text: 'your notes on the pack' } }, 2 * HOUR), // 3
  note({ kind: 'open', text: 'Darker sidebar', name: 'Darker sidebar', owner: { kind: 'user' }, label: 'Approve the shade?' }, 10 * HOUR), // 4
  note({ kind: 'open', text: 'Old theme', name: 'Old theme cleanup', owner: { kind: 'user' }, label: 'Delete it?' }, 30 * HOUR), // 5
  note({ kind: 'update', ref: 1, text: 'Built and checked on a clean machine' }, 0.1 * HOUR),
]);

// The panel also asks for running jobs and pull requests; nothing answers here.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function draw() {
  return render(
    <TooltipProvider>
      <StateOfPlaySection project={project} workers={[]} coordinatorId="conv-coord" coordinatorRunning={false} />
    </TooltipProvider>,
  );
}

const section = () => screen.getByTestId('play-needs-you');

describe('StateOfPlaySection', () => {
  it('lists Your calls first, each by name over its ask, and leaves queued work out', () => {
    draw();
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Your calls')).toBeLessThan(text.indexOf('Running'));
    const first = section().querySelector('[data-testid="call-row"]')!;
    expect(first.textContent).toMatch(/^Release\d+mPublish 0\.4\.1\?/);
    expect(section().textContent).toContain('Waiting on your notes on the pack');
    expect(text).not.toContain('Queued idea');
  });

  it('shows a call over eight hours old by name alone, and drops one over a day old', () => {
    draw();
    expect(section().textContent).toContain('Darker sidebar');
    expect(section().textContent).not.toContain('Approve the shade?');
    expect(section().textContent).not.toContain('Old theme cleanup');
  });

  it('opens a row in place with the thread as its briefing, and closes it on Escape', () => {
    draw();
    fireEvent.click(within(section()).getByText('Release'));
    const open = section().querySelector('[data-open]') as HTMLElement;
    fireEvent.click(within(open).getByTestId('call-brief-toggle'));
    expect(within(open).getByTestId('call-brief').textContent).toContain('Built and checked on a clean machine');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(section().querySelector('[data-open]')).toBeNull();
  });

  it('holds a reply in the user\'s own words for the thread', async () => {
    const fetchMock = vi.fn(async () => new Response('{"id":"r1","until":0}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    draw();
    fireEvent.click(within(section()).getByText('Release'));
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Ship it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/conv/conv-coord/project/replies', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ target: { kind: 'thread', thread: 1 }, text: 'Ship it' }),
    })));
  });

  it('parks a call, keeps its place saying so, and brings it back with Undo', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    draw();
    fireEvent.click(within(section()).getAllByTestId('call-park')[0]);
    await waitFor(() => expect(screen.getByTestId('call-gone').textContent).toContain('parked'));
    expect(fetchMock).toHaveBeenCalledWith('/api/conv/conv-coord/project/threads/1/park', { method: 'POST' });
    fireEvent.click(screen.getByTestId('call-gone-undo'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/conv/conv-coord/project/threads/1/restore', { method: 'POST' }));
  });
});
