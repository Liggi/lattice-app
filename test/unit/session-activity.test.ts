/**
 * A sidebar row's state icon comes from server state alone: attention,
 * compaction, running, running workers, armed background work or a declared
 * wait, and quiet time.
 */

import { describe, it, expect } from 'vitest';
import { deriveSessionActivity, describeSessionActivity, needsYouStrength } from '@/web/chat/utils/session-activity';
import type { UnifiedConversationSummary } from '@/web/chat/types';

const MIN = 60 * 1000;
const NOW = Date.parse('2026-09-26T18:00:00Z');

function conv(id: string, overrides: Partial<UnifiedConversationSummary> = {}): UnifiedConversationSummary {
  return {
    conversationId: id,
    createdAt: new Date(NOW - 60 * MIN).toISOString(),
    updatedAt: new Date(NOW - 60 * MIN).toISOString(),
    lastActivityAt: new Date(NOW - 5 * MIN).toISOString(),
    workingDirectory: '/tmp',
    latestProvider: 'claude',
    segmentCount: 1,
    status: 'idle',
    streamingId: null,
    customName: id,
    pinned: false,
    archived: false,
    pausedReason: null,
    importedAt: null,
    permissionMode: null,
    identityImage: null,
    initialPromptPreview: null,
    ...overrides,
  } as UnifiedConversationSummary;
}

const workers = (n: number, status: UnifiedConversationSummary['status'] = 'ongoing') =>
  Array.from({ length: n }, (_, k) => conv(`conv-w${k}`, { pickedUpFrom: 'conv-p', status }));

