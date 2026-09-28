// @vitest-environment happy-dom

/**
 * The panel's to-do list as drawn: the sections in their order, the last
 * completed thread under them, and a dismissal that says so in place with
 * Undo rather than making the row vanish. Which thread goes in which section
 * is pinned in state-of-play.test.ts; this is the rendering.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '../../src/web/chat/components/ui/tooltip.js';
import { foldProjectState, PROJECT_NOTED_EVENT, type ProjectEventLike, type ProjectNotedData } from '../../src/types/project-state.js';

const { StateOfPlaySection } = await import('../../src/web/chat/components/InsightsPanel/StateOfPlaySection.js');

let seq = 0;
function note(data: Partial<ProjectNotedData>): ProjectEventLike {
  seq += 1;
  return { seq, type: PROJECT_NOTED_EVENT, timestamp: seq, data: { text: '', by: 'coordinator', ...data } };
}

const project = foldProjectState([
  note({ kind: 'open', text: 'Release', owner: { kind: 'user' }, label: 'Publish 0.4.1?', }), // 1
  note({ kind: 'open', text: 'Queued idea', owner: { kind: 'coordinator' } }), // 2
  note({ kind: 'open', text: 'Scenes can be judged in context', owner: { kind: 'user' }, nextAction: 'Walk through the pack', waitingOn: { kind: 'decision', text: 'your notes on the pack' } }), // 3
  note({ kind: 'open', text: 'Finished earlier' }), // 4
  note({ kind: 'open', text: 'Finished last' }), // 5
  note({ kind: 'update', ref: 1, text: 'Built and checked on a clean machine; the changelog still names two fixes' }),
  note({ kind: 'close', text: 'done', ref: 4 }),
  note({ kind: 'close', text: 'done', ref: 5 }),
]);

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

describe('StateOfPlaySection', () => {
  it('draws Needs you before Next, and the last completed thread under them', () => {
    draw();
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Needs you')).toBeLessThan(text.indexOf('Next'));
    expect(screen.getByTestId('play-needs-you').textContent).toContain('Publish 0.4.1?');
    expect(screen.getByTestId('play-next').textContent).toContain('Queued idea');
    expect(screen.getByTestId('project-thread-done').textContent).toBe('Finished last');
  });

  it('says what an unlabelled Needs you item is asking for', () => {
    draw();
    expect(screen.getByTestId('play-needs-you').textContent).toContain('Waiting on your notes on the pack');
  });

  it('shows a labelled Needs you item as its ask alone, with the summary a tap away', () => {
    draw();
    const section = screen.getByTestId('play-needs-you');
    expect(section.textContent).not.toContain('Built and checked');
    fireEvent.click(screen.getByText('Publish 0.4.1?'));
    expect(screen.getByTestId('play-needs-you-detail').textContent).toBe('Built and checked on a clean machine; the changelog still names two fixes');
  });

  it('asks the server to dismiss, and keeps the row in place saying so, with Undo', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    draw();
    fireEvent.click(screen.getAllByTestId('play-dismiss')[0]);
    await waitFor(() => expect(screen.getByTestId('play-dismissed').textContent).toContain('Dismissed, moved to Parked'));
    expect(fetchMock).toHaveBeenCalledWith('/api/conv/conv-coord/project/threads/1/dismiss', { method: 'POST' });
    fireEvent.click(screen.getByTestId('play-undo'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/conv/conv-coord/project/threads/1/restore', { method: 'POST' }));
  });
});
