// @vitest-environment happy-dom

/**
 * The Inbox lists what waits on the user across projects. Priority shows only
 * the priority rows, All shows every one; the detail pane carries real
 * actions: an answer is held with Undo, a failed run retries, and a thread can
 * be parked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { InboxFeedResponse, InboxItem } from '../../src/types/inbox-feed.js';

const { InboxView } = await import('../../src/web/chat/components/Inbox/InboxPage.js');
const { emptyText, inboxGlyph, inboxRows, jobCount, kindLabel, prRef, rowTone, rowWhy } = await import('../../src/web/chat/components/Inbox/inbox-view.js');

const NOW = Date.now();

const items: InboxItem[] = [
  {
    id: 'd1', kind: 'decision', glyph: 'decision', priority: true, conversationId: 'conv-a', projectTitle: 'Payments retry',
    title: 'Payments retry', reason: 'Backoff cap decision', since: NOW - 12 * 60_000,
    action: { kind: 'decision', decisionId: 'dec-1', question: 'Backoff cap', options: [{ label: 'Raise to 30m', description: 'Fewer retries during an outage' }, { label: 'Keep 5m cap', recommended: true }] },
  },
  {
    id: 'f1', kind: 'failed-run', glyph: 'failed', priority: true, conversationId: 'conv-b', projectTitle: 'Telemetry',
    title: 'Telemetry ingestion', reason: 'Paused after 12 spawn errors', since: NOW - 2 * 3_600_000,
    action: { kind: 'retry', errorMessage: 'spawn ENOENT' },
  },
  {
    id: 't1', kind: 'call', glyph: 'waiting', priority: false, conversationId: 'conv-c', projectTitle: 'Billing',
    title: 'Billing webhook', reason: 'Cut-over date', since: NOW - 5 * 3_600_000,
    action: { kind: 'thread', threadSeq: 42, question: 'When do we cut over?', askText: 'Either Monday or Thursday.', canPark: true, canDismiss: true },
  },
];
const feed: InboxFeedResponse = { items, priorityCount: 2, totalCount: 3, generatedAt: NOW };

const failingPr: InboxItem = {
  id: 'p1', kind: 'failing-pr', glyph: 'failed', priority: true, conversationId: 'conv-d', projectTitle: 'Release Board',
  title: 'Report session length percentiles', reason: 'Checks failing', since: NOW - 30 * 60_000,
  href: 'https://github.com/o/web-app/pull/3575', pr: { repo: 'web-app', number: 3575, failedChecks: ['typecheck', 'lint'] },
  action: { kind: 'open', label: 'Open PR' },
};
const structuredCall: InboxItem = {
  id: 't2', kind: 'call', glyph: 'decision', priority: true, conversationId: 'conv-e', projectTitle: 'Alerts',
  title: 'Stall alerts', reason: 'Waiting on you', since: NOW - 60_000,
  action: { kind: 'thread', threadSeq: 7, question: 'Two calls on stall alerts', canPark: true, canDismiss: true,
    askText: 'Before the worker ships. 1. Reset the stall timer on restart? Recommendation: Yes. 2. Page on the first stall? Recommendation: After two in a row' },
};
const stalledJob: InboxItem = {
  id: 's1', kind: 'stalled-job', glyph: 'stalled', priority: true, conversationId: 'conv-f', projectTitle: 'Release Board',
  title: 'Turns checked', reason: 'Stopped moving', detail: '1254 of 1723', since: NOW - 60 * 60_000,
};

function renderOne(item: InboxItem) {
  render(<MemoryRouter><InboxView feed={{ items: [item], priorityCount: 1, totalCount: 1, generatedAt: NOW }} onChanged={() => {}} /></MemoryRouter>);
  return screen.getByTestId('inbox-detail');
}

let calls: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('min-width: 768px'), media: query, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const payload = url.endsWith('/project/replies') ? { id: 'held-1', until: NOW + 6000 } : { ok: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderInbox() {
  const onChanged = vi.fn();
  render(<MemoryRouter><InboxView feed={feed} onChanged={onChanged} /></MemoryRouter>);
  return onChanged;
}

const rowIds = () => [...document.querySelectorAll('[data-inbox-row]')].map((el) => el.getAttribute('data-inbox-row'));

describe('inbox view helpers', () => {
  it('filters Priority to priority rows and keeps All whole', () => {
    expect(inboxRows(items, 'priority').map((i) => i.id)).toEqual(['d1', 'f1']);
    expect(inboxRows(items, 'all').map((i) => i.id)).toEqual(['d1', 'f1', 't1']);
  });

  it('maps feed glyphs onto the shared state marks and steps titles down', () => {
    expect(inboxGlyph('decision')).toBe('progress');
    expect(inboxGlyph('stalled')).toBe('waiting');
    expect(inboxGlyph('failed')).toBe('failed');
    expect(rowTone(0).title).toContain('font-medium');
    expect(rowTone(99)).toEqual(rowTone(5));
    expect(emptyText('priority')).toBe('Nothing waiting in Priority');
    expect(emptyText('all')).toBe('All clear');
  });

  it('names each item by what it is and why it is here', () => {
    expect(kindLabel(failingPr)).toBe('web-app #3575');
    expect(rowWhy(failingPr)).toBe('Checks failing: typecheck, lint');
    expect(kindLabel(items[0])).toBe('Decision');
    expect(rowWhy(items[0])).toBe('Recommended: Keep 5m cap');
    expect(rowWhy(items[2])).toBe('When do we cut over?');
    expect(rowWhy(stalledJob)).toBe(`Stopped moving at ${(1254).toLocaleString()} of ${(1723).toLocaleString()}`);
    expect(jobCount(stalledJob)).toEqual({ done: 1254, total: 1723 });
  });

  it('reads a pull request from its link when the feed carries no pr', () => {
    const { pr: _pr, ...bare } = failingPr;
    expect(prRef(bare)).toEqual({ repo: 'web-app', number: 3575, failedChecks: [] });
    expect(rowWhy(bare)).toBe('Checks failing');
  });
});

describe('InboxView', () => {
  it('shows Priority with counts, and All lists every row', () => {
    renderInbox();
    expect(screen.getByRole('tab', { name: /Priority/ }).textContent).toBe('Priority 2');
    expect(screen.getByRole('tab', { name: /All/ }).textContent).toBe('All 3');
    expect(rowIds()).toEqual(['d1', 'f1']);
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    expect(rowIds()).toEqual(['d1', 'f1', 't1']);
    expect(document.querySelector('[data-inbox-row="d1"]')?.textContent).toContain('12m');
  });

  it('answers a decision with a held reply and takes it back with Undo', async () => {
    renderInbox();
    const detail = screen.getByTestId('inbox-detail');
    expect(within(detail).getByRole('heading', { name: 'Backoff cap' })).toBeTruthy();
    expect(within(detail).getByText('Fewer retries during an outage')).toBeTruthy();
    fireEvent.click(within(detail).getByRole('button', { name: /Keep 5m cap/ }));
    await waitFor(() => expect(screen.getByTestId('inbox-outcome').textContent).toContain('Keep 5m cap'));
    expect(calls[0]).toEqual({ url: '/api/conv/conv-a/project/replies', body: { target: { kind: 'answer', decision: 'dec-1' }, text: 'Keep 5m cap' } });
    expect(document.querySelector('[data-inbox-row="d1"] [data-glyph="done"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls[1]?.url).toBe('/api/conv/conv-a/project/replies/held-1/undo'));
    await waitFor(() => expect(screen.queryByTestId('inbox-outcome')).toBeNull());
  });

  it('moves with j/k and Enter takes the recommended option', async () => {
    renderInbox();
    fireEvent.keyDown(window, { key: 'j' });
    expect(within(screen.getByTestId('inbox-detail')).getByText('spawn ENOENT')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(calls[0]?.body).toEqual({ target: { kind: 'answer', decision: 'dec-1' }, text: 'Keep 5m cap' }));
  });

  it('retries a failed run through the retry route', async () => {
    renderInbox();
    fireEvent.click(document.querySelector('[data-inbox-row="f1"]')!);
    fireEvent.click(within(screen.getByTestId('inbox-detail')).getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(calls[0]?.url).toBe('/api/conv/conv-b/retry'));
  });

  it('answers a free-text thread ask in its own box, held under the words sent', async () => {
    renderInbox();
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    fireEvent.click(document.querySelector('[data-inbox-row="t1"]')!);
    const detail = screen.getByTestId('inbox-detail');
    expect(within(detail).getByText('Either Monday or Thursday.')).toBeTruthy();
    expect(within(detail).queryByTestId('inbox-reply')).toBeNull();
    fireEvent.change(within(detail).getByLabelText('Answer Billing…'), { target: { value: 'Thursday' } });
    fireEvent.click(within(detail).getByTestId('ask-send'));
    await waitFor(() => expect(calls[0]?.body).toEqual({ target: { kind: 'thread', thread: 42 }, text: 'Thursday' }));
    await waitFor(() => expect(screen.getByTestId('inbox-outcome').textContent).toContain('Thursday'));
  });

  it('lays a numbered thread ask out as questions and sends the recommendations', async () => {
    const detail = renderOne(structuredCall);
    expect(within(detail).getAllByTestId('ask-question')).toHaveLength(2);
    fireEvent.click(within(detail).getByTestId('ask-send'));
    await waitFor(() => expect(calls[0]?.url).toBe('/api/conv/conv-e/project/replies'));
    expect(calls[0]?.body).toMatchObject({ target: { kind: 'thread', thread: 7 } });
    expect(String((calls[0]?.body as { text: string }).text)).toMatch(/^1\. Yes\n2\. After two in a row$/);
  });

  it('names a failing pull request\'s checks, links to it, asks the project to fix it and clears the card with Undo', async () => {
    const detail = renderOne(failingPr);
    expect(within(detail).getByTestId('inbox-status').textContent).toContain('typecheck');
    expect(within(detail).getByRole('link', { name: /Open PR/ }).getAttribute('href')).toBe('https://github.com/o/web-app/pull/3575');
    fireEvent.click(within(detail).getByRole('button', { name: 'Ask project to fix' }));
    await waitFor(() => expect(screen.getByTestId('inbox-outcome').textContent).toContain('Sent to Release Board'));
    expect(calls[0]?.url).toBe('/api/conv/conv-d/resume');
    expect((calls[0]?.body as { message: string }).message).toContain('PR #3575 in web-app');
    expect((calls[0]?.body as { message: string }).message).toContain('(typecheck, lint)');
    const inboxCalls = () => calls.filter((call) => call.url.startsWith('/api/inbox/'));
    expect(inboxCalls()).toEqual([{ url: '/api/inbox/dismiss', body: { id: 'p1' } }]);
    fireEvent.click(within(screen.getByTestId('inbox-outcome')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(inboxCalls()[1]).toEqual({ url: '/api/inbox/restore', body: { id: 'p1' } }));
  });

  it('parks a thread with Park', async () => {
    renderInbox();
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    fireEvent.click(document.querySelector('[data-inbox-row="t1"]')!);
    fireEvent.click(within(screen.getByTestId('inbox-detail')).getByRole('button', { name: 'Park' }));
    await waitFor(() => expect(calls[0]?.url).toBe('/api/conv/conv-c/project/threads/42/park'));
  });

  it('says so in one quiet line when Priority is empty', () => {
    render(<MemoryRouter><InboxView feed={{ ...feed, items: [items[2]], priorityCount: 0, totalCount: 1 }} onChanged={() => {}} /></MemoryRouter>);
    expect(screen.getByTestId('inbox-list').textContent).toBe('Nothing waiting in Priority');
  });

  it('renders cold-read context, metrics, and editable draft artifacts, sending edited draft text with the chosen option', async () => {
    const draftCard: InboxItem = {
      id: 'd-draft', kind: 'decision', requestKind: 'go-ahead', glyph: 'decision', priority: true,
      priorityReason: 'Holding up release notes',
      conversationId: 'conv-r', projectTitle: 'Release Board', title: 'Weekly digest', reason: 'Asks you to decide',
      context: ['Sam asked to be pinged before any Monday shift'],
      metrics: [{ label: 'Crisis refusal', value: '-2.1 pp', tone: 'worse' }],
      artifact: { kind: 'message', label: 'Draft', meta: 'Slack DM to Sam', body: 'Original draft', editable: true },
      ifUnanswered: 'Parks after 3h',
      since: NOW - 5 * 60_000,
      action: {
        kind: 'decision', decisionId: 'dec-draft', question: 'Send Slack DM to Sam?', threadSeq: 9, canPark: true,
        options: [
          { label: 'Send DM to Sam', description: 'Posts DM', recommended: true },
          { label: 'Hold', description: 'Keeps schedule' },
        ],
      },
    };
    const detail = renderOne(draftCard);
    expect(within(detail).getByTestId('inbox-context').textContent).toContain('Sam asked to be pinged');
    expect(within(detail).getByTestId('inbox-metrics').textContent).toContain('-2.1 pp');
    expect(within(detail).getByTestId('inbox-stakes').textContent).toContain('Parks after 3h');
    fireEvent.click(within(detail).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(detail).getByLabelText('Edit Draft'), { target: { value: 'Edited draft text' } });
    fireEvent.click(within(detail).getByRole('button', { name: /Send DM to Sam \(edited\)/ }));
    await waitFor(() => expect(calls[0]).toEqual({
      url: '/api/conv/conv-r/project/replies',
      body: { target: { kind: 'answer', decision: 'dec-draft' }, text: 'Send DM to Sam\n\nEdited draft:\nEdited draft text' },
    }));
  });

  it('parses a single-question numbered thread ask onto a unified one-click Recommended card', async () => {
    const singleCall: InboxItem = {
      id: 't-single', kind: 'call', glyph: 'decision', priority: true,
      conversationId: 'conv-s', projectTitle: 'Sandbox', title: 'Merge pacing', reason: 'Waiting on you',
      since: NOW - 60_000,
      action: {
        kind: 'thread', threadSeq: 14, question: 'Drop the 6m merge gap?', canPark: true, canDismiss: true,
        askText: 'CI queue stayed empty for 48h. 1. Drop the 6-minute merge gap? Recommendation: Verify and drop 6m gap',
      },
    };
    const detail = renderOne(singleCall);
    fireEvent.click(within(detail).getByTestId('inbox-accept-rec'));
    await waitFor(() => expect(calls[0]).toEqual({
      url: '/api/conv/conv-s/project/replies',
      body: { target: { kind: 'thread', thread: 14 }, text: 'Verify and drop 6m gap' },
    }));
  });

  it('dismisses a failing pull request alert and restores it on Undo', async () => {
    const detail = renderOne(failingPr);
    fireEvent.click(within(detail).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(calls[0]).toEqual({ url: '/api/inbox/dismiss', body: { id: 'p1' } }));
    await waitFor(() => expect(screen.getByTestId('inbox-outcome').textContent).toContain('Dismissed'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls[1]).toEqual({ url: '/api/inbox/restore', body: { id: 'p1' } }));
  });
});
