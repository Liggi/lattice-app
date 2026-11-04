/**
 * An ask the user leaves unanswered for three hours goes to the project's
 * backlog: which threads decay, and the line the coordinator gets.
 */

import { describe, expect, it } from 'vitest';
import { foldProjectState, type ProjectEventLike } from '../../src/types/project-state.js';
import { ASK_DECAY_MS, decayedLine, decayingAsks } from '../../src/services/sessions/ask-decay-watch.js';
import type { OpenDecision } from '../../src/services/sessions/open-decision.js';

const T0 = 1_700_000_000_000;
let seq = 0;
function note(kind: string, text: string, extra: Record<string, unknown> = {}, at = T0): ProjectEventLike {
  seq += 1;
  return { seq, type: 'project:noted', timestamp: at, data: { kind, text, by: 'coordinator', ...extra } };
}
const usersCall = (text: string, at = T0) => note('open', text, { owner: { kind: 'user' }, waitingOn: { kind: 'decision', text }, label: `${text}?` }, at);

function due(events: ProjectEventLike[], now: number, extra: { workers?: Array<{ worker: string; thread: number | null; movedOn?: boolean; phase?: 'working' | 'asked' | 'reported'; waitingOn?: string | null; workedSinceReport?: boolean }>; card?: OpenDecision | null; replied?: Map<string, number> } = {}) {
  return decayingAsks({
    state: foldProjectState(events),
    liveWorkers: (extra.workers ?? []).map((worker) => ({ movedOn: false, ...worker })),
    card: extra.card ?? null,
    repliedAt: extra.replied ?? new Map(),
    now,
  }).map((ask) => ask.thread.seq);
}

describe('ask decay', () => {
  it('decays the user\'s asks after three hours and nothing else', () => {
    const call = usersCall('place names');
    const mine = note('open', 'build it', { owner: { kind: 'coordinator' } });
    expect(due([call, mine], T0 + ASK_DECAY_MS - 1)).toEqual([]);
    expect(due([call, mine], T0 + ASK_DECAY_MS)).toEqual([call.seq]);
    expect(due([call, note('park', 'later', { ref: call.seq })], T0 + 2 * ASK_DECAY_MS)).toEqual([]);
  });

  it('keeps an ask a live worker is on, one answered from its row, and one the coordinator is still taking in a message about', () => {
    const call = usersCall('pick fixes');
    const later = T0 + 4 * 3_600_000;
    expect(due([call], later, { workers: [{ worker: 'conv-w', thread: call.seq }] })).toEqual([]);
    expect(due([call], later, { replied: new Map([[`t:${call.seq}`, T0 + 60_000]]) })).toEqual([]);
    const sent = { seq: 99, type: 'user:sent', timestamp: T0 + 3_600_000, data: {} };
    expect(due([call, sent], later)).toEqual([]);
    expect(due([call, sent, { seq: 100, type: 'turn:end', timestamp: T0 + 3_700_000, data: {} }], later)).toEqual([call.seq]);
  });

  it('keeps an ask other work is blocked on, and still decays one nothing waits on', () => {
    const call = usersCall('live writing', T0);
    const named = note('update', 'named', { ref: call.seq, name: 'Live writing delivery' });
    const blocked = note('open', 'install it', { owner: { kind: 'coordinator' }, waitingOn: { kind: 'dependency', text: String(call.seq), thread: call.seq } });
    const later = T0 + 4 * 3_600_000;
    expect(due([call, named, blocked], later)).toEqual([]);
    // A dependency written as a bare id with no thread field counts the same.
    expect(due([call, note('open', 'other', { waitingOn: { kind: 'dependency', text: `thread ${call.seq}` } })], later)).toEqual([]);
    // Once the dependent thread is parked or no longer waits, the ask decays.
    expect(due([call, named, blocked, note('park', 'later', { ref: blocked.seq })], later)).toEqual([call.seq]);
    expect(due([call, named, blocked, note('update', 'ready', { ref: blocked.seq, waitingOn: null })], later)).toEqual([call.seq]);
    // A live worker still waiting on it, by id or by name; not one that has moved on since.
    const waiting = (waitingOn: string, extra: { workedSinceReport?: boolean } = {}) => [{ worker: 'conv-w', thread: null, phase: 'reported' as const, waitingOn, ...extra }];
    expect(due([call, named], later, { workers: waiting(`Jason's answer on thread [${call.seq}]`) })).toEqual([]);
    expect(due([call, named], later, { workers: waiting('Jason to settle live writing delivery') })).toEqual([]);
    expect(due([call, named], later, { workers: waiting(`thread [${call.seq}]`, { workedSinceReport: true }) })).toEqual([call.seq]);
    expect(due([call, named], later, { workers: waiting(`run ${call.seq}0 to finish`) })).toEqual([call.seq]);
    expect(due([call, named], later)).toEqual([call.seq]);
  });

  it('counts from the card about the thread when it showed later, and from a restore', () => {
    const call = usersCall('pick fixes');
    const card = { asked: { id: 'd1', thread: call.seq }, seq: 50, shownAt: T0 + 2 * 3_600_000 } as unknown as OpenDecision;
    expect(due([call], T0 + 4 * 3_600_000, { card })).toEqual([]);
    const parked = note('park', 'No answer', { ref: call.seq, decayed: true }, T0 + ASK_DECAY_MS);
    const restored = note('unpark', 'back', { ref: call.seq, by: 'user' }, T0 + 4 * 3_600_000);
    expect(due([call, parked, restored], T0 + 5 * 3_600_000)).toEqual([]);
    expect(due([call, parked, restored], T0 + 7 * 3_600_000)).toEqual([call.seq]);
  });

  it('tells the coordinator where the ask went and the one way to bring it back', () => {
    const thread = foldProjectState([usersCall('place names')]).open[0];
    const line = decayedLine(thread, 7.4 * 3_600_000);
    expect(line).toBe(`You left thread [${thread.seq}] "place names?" unanswered for 7 hours, so it has moved to the project's backlog.`
      + ' You can restore it from there. Ask again with a new --ask only if the work is truly blocked on you; otherwise leave it parked.');
  });
});
