import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildInboxFeed, type InboxSources } from '../../src/services/sessions/inbox-feed';
import { assistantTextFromEvent } from '../../src/services/sessions/inbox-feed-sources';
import { InboxDismissalStore } from '../../src/services/sessions/inbox-dismissals';
import type { ProjectOpenThread, ProjectState } from '../../src/types/project-state';
import type { WorkerState } from '../../src/types/worker-events';
import type { JobProgress } from '../../src/services/sessions/job-progress';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const HOUR = 60 * 60_000;

function thread(seq: number, name: string, overrides: Partial<ProjectOpenThread> = {}): ProjectOpenThread {
  return {
    seq, text: name, name, label: `Pick a route for ${name}`, summary: null, evidence: [], owner: { kind: 'user' },
    nextAction: null, waitingOn: null, workers: [], events: [], updatedAt: NOW - HOUR, waitingSince: NOW - HOUR,
    ...overrides,
  } as ProjectOpenThread;
}

function project(open: ProjectOpenThread[]): ProjectState {
  return { open, closed: [], decisions: [] } as unknown as ProjectState;
}

function sources(overrides: Partial<InboxSources> = {}): InboxSources {
  return {
    now: NOW,
    conversations: [
      { conversationId: 'conv-p', title: 'Payments', pickedUpFrom: null, coordinator: true },
      { conversationId: 'conv-w', title: 'Fix webhook', pickedUpFrom: 'conv-p', coordinator: false },
      { conversationId: 'conv-s', title: 'Loose session', pickedUpFrom: null, coordinator: false },
    ],
    openDecision: () => null,
    project: (id) => (id === 'conv-p' ? project([]) : null),
    workers: () => [],
    repliedAt: () => new Map(),
    failure: () => null,
    runningJobs: () => [],
    shipping: () => null,
    ...overrides,
  };
}

