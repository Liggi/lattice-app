/**
 * Which calls the panel lists and how they fade (`types/your-calls.ts`), and
 * how a reply held in the panel shows on the card (`types/held-replies.ts`).
 */

import { describe, expect, it } from 'vitest';
import { callStage, deriveCalls, CALL_LEAVE_MS } from '../../src/types/your-calls.js';
import { askAnswers, parseAsk } from '../../src/types/ask-text.js';
import { foldDecisions, isOpenDecision, shownLatestDecision } from '../../src/types/decisions.js';
import { foldHeldReplies, repliedAt } from '../../src/types/held-replies.js';
import type { PlayItem } from '../../src/types/state-of-play.js';
import type { ProjectOpenThread } from '../../src/types/project-state.js';
import type { WorkerCardState } from '../../src/types/worker-events.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

function item(seq: number, ago: number, extra: Partial<ProjectOpenThread> = {}, workers = 0): PlayItem {
  const thread = {
    seq, at: NOW - ago, text: `Thread ${seq}`, summary: null, evidence: [], label: `Ask ${seq}?`, name: `Name ${seq}`,
    owner: { kind: 'user' }, nextAction: null, waitingOn: null, workers: [], events: [], updatedAt: NOW - ago, waitingSince: NOW - ago, ...extra,
  } as ProjectOpenThread;
  return { key: String(seq), thread, label: thread.label!, workers: Array.from({ length: workers }, () => ({}) as WorkerCardState), heldOn: null };
}

const asked = (id: string, thread?: number) => ({
  type: 'decision:asked', seq: 1, timestamp: NOW - 5 * 60_000,
  data: { id, question: 'Publish them?', options: [{ label: 'Publish', consequence: 'Out tonight', recommended: true }, { label: 'Edit', consequence: 'Waits' }], ...(thread ? { thread } : {}) },
});
const turnEnd = { type: 'turn:end', seq: 2, timestamp: NOW - 5 * 60_000, data: {} };

function calls(needsYou: PlayItem[], events: Array<{ type: string; seq: number; timestamp: number; data: unknown }> = [], open: ProjectOpenThread[] = []) {
  const byId = foldDecisions(events);
  return deriveCalls({
    needsYou,
    open,
    latestDecision: shownLatestDecision(events, byId),
    heldReplies: foldHeldReplies(events),
    repliedAt: repliedAt(events),
    now: NOW,
  });
}