describe('deriveSessionActivity', () => {
  it('sets the working level by busy workers: 0–1, 2–3, 4+', () => {
    const project = conv('conv-p', { coordinator: true, status: 'ongoing' });
    const level = (n: number) => {
      const a = deriveSessionActivity(project, [project, ...workers(n)], false, NOW);
      return a.kind === 'working' ? a.level : a.kind;
    };
    expect([level(0), level(1), level(2), level(3), level(4), level(7)]).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('counts a coordinator as working while its workers are, even between its own turns', () => {
    const project = conv('conv-p', { coordinator: true });
    expect(deriveSessionActivity(project, [project, ...workers(2)], false, NOW))
      .toEqual({ kind: 'working', level: 2, busyWorkers: 2 });
  });

  it('shows a running turn held on its question card as needing the user, not working', () => {
    const session = conv('conv-c', { latestProvider: 'codex', status: 'ongoing', awaitingAnswer: true });
    expect(deriveSessionActivity(session, [session], false, NOW)).toEqual({ kind: 'needs-you' });
  });

  it('ignores idle and archived workers', () => {
    const project = conv('conv-p', { coordinator: true });
    const list = [project, ...workers(3, 'idle'), conv('conv-a', { pickedUpFrom: 'conv-p', status: 'ongoing', archived: true })];
    expect(deriveSessionActivity(project, list, false, NOW).kind).toBe('idle');
  });

  it('puts needs-you first, then compacting, then working, then waiting', () => {
    const busy = conv('conv-s', { status: 'ongoing', compacting: true, pendingWork: 'subagent' });
    expect(deriveSessionActivity(busy, [busy], true, NOW).kind).toBe('needs-you');
    expect(deriveSessionActivity(busy, [busy], false, NOW).kind).toBe('compacting');
    const waiting = conv('conv-w', { pendingWork: 'background_task' });
    expect(deriveSessionActivity(waiting, [waiting], false, NOW).kind).toBe('waiting');
  });

  it('shows a project whose workers are all parked as waiting, not working', () => {
    const project = conv('conv-p', { coordinator: true });
    const parked = [conv('conv-w0', { pickedUpFrom: 'conv-p', pendingWork: 'background_task' }),
      conv('conv-w1', { pickedUpFrom: 'conv-p', pendingWork: 'scheduled_wakeup' })];
    const activity = deriveSessionActivity(project, [project, ...parked], false, NOW);
    expect(activity).toEqual({ kind: 'waiting', waitingWorkers: 2 });
    expect(describeSessionActivity(activity, project, NOW)).toBe('Waiting · 2 workers waiting');
  });

  it('sets the working level by running workers only, not parked ones', () => {
    const project = conv('conv-p', { coordinator: true });
    const list = [project, ...workers(1), conv('conv-x', { pickedUpFrom: 'conv-p', pendingWork: 'subagent' }),
      conv('conv-y', { pickedUpFrom: 'conv-p', pendingWork: 'background_task' })];
    expect(deriveSessionActivity(project, list, false, NOW)).toEqual({ kind: 'working', level: 1, busyWorkers: 1 });
  });

  it('counts a wait a worker declared in its report, on the worker and on its project', () => {
    const project = conv('conv-p', { coordinator: true, projectWorkerWaits: { 'conv-w0': 'the next restart' } });
    const worker = conv('conv-w0', { pickedUpFrom: 'conv-p' });
    const list = [project, worker];
    const own = deriveSessionActivity(worker, list, false, NOW);
    expect(own).toEqual({ kind: 'waiting', waitingOn: 'the next restart', waitingWorkers: 0 });
    expect(describeSessionActivity(own, worker, NOW)).toBe('Waiting on the next restart');
    expect(deriveSessionActivity(project, list, false, NOW)).toEqual({ kind: 'waiting', waitingWorkers: 1 });
    // Running again: the old report's wait no longer holds it.
    expect(deriveSessionActivity(conv('conv-w0', { pickedUpFrom: 'conv-p', status: 'ongoing' }), list, false, NOW).kind).toBe('working');
    // An archived worker's wait counts for nothing.
    const archived = conv('conv-w0', { pickedUpFrom: 'conv-p', archived: true });
    expect(deriveSessionActivity(project, [project, archived], false, NOW).kind).toBe('idle');
  });

  it('keeps Needs you and Failed above Waiting', () => {
    const project = conv('conv-p', { coordinator: true, projectWorkerWaits: { 'conv-w0': 'a decision' } });
    const list = [project, conv('conv-w0', { pickedUpFrom: 'conv-p' })];
    expect(deriveSessionActivity(project, list, true, NOW).kind).toBe('needs-you');
    expect(deriveSessionActivity({ ...project, failure: { message: 'boom', at: NOW } }, list, false, NOW).kind).toBe('failed');
  });

  it('turns idle into sleeping after 3 quiet hours', () => {
    const at = (mins: number) => conv('conv-s', { lastActivityAt: new Date(NOW - mins * MIN).toISOString() });
    expect(deriveSessionActivity(at(179), [], false, NOW).kind).toBe('idle');
    expect(deriveSessionActivity(at(181), [], false, NOW).kind).toBe('sleeping');
  });

  it('shows Failed over everything but Needs you, until new work clears it', () => {
    const failure = { message: 'Failed to authenticate.', at: NOW - MIN };
    expect(deriveSessionActivity(conv('conv-p', { failure }), [], false, NOW)).toEqual({ kind: 'failed', message: 'Failed to authenticate.' });
    expect(deriveSessionActivity(conv('conv-p', { failure }), workers(2), false, NOW).kind).toBe('failed');
    expect(deriveSessionActivity(conv('conv-p', { failure }), [], true, NOW).kind).toBe('needs-you');
    expect(deriveSessionActivity(conv('conv-p', { failure: null, status: 'ongoing' }), [], false, NOW).kind).toBe('working');
  });

  it('lights a project for an ask under an hour old, and drops it after the hour', () => {
    const fresh = { seq: 1, text: 'whether to ship the fix', thread: 'Ship it', since: NOW - 20 * MIN, score: 0.7 };
    const older = { seq: 2, text: 'which audit to build', thread: 'Audit', since: NOW - 90 * MIN, score: 0.9 };
    const project = conv('conv-p', { coordinator: true, status: 'ongoing', projectNeedsYou: [older, fresh] });
    const activity = deriveSessionActivity(project, [project], false, NOW);
    expect(activity).toEqual({ kind: 'needs-you', asks: [fresh], strength: 0.5 });
    expect(describeSessionActivity(activity, project, NOW)).toBe('Needs you · whether to ship the fix');

    const quiet = conv('conv-p', { coordinator: true, projectNeedsYou: [older] });
    expect(deriveSessionActivity(quiet, [quiet], false, NOW).kind).toBe('idle');
    expect(deriveSessionActivity(conv('conv-p', { projectNeedsYou: [fresh], failure: { message: 'boom', at: NOW } }), [], false, NOW).kind).toBe('failed');
  });

  it('names the top ask, and others only when they score clearly high too', () => {
    const ask = (seq: number, score: number) => ({ seq, text: `ask ${seq}`, thread: 't', since: NOW - 10 * MIN, score });
    const project = conv('conv-p', { coordinator: true, projectNeedsYou: [ask(1, 0.6), ask(2, 0.8), ask(3, 0.76), ask(4, 0.9), ask(5, 0.7)] });
    const activity = deriveSessionActivity(project, [project], false, NOW);
    expect(activity.kind === 'needs-you' && activity.asks?.map(a => a.seq)).toEqual([4, 2, 3]);
    const plain = conv('conv-p', { coordinator: true, projectNeedsYou: [ask(1, 0.6), ask(5, 0.7)] });
    const one = deriveSessionActivity(plain, [plain], false, NOW);
    expect(one.kind === 'needs-you' && one.asks?.map(a => a.seq)).toEqual([5]);
  });

  it('shows an ask brightest when fresh and scored high, dimmer as it ages or scores lower', () => {
    const ask = (mins: number, score: number) => ({ seq: 1, text: 'x', thread: 't', since: NOW - mins * MIN, score });
    expect(needsYouStrength(ask(0, 0.85), NOW)).toBe(1);
    expect(needsYouStrength(ask(0, 0.55), NOW)).toBe(0.5);
    expect(needsYouStrength(ask(30, 0.85), NOW)).toBe(0.5);
    expect(needsYouStrength(ask(60, 0.85), NOW)).toBe(0);
  });
});