describe('buildInboxFeed', () => {
  it('lists an open card with its options, and does not repeat the thread it is about as a call', () => {
    const feed = buildInboxFeed(sources({
      project: () => project([thread(7, 'Webhook retries'), thread(8, 'Refund copy')]),
      openDecision: (id) => (id === 'conv-p' ? {
        asked: { id: 'd1', question: 'Retry 3 times or 5?', thread: 7, options: [
          { label: '3', consequence: 'Faster failure', recommended: true },
          { label: '5', consequence: '' },
        ] },
        seq: 10,
        shownAt: NOW - 5 * 60_000,
      } : null),
    }));
    expect(feed.items.map((item) => item.id)).toEqual(['decision:conv-p:d1', 'call:conv-p:8']);
    expect(feed.items[0]).toMatchObject({
      kind: 'decision', glyph: 'decision', priority: true, projectTitle: 'Payments', title: 'Webhook retries', href: '/c/conv-p',
      action: { kind: 'decision', decisionId: 'd1', threadSeq: 7, options: [{ label: '3', description: 'Faster failure', recommended: true }, { label: '5' }] },
    });
    expect(feed.items[1].action).toEqual({ kind: 'thread', threadSeq: 8, question: 'Pick a route for Refund copy', askText: null, canPark: true, canDismiss: true });
  });

  it('keeps an old call under All, keeps one holding up a live worker in Priority, and drops one already replied to', () => {
    const feed = buildInboxFeed(sources({
      project: () => project([
        thread(1, 'Old ask', { waitingSince: NOW - 3 * 24 * HOUR }),
        thread(2, 'Blocking ask', { waitingSince: NOW - 3 * 24 * HOUR, workers: ['conv-w'] }),
        thread(3, 'Answered ask'),
        thread(4, 'Parked ask', { parked: { at: NOW, reason: 'later', by: 'user' } }),
      ]),
      workers: () => [{ worker: 'conv-w', thread: 2, phase: 'working' } as WorkerState],
      repliedAt: () => new Map([['t:3', NOW - 10 * 60_000]]),
    }));
    const calls = Object.fromEntries(feed.items.map((item) => [item.title, item]));
    expect(Object.keys(calls).sort()).toEqual(['Blocking ask', 'Old ask']);
    expect(calls['Old ask']).toMatchObject({ priority: false, reason: 'Waiting on you' });
    expect(calls['Blocking ask']).toMatchObject({ priority: true, reason: 'Holding up a worker' });
  });

  it('lists failed and circuit-broken runs with a retry action', () => {
    const feed = buildInboxFeed(sources({
      failure: (id) => (id === 'conv-w' ? { message: 'spawn ENOENT', at: NOW - 60_000, circuitBroken: true }
        : id === 'conv-s' ? { message: 'Usage limit reached', at: NOW - 2 * 60_000 } : null),
    }));
    expect(feed.items.map((item) => [item.id, item.projectTitle, item.reason, item.action])).toEqual([
      ['failed-run:conv-w', 'Payments', 'Stopped retrying after repeated failures', { kind: 'retry', errorMessage: 'spawn ENOENT', circuitBroken: true }],
      ['failed-run:conv-s', 'Loose session', 'Its last run failed', { kind: 'retry', errorMessage: 'Usage limit reached' }],
    ]);
  });

  it('lists a stalled job under its project and leaves a moving one out', () => {
    const job = (label: string, movedAt: number): JobProgress => ({
      session: 'conv-w', label, done: 4, total: 20, startedAt: NOW - 2 * HOUR, startDone: 0, reportedAt: NOW, movedAt,
      samples: [{ at: NOW - 80 * 60_000, done: 0 }, { at: NOW - 70 * 60_000, done: 2 }, { at: movedAt, done: 4 }],
    } as JobProgress);
    const feed = buildInboxFeed(sources({ runningJobs: () => [job('Turns checked', NOW - HOUR), job('Rows copied', NOW - 60_000)] }));
    expect(feed.items).toEqual([expect.objectContaining({
      id: 'stalled-job:conv-w:Turns checked', kind: 'stalled-job', glyph: 'stalled', projectTitle: 'Payments', href: '/c/conv-p', reason: 'Stopped moving', detail: '4 of 20',
    })]);
  });

  it('lists a silent lattice run job with no count as No output, and leaves one still printing out', () => {
    const run = (label: string, lastOutputAt: number): JobProgress => ({
      session: 'conv-w', label, source: { kind: 'events' }, managed: true, done: 0, total: 0, startedAt: NOW - 2 * HOUR, startDone: 0,
      reportedAt: NOW, movedAt: NOW - 2 * HOUR, lastOutputAt, samples: [{ at: NOW - 2 * HOUR, done: 0 }],
    });
    const feed = buildInboxFeed(sources({ runningJobs: () => [run('Sweep finished', NOW - HOUR), run('Remote wait', NOW - 60_000)] }));
    expect(feed.items).toEqual([expect.objectContaining({
      id: 'stalled-job:conv-w:Sweep finished', reason: 'No output', detail: 'Has produced no output for 60 min', since: NOW - HOUR,
    })]);
  });

  it('lists failing pull requests from the cached shipping read only', () => {
    const feed = buildInboxFeed(sources({
      shipping: (id) => (id === 'conv-p' ? { unread: [], items: [
        { key: 'o/r#5', title: 'Retry webhooks', stage: 'checks-failing', stageLabel: 'Checks failing', at: NOW - HOUR, href: 'https://github.com/o/r/pull/5' },
        { key: 'o/r#6', title: 'Copy', stage: 'checks-passed', stageLabel: 'Checks passed, not reviewed', at: NOW },
      ] } : null),
    }));
    expect(feed.items).toEqual([expect.objectContaining({
      id: 'failing-pr:conv-p:o/r#5', kind: 'failing-pr', glyph: 'failed', priority: true, href: 'https://github.com/o/r/pull/5', action: { kind: 'open', label: 'Open PR' },
    })]);
  });

  it('carries a failing pull request\'s repo, number and failed checks, with none when the read had no names', () => {
    const feed = buildInboxFeed(sources({
      shipping: (id) => (id === 'conv-p' ? { unread: [], items: [
        { key: 'o/r#5', title: 'Retry webhooks', stage: 'checks-failing', stageLabel: 'Checks failing', at: NOW - HOUR, href: 'https://github.com/o/r/pull/5', failedChecks: ['typecheck', 'e2e'] },
        { key: 'o/r#9', title: 'Older read', stage: 'checks-failing', stageLabel: 'Checks failing', at: NOW - 2 * HOUR },
      ] } : null),
    }));
    expect(feed.items.map((item) => item.pr)).toEqual([
      { repo: 'r', number: 5, failedChecks: ['typecheck', 'e2e'] },
      { repo: 'r', number: 9, failedChecks: [] },
    ]);
  });

  it('lists a failing pull request two projects mention once', () => {
    const failing = { key: 'o/r#5', title: 'Retry webhooks', stage: 'checks-failing' as const, stageLabel: 'Checks failing', at: NOW - HOUR, href: 'https://github.com/o/r/pull/5' };
    const feed = buildInboxFeed(sources({
      conversations: [
        { conversationId: 'conv-p', title: 'Payments', pickedUpFrom: null, coordinator: true },
        { conversationId: 'conv-q', title: 'Billing', pickedUpFrom: null, coordinator: true },
      ],
      project: () => project([]),
      shipping: () => ({ unread: [], items: [failing] }),
    }));
    expect(feed.items.map((item) => item.id)).toEqual(['failing-pr:conv-p:o/r#5']);
    expect(feed.totalCount).toBe(1);
  });

  it('puts priority items first, newest first, then the rest newest first, and counts both', () => {
    const feed = buildInboxFeed(sources({
      project: () => project([
        thread(1, 'Stale', { waitingSince: NOW - 5 * 24 * HOUR }),
        thread(2, 'Staler', { waitingSince: NOW - 6 * 24 * HOUR }),
        thread(3, 'Fresh', { waitingSince: NOW - HOUR }),
      ]),
      failure: (id) => (id === 'conv-s' ? { message: 'boom', at: NOW - 60_000 } : null),
    }));
    expect(feed.items.map((item) => item.title)).toEqual(['Loose session', 'Fresh', 'Stale', 'Staler']);
    expect(feed).toMatchObject({ priorityCount: 2, totalCount: 4, generatedAt: NOW });
  });

  it('leaves out what one session could not read and lists the rest', () => {
    const feed = buildInboxFeed(sources({
      failure: (id) => { if (id === 'conv-w') throw new Error('database is locked'); return id === 'conv-s' ? { message: 'boom', at: NOW } : null; },
    }));
    expect(feed.items.map((item) => item.id)).toEqual(['failed-run:conv-s']);
  });

  it('forwards cold-read metadata on decisions and falls back to thread summary or asking-turn context when bare', () => {
    const rich = buildInboxFeed(sources({
      project: () => project([thread(7, 'Cutover')]),
      openDecision: (id) => (id === 'conv-p' ? {
        asked: {
          id: 'd-rich',
          question: 'Send Slack DM to Sam?',
          thread: 7,
          requestKind: 'go-ahead',
          priorityReason: 'Holding up release notes',
          context: ['Sam asked to be pinged before any Monday shift'],
          metrics: [{ label: 'Crisis refusal', value: '-2.1 pp', tone: 'worse' }],
          artifact: { kind: 'message', label: 'Draft', meta: 'Slack DM to Sam', body: 'Hey Sam', editable: true },
          ifUnanswered: 'Parks after 3h',
          options: [{ label: 'Send DM', consequence: 'Posts DM', recommended: true }, { label: 'Hold', consequence: 'Keeps schedule' }],
        },
        seq: 12,
        shownAt: NOW - 60_000,
      } : null),
    }));
    expect(rich.items[0]).toMatchObject({
      requestKind: 'go-ahead',
      priorityReason: 'Holding up release notes',
      context: ['Sam asked to be pinged before any Monday shift'],
      metrics: [{ label: 'Crisis refusal', value: '-2.1 pp', tone: 'worse' }],
      artifact: { kind: 'message', label: 'Draft', body: 'Hey Sam', editable: true },
      ifUnanswered: 'Parks after 3h',
      action: { canPark: true },
    });

    const bare = buildInboxFeed(sources({
      openDecision: (id) => (id === 'conv-s' ? {
        asked: {
          id: 'd-bare',
          question: 'Continue?',
          options: [{ label: 'Yes', consequence: 'Runs' }, { label: 'No', consequence: 'Stops' }],
        },
        seq: 44,
        shownAt: NOW - 60_000,
      } : null),
      decisionContext: (id, seq) => (id === 'conv-s' && seq === 44 ? 'Migrated 3 tables; 1 table needs lock.' : null),
    }));
    expect(bare.items[0].detail).toBe('Migrated 3 tables; 1 table needs lock.');
  });

  it('does not treat a reported idle worker as actively holding up an old ask', () => {
    const feed = buildInboxFeed(sources({
      project: () => project([thread(2, 'Old finished ask', { waitingSince: NOW - 3 * 24 * HOUR, workers: ['conv-w'] })]),
      workers: () => [{ worker: 'conv-w', thread: 2, phase: 'reported', workedSinceReport: false } as WorkerState],
    }));
    expect(feed.items[0]).toMatchObject({ priority: false, reason: 'Waiting on you' });
  });

  it('demotes failing pull requests referenced only by parked or closed threads out of Priority', () => {
    const feed = buildInboxFeed(sources({
      project: () => ({
        open: [
          thread(1, 'Parked cleanup', { summary: 'Tracked in #5', parked: { at: NOW, reason: 'later', by: 'user' } }),
          thread(2, 'Active fix', { summary: 'PR #6 fixes regression' }),
        ],
        closed: [],
        decisions: [],
      } as unknown as ProjectState),
      shipping: (id) => (id === 'conv-p' ? {
        unread: [],
        items: [
          { key: 'o/r#5', title: 'Old parked PR', stage: 'checks-failing', stageLabel: 'Checks failing', at: NOW - HOUR, failedChecks: ['test'] },
          { key: 'o/r#6', title: 'Active PR', stage: 'checks-failing', stageLabel: 'Checks failing', at: NOW - 2 * HOUR, failedChecks: ['lint'] },
        ],
      } : null),
    }));
    const byId = Object.fromEntries(feed.items.map((item) => [item.id, item]));
    expect(byId['failing-pr:conv-p:o/r#5'].priority).toBe(false);
    expect(byId['failing-pr:conv-p:o/r#6'].priority).toBe(true);
  });

  it('hides dismissed alert items until their signature changes', () => {
    const dismissed = new Map<string, string>([['failing-pr:conv-p:o/r#5', 'pr:lint,test']]);
    const sameChecks = buildInboxFeed(sources({
      shipping: (id) => (id === 'conv-p' ? {
        unread: [],
        items: [{ key: 'o/r#5', title: 'Retry', stage: 'checks-failing', stageLabel: 'Checks failing', at: NOW - HOUR, failedChecks: ['test', 'lint'] }],
      } : null),
      isDismissed: (id, sig) => dismissed.get(id) === sig,
    }));
    expect(sameChecks.items).toEqual([]);

    const newCheck = buildInboxFeed(sources({
      shipping: (id) => (id === 'conv-p' ? {
        unread: [],
        items: [{ key: 'o/r#5', title: 'Retry', stage: 'checks-failing', stageLabel: 'Checks failing', at: NOW - HOUR, failedChecks: ['test', 'lint', 'e2e'] }],
      } : null),
      isDismissed: (id, sig) => dismissed.get(id) === sig,
    }));
    expect(newCheck.items.map((item) => item.id)).toEqual(['failing-pr:conv-p:o/r#5']);
  });

  it('demotes decision cards older than 24h out of Priority unless holding up an active worker', () => {
    const oldCard = (id: string, threadSeq?: number) => ({
      asked: {
        id,
        question: 'Ship it?',
        ...(threadSeq !== undefined ? { thread: threadSeq } : {}),
        options: [{ label: 'Yes', consequence: 'Ships' }, { label: 'No', consequence: 'Holds' }],
      },
      seq: 20,
      shownAt: NOW - 25 * HOUR,
    });
    const demoted = buildInboxFeed(sources({
      project: () => project([thread(7, 'Release')]),
      openDecision: (id) => (id === 'conv-p' ? oldCard('d-old', 7) : null),
    }));
    expect(demoted.items[0].priority).toBe(false);

    const blocking = buildInboxFeed(sources({
      project: () => project([thread(7, 'Release', { workers: ['conv-w'] })]),
      workers: () => [{ worker: 'conv-w', thread: 7, phase: 'working' } as WorkerState],
      openDecision: (id) => (id === 'conv-p' ? oldCard('d-hold', 7) : null),
    }));
    expect(blocking.items[0]).toMatchObject({ priority: true, priorityReason: 'Holding up a worker' });
  });
});

