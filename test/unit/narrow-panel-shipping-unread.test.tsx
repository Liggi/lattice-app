// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TooltipProvider } from '../../src/web/chat/components/ui/tooltip.js';
import { plainUnread } from '../../src/web/chat/components/InsightsPanel/shipping-unread.js';

vi.mock('../../src/web/chat/contexts/ActivityStreamContext.js', () => ({
  useActivityStreamSubscription: () => {},
  useActivityStream: () => ({ isConnected: true, connectionState: { lastConnectedAt: null } }),
}));

const { NarrowPanel } = await import('../../src/web/chat/components/InsightsPanel/NarrowPanel.js');

function serve(shipping: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/shipping')) return new Response(JSON.stringify(shipping), { status: 200 });
    if (String(url).endsWith('/jobs')) return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    return new Response('', { status: 404 });
  }));
}

function draw() {
  return render(
    <TooltipProvider>
      <NarrowPanel coordinatorId="conv-coord" attention={[]} workers={[]} coordinatorRunning={false} renderWorker={() => null} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Pull requests and releases, when GitHub could not be read', () => {
  it('says what could not be checked and does not claim there is nothing open', async () => {
    serve({ items: [], unread: ['pull requests on acme/web-app: HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)'] });
    draw();
    expect((await screen.findByTestId('panel-shipping-unread')).textContent).toBe("Couldn't check acme/web-app — GitHub timed out");
    expect(screen.queryByText('No open pull requests, nothing shipped today')).toBeNull();
  });

  it('says nothing is open only when everything was read', async () => {
    serve({ items: [], unread: [] });
    draw();
    expect(await screen.findByText('No open pull requests, nothing shipped today')).toBeTruthy();
    expect(screen.queryByTestId('panel-shipping-unread')).toBeNull();
  });
});

describe('plainUnread', () => {
  it('turns each kind of failure into plain words', () => {
    expect(plainUnread([
      'checks on acme/api #3575: timed out after 20s',
      'acme/web-app #12: HTTP 502: Bad Gateway',
      'npm release for /Users/me/src/lattice: timed out after 20s',
      'branches in /Users/me/src/lattice: fatal: not a git repository',
      '/Users/me/src/gone is not on this machine',
      'pull requests on o/r: API rate limit exceeded',
    ])).toEqual([
      "Couldn't check acme/api #3575 — GitHub timed out",
      "Couldn't check acme/web-app #12 — GitHub was unavailable",
      "Couldn't check the npm release for lattice — timed out",
      "Couldn't check branches in lattice — fatal: not a git repository",
      '/Users/me/src/gone is not on this machine',
      "Couldn't check o/r — GitHub rate limit reached",
    ]);
  });
});