describe('Your calls', () => {
  it('fades by age: fresh, recent, name only, then gone after a day', () => {
    expect(callStage(30 * 60_000)).toBe('fresh');
    expect(callStage(3 * HOUR)).toBe('recent');
    expect(callStage(12 * HOUR)).toBe('fading');
    expect(callStage(25 * HOUR)).toBeNull();
  });

  it('lists newest first, and keeps a day-old call while a live worker is still on its thread', () => {
    const listed = calls([item(1, 3 * HOUR), item(2, 30 * HOUR), item(3, 30 * HOUR, {}, 1), item(4, 0.2 * HOUR)]);
    expect(listed.map((call) => call.key)).toEqual(['t:4', 't:1', 't:3']);
    expect(listed.find((call) => call.key === 't:3')!.stage).toBe('fading');
  });

  it('names a card about a thread the coordinator owns by that thread, as a row for the card alone', () => {
    const owned = item(8, HOUR, { owner: { kind: 'coordinator' }, summary: 'Nine changes, in plain words.' }).thread;
    const [call] = calls([], [asked('d2', 8), turnEnd], [owned]);
    expect(call).toMatchObject({ key: 'd:d2', name: 'Name 8', ask: 'Publish them?', thread: null });
    expect(call.brief?.summary).toBe('Nine changes, in plain words.');
  });

  it('opens a thread onto its ask in full, and never shows its evidence pointers', () => {
    const [call] = calls([item(9, HOUR, { ask: '1. **Backstop?** I would go without one.\n2. Sleep or destroy?', summary: 'Draft 2 waits on you', evidence: ['endgame 719b438', 'report 10762'] })]);
    expect(call.askText).toBe('1. **Backstop?** I would go without one.\n2. Sleep or destroy?');
    expect(call.brief).toEqual({ summary: 'Draft 2 waits on you', next: null });
  });

  it('puts the card about a thread on that thread\'s row, with its options, aged from the card', () => {
    const [call] = calls([item(7, 10 * HOUR)], [asked('d1', 7), turnEnd]);
    expect(call).toMatchObject({ key: 't:7', name: 'Name 7', ask: 'Publish them?', stage: 'fresh' });
    expect(call.decision?.options.map((option) => option.label)).toEqual(['Publish', 'Edit']);
  });

  it('shows a held answer with its reply id, keeps the card from waiting meanwhile, and lets Undo reopen it', () => {
    const held = { type: 'reply:held', seq: 3, timestamp: NOW - 1000, data: { id: 'r1', target: { kind: 'answer', decision: 'd1' }, text: 'Publish', until: NOW + 5000, thread: 7 } };
    const events = [asked('d1', 7), turnEnd, held];
    expect(isOpenDecision(foldDecisions(events).get('d1')!)).toBe(false);
    expect(calls([item(7, HOUR)], events)[0].held).toEqual({ id: 'r1', text: 'Publish' });
    const undone = [...events, { type: 'reply:undone', seq: 4, timestamp: NOW, data: { id: 'r1' } }];
    expect(isOpenDecision(foldDecisions(undone).get('d1')!)).toBe(true);
    expect(calls([item(7, HOUR)], undone)[0].held).toBeNull();
  });

  it('shows an answered call as sent for a moment, then drops it until a new ask', () => {
    const answered = (at: number) => [asked('d1', 7), turnEnd, { type: 'decision:answered', seq: 3, timestamp: at, data: { id: 'd1', answer: 'Publish', inboxId: 'i1' } }];
    expect(calls([item(7, HOUR)], answered(NOW - 1000))[0].sent).toEqual({ text: 'Publish', at: NOW - 1000 });
    expect(calls([item(7, HOUR)], answered(NOW - CALL_LEAVE_MS - 1000))).toEqual([]);
    // Asked again since: fresh once more.
    expect(calls([item(7, 0)], answered(NOW - CALL_LEAVE_MS - 1000))).toHaveLength(1);
  });

  it('drops a thread once a reply about it has gone', () => {
    const events = [
      { type: 'reply:held', seq: 1, timestamp: NOW - 20_000, data: { id: 'r1', target: { kind: 'thread', thread: 2 }, text: 'Yes', until: NOW - 14_000 } },
      { type: 'reply:sent', seq: 2, timestamp: NOW - 14_000, data: { id: 'r1' } },
    ];
    expect(calls([item(2, HOUR)], events)).toEqual([]);
  });
});

describe('reading an ask', () => {
  const ask = 'The war ends when an empire breaks. Five questions:\n1. A backstop? Recommendation: no backstop.\n2. Sleep or destroy? Recommendation: sleep.\n3. What did you see?';

  it('finds the numbered questions and their recommendations, and drops the line announcing them', () => {
    expect(parseAsk(ask)).toEqual({
      context: 'The war ends when an empire breaks.',
      questions: [
        { text: 'A backstop?', recommendation: 'No backstop' },
        { text: 'Sleep or destroy?', recommendation: 'Sleep' },
        { text: 'What did you see?', recommendation: null },
      ],
    });
    expect(parseAsk('1. Backstop? 2. Sleep or destroy?')?.questions.map((q) => q.text)).toEqual(['Backstop?', 'Sleep or destroy?']);
  });

  it('leaves an ask without numbered questions as written', () => {
    expect(parseAsk('Ship version 2. It is ready?')).toBeNull();
    expect(parseAsk('Publish 0.4.1 tonight?')).toBeNull();
  });

  it('sends back every answer, the recommendation where it was kept', () => {
    expect(askAnswers(parseAsk(ask)!.questions, [null, 'Destroy it', 'Their capitals fell'])).toBe('1. No backstop\n2. Destroy it\n3. Their capitals fell');
    expect(askAnswers(parseAsk(ask)!.questions, [null, null, ' '])).toBe('1. No backstop\n2. Sleep\n3. No answer');
  });
});