describe('assistantTextFromEvent', () => {
  it('extracts text from blocks[], content[], and plain text payloads while skipping non-text blocks', () => {
    expect(assistantTextFromEvent({
      blocks: [
        { type: 'thinking', text: 'internal' },
        { type: 'text', text: 'First paragraph.' },
        { type: 'tool_use', name: 'bash' },
        { type: 'text', text: 'Second paragraph.' },
      ],
    })).toBe('First paragraph.\nSecond paragraph.');
    expect(assistantTextFromEvent({ role: 'user', text: 'ignored' })).toBe('');
    expect(assistantTextFromEvent({ content: [{ type: 'text', text: 'From content array' }] })).toBe('From content array');
  });
});

describe('InboxDismissalStore', () => {
  it('persists dismissals by signature and supports restore', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-dismiss-'));
    try {
      const file = path.join(dir, 'dismissals.json');
      const store = new InboxDismissalStore(file);
      store.dismiss('failing-pr:c:o/r#5', 'pr:test', NOW);
      expect(store.isDismissed('failing-pr:c:o/r#5', 'pr:test')).toBe(true);
      expect(store.isDismissed('failing-pr:c:o/r#5', 'pr:lint,test')).toBe(false);

      // Fresh instance reads persisted JSON from disk.
      const reloaded = new InboxDismissalStore(file);
      expect(reloaded.isDismissed('failing-pr:c:o/r#5', 'pr:test')).toBe(true);
      expect(reloaded.restore('failing-pr:c:o/r#5')).toBe(true);
      expect(reloaded.isDismissed('failing-pr:c:o/r#5', 'pr:test')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
