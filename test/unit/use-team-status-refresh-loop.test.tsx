// @vitest-environment happy-dom

/*
 * Regression guard for the useTeamStatus back-to-back fetch loop.
 *
 * The hook takes a `conversations` array and refreshes one /team-info request per
 * distinct team name. Every real caller passes a freshly derived array (filtered and
 * sorted conversations), so memoizing the tracked-name list on `conversations`
 * identity never hit: the refresh effect re-fired on every render, each response set
 * state, and that re-render fired the effect again — a permanent request loop.
 *
 * The fix collapses the names to a stable string key first. These tests assert on
 * request counts, which is the thing that was actually broken.
 */

import * as React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamInfoResponse } from '../../src/web/chat/services/api/types.js';
import type { UnifiedConversationSummary } from '../../src/web/chat/types/index.js';

const getTeamInfo = vi.fn<(teamName: string) => Promise<TeamInfoResponse>>();

vi.mock('../../src/web/chat/services/api.js', () => ({
  api: {
    getTeamInfo: (teamName: string) => getTeamInfo(teamName),
  },
}));

// The hook subscribes to the SSE activity stream; transport is not what's under test.
vi.mock('../../src/web/chat/contexts/ActivityStreamContext.js', () => ({
  useActivityStreamSubscription: () => undefined,
}));

const { useTeamStatus } = await import('../../src/web/chat/hooks/useTeamStatus.js');

function teamInfo(teamName: string): TeamInfoResponse {
  return {
    teamName,
    leadSessionId: `conv-lead-${teamName}`,
    memberCount: 1,
    tasks: { pending: 0, in_progress: 1, completed: 0 },
    config: {
      name: teamName,
      createdAt: 0,
      leadAgentId: 'lead',
      leadSessionId: `conv-lead-${teamName}`,
      members: [
        { name: 'lead', agentType: 'team-lead' },
        { name: 'worker', agentType: 'worker' },
      ] as TeamInfoResponse['config']['members'],
    },
    timestamp: 1,
  };
}

function conversation(id: string, teamName: string | null): UnifiedConversationSummary {
  return { conversationId: id, teamName, archived: false } as unknown as UnifiedConversationSummary;
}

/**
 * Stands in for CrossSessionSidebar: derives a brand-new array on every render and
 * hands it to the hook, exactly as the real caller does.
 */
let renderCount = 0;
let forceRender: (() => void) | null = null;

function Harness({ source }: { source: UnifiedConversationSummary[] }): JSX.Element {
  const [, setTick] = React.useState(0);
  forceRender = () => setTick((t) => t + 1);
  renderCount += 1;
  const derived = source.filter((c) => !c.archived).sort((a, b) => a.conversationId.localeCompare(b.conversationId));
  const { teamStatuses } = useTeamStatus(derived);
  return <div data-testid="teams">{Object.keys(teamStatuses).sort().join(',')}</div>;
}

describe('useTeamStatus request cadence', () => {
  beforeEach(() => {
    renderCount = 0;
    forceRender = null;
    getTeamInfo.mockReset();
    getTeamInfo.mockImplementation((teamName: string) => Promise.resolve(teamInfo(teamName)));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches once per team even though the caller passes a new array every render', async () => {
    const source = [conversation('conv-a', 'alpha'), conversation('conv-b', 'beta')];

    const view = render(<Harness source={source} />);
    await act(async () => { await Promise.resolve(); });

    expect(getTeamInfo).toHaveBeenCalledTimes(2);
    expect(view.getByTestId('teams').textContent).toBe('alpha,beta');

    // Re-render the caller repeatedly. Before the fix each of these re-fired the
    // refresh effect, which is what made the loop permanent.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        forceRender?.();
        await Promise.resolve();
      });
    }

    expect(renderCount).toBeGreaterThan(10);
    expect(getTeamInfo).toHaveBeenCalledTimes(2);
  });

  it('refetches when the set of team names actually changes', async () => {
    const source = [conversation('conv-a', 'alpha')];
    const view = render(<Harness source={source} />);
    await act(async () => { await Promise.resolve(); });
    expect(getTeamInfo).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(<Harness source={[conversation('conv-a', 'alpha'), conversation('conv-b', 'beta')]} />);
      await Promise.resolve();
    });

    // The refresh effect refreshes the whole tracked set when the set changes, so
    // this is alpha's initial fetch plus one round for {alpha, beta}. The point is
    // that it is bounded and tied to the set changing, not to the render count.
    expect(getTeamInfo).toHaveBeenCalledTimes(3);
    expect(getTeamInfo.mock.calls.map(([name]) => name)).toEqual(['alpha', 'alpha', 'beta']);
  });
});
