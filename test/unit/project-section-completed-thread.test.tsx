// @vitest-environment happy-dom

/**
 * The right panel's task list only ever shrank: a thread the coordinator
 * closed just vanished, so the user could not see anything being checked off
 * (2026-09-21). The most recently closed thread now stays under the open
 * ones with its ring ticked.
 *
 * What is worth pinning is that it comes from the recorded state and not
 * from a timer or from worker reporting: it is the last entry of
 * `project.closed`, it survives a remount the same way the open list does,
 * and it is outside the three-open-tasks budget so it can neither push an
 * open task off the list nor change what "+ N more" counts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ProjectOpenThread, ProjectState } from '../../src/types/project-state.js';

const { ProjectSection } = await import(
  '../../src/web/chat/components/InsightsPanel/ProjectSection.js'
);

function thread(seq: number, text: string, closedAt?: number): ProjectOpenThread {
  return { seq, at: seq, updatedAt: closedAt ?? seq, text, events: [], workers: [], ...(closedAt ? { closedAt } : {}) };
}

function state(open: ProjectOpenThread[], closed: ProjectOpenThread[]): ProjectState {
  return {
    outcome: 'Make Lattice a clear, reliable workspace for ongoing projects',
    decisions: [], retired: [], priority: null, open, closed,
    attention: [], historical: [], accountingFrom: null, now: null, nudges: 0, revision: 0,
  };
}

afterEach(cleanup);

describe('ProjectSection completed thread', () => {
  it('shows the last thread the coordinator closed, not the first', () => {
    render(
      <ProjectSection
        project={state([thread(1, 'open one')], [thread(10, 'closed earlier', 100), thread(11, 'closed last', 200)])}
        coordinatorRunning={false}
      />
    );
    expect(screen.getByTestId('project-thread-done').textContent).toBe('closed last');
    expect(screen.queryByText('closed earlier')).toBeNull();
  });

  it('does not spend one of the three open slots or change what "+ N more" counts', () => {
    render(
      <ProjectSection
        project={state(
          [thread(1, 'open one'), thread(2, 'open two'), thread(3, 'open three'), thread(4, 'open four')],
          [thread(10, 'closed last', 200)]
        )}
        coordinatorRunning={false}
      />
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('open three')).toBeTruthy();
    expect(screen.queryByText('open four')).toBeNull();
    expect(screen.getByTestId('project-threads-toggle').textContent).toBe('+ 1 more');
    expect(screen.getByTestId('project-thread-done').textContent).toBe('closed last');
  });

  it('stays on screen as Recently completed when the last open thread is the one that was closed', () => {
    render(
      <ProjectSection project={state([], [thread(10, 'the last one', 200)])} coordinatorRunning={false} />
    );
    expect(screen.getByTestId('project-threads').textContent).toContain('Recently completed');
    expect(screen.queryByText('Still to do')).toBeNull();
    expect(screen.getByTestId('project-thread-done').textContent).toBe('the last one');
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.queryByTestId('project-threads-toggle')).toBeNull();
  });

  it('is still headed Still to do while any task remains', () => {
    render(
      <ProjectSection
        project={state([thread(1, 'open one')], [thread(10, 'closed last', 200)])}
        coordinatorRunning={false}
      />
    );
    expect(screen.getByText('Still to do')).toBeTruthy();
    expect(screen.queryByText('Recently completed')).toBeNull();
  });

  it('is absent until the coordinator has actually closed something', () => {
    render(<ProjectSection project={state([thread(1, 'open one')], [])} coordinatorRunning={false} />);
    expect(screen.queryByTestId('project-thread-done')).toBeNull();
  });

  it('comes back unchanged on a remount, because it is read from the state', () => {
    const project = state([thread(1, 'open one')], [thread(10, 'closed last', 200)]);
    const { unmount } = render(<ProjectSection project={project} coordinatorRunning={false} />);
    expect(screen.getByTestId('project-thread-done').textContent).toBe('closed last');
    unmount();
    render(<ProjectSection project={project} coordinatorRunning={false} />);
    expect(screen.getByTestId('project-thread-done').textContent).toBe('closed last');
  });
});
