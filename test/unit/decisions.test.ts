import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { foldDecisions, isOpenDecision, placeDecisionsAtTurnEnd, shownOpenDecision } from '../../src/types/decisions.js';
import { ClaudeQuestionCoordinator } from '../../src/services/process/claude-question-coordinator.js';
import type { PendingQuestionService } from '../../src/services/pending-question-service.js';
import type { ProcessManagerClient } from '../../src/process-daemon/process-manager-client.js';
import type { PermissionTracker } from '../../src/services/permission-tracker.js';

const OPTIONS = [
  { label: 'Worker types', consequence: 'Measure the briefs first' },
  { label: 'Decision card', consequence: 'Mock it up first' },
];

const asked = (id: string) => ({ type: 'decision:asked', data: { id, question: `Question ${id}?`, options: OPTIONS } });
const answered = (id: string, answer: string, inboxId: string) => ({ type: 'decision:answered', data: { id, answer, inboxId } });

describe('foldDecisions', () => {
  it('tracks the latest answer and whether the agent has read it', () => {
    const decisions = foldDecisions([
      asked('a'),
      answered('a', 'Worker types', 'in-1'),
      { type: 'input:read', data: { ids: ['in-1'] } },
      answered('a', 'Decision card', 'in-2'),
    ]);
    expect(decisions.get('a')).toMatchObject({ answer: 'Decision card', read: false, replaced: false, latest: true });
  });

  it('replaces an unanswered question with the next one, but not an answered one', () => {
    const decisions = foldDecisions([asked('a'), answered('a', 'Worker types', 'in-1'), asked('b'), asked('c')]);
    expect(decisions.get('a')).toMatchObject({ replaced: false, latest: false });
    expect(decisions.get('b')).toMatchObject({ replaced: true, latest: false });
    expect(decisions.get('c')).toMatchObject({ replaced: false, latest: true });
  });

  it('reads the replacement, not the withdrawn answer', () => {
    const decisions = foldDecisions([
      asked('a'),
      answered('a', 'Worker types', 'in-1'),
      { type: 'input:withdrawn', data: { ids: ['in-1'] } },
      answered('a', 'Decision card', 'in-2'),
      { type: 'input:read', data: { ids: ['in-2'] } },
    ]);
    expect(decisions.get('a')).toMatchObject({ answer: 'Decision card', read: true });
  });
});

describe('a message written while the card is open', () => {
  const settled = (id: string) => ({ type: 'decision:settled', data: { id } });

  it('settles the card, so it is neither open nor replaced by the next question', () => {
    const decisions = foldDecisions([asked('a'), settled('a'), asked('b')]);
    expect(decisions.get('a')).toMatchObject({ answer: null, settled: true, replaced: false, latest: false });
    expect(isOpenDecision(decisions.get('b')!)).toBe(true);
  });

  it('closes a card when the user dismisses the thread it was about', () => {
    const decisions = foldDecisions([asked('a'), { type: 'decision:dismissed', data: { id: 'a' } }]);
    expect(decisions.get('a')).toMatchObject({ dismissed: true, answer: null });
    expect(isOpenDecision(decisions.get('a')!)).toBe(false);
  });

  it('does not settle a card that was already answered with a tap', () => {
    const decisions = foldDecisions([asked('a'), answered('a', 'Decision card', 'in-1'), settled('a')]);
    expect(decisions.get('a')).toMatchObject({ answer: 'Decision card', settled: false });
  });

  it('places a card still in its running turn just above the message that settled it', () => {
    const events = [
      { type: 'content', seq: 1 },
      { type: 'decision:asked', seq: 2 },
      { type: 'decision:settled', seq: 3 },
      { type: 'input:sent', seq: 4 },
      { type: 'turn:end', seq: 5 },
    ];
    expect(placeDecisionsAtTurnEnd(events).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('shownOpenDecision', () => {
  const at = (seq: number, event: { type: string; data: unknown }) => ({ ...event, seq });

  it('is the open question once its turn has ended, with its message id', () => {
    const events = [at(1, asked('a')), at(2, { type: 'content', data: {} })];
    const byId = foldDecisions(events);
    expect(shownOpenDecision(placeDecisionsAtTurnEnd(events), byId)).toBeNull();
    const ended = [...events, at(3, { type: 'turn:end', data: {} })];
    expect(shownOpenDecision(placeDecisionsAtTurnEnd(ended), foldDecisions(ended))).toMatchObject({ asked: { id: 'a' }, messageId: 'h-1' });
  });

  it('is nothing once the question is answered or dismissed', () => {
    for (const closing of [answered('a', 'Worker types', 'in-1'), { type: 'decision:dismissed', data: { id: 'a' } }]) {
      const events = [at(1, asked('a')), at(2, { type: 'turn:end', data: {} }), at(3, closing)];
      expect(shownOpenDecision(placeDecisionsAtTurnEnd(events), foldDecisions(events))).toBeNull();
    }
  });
});

describe('placeDecisionsAtTurnEnd', () => {
  it('moves a question below the message its turn wrote after asking', () => {
    const events = [
      { type: 'content', seq: 1 },
      { type: 'decision:asked', seq: 2 },
      { type: 'content', seq: 3 },
      { type: 'turn:end', seq: 4 },
      { type: 'input:sent', seq: 5 },
    ];
    expect(placeDecisionsAtTurnEnd(events).map((e) => e.seq)).toEqual([1, 3, 4, 2, 5]);
  });

  it('does not show a question while its turn is still running', () => {
    // The order conv-oNjAHy-gnu7i logged: the card at 12, the message it leads to at 21.
    const events = [
      { type: 'content', seq: 11 },
      { type: 'decision:asked', seq: 12 },
      { type: 'result', seq: 13 },
      { type: 'content', seq: 21 },
    ];
    expect(placeDecisionsAtTurnEnd(events).map((e) => e.seq)).toEqual([11, 13, 21]);
    expect(placeDecisionsAtTurnEnd([...events, { type: 'turn:end', seq: 22 }]).map((e) => e.seq)).toEqual([11, 13, 21, 22, 12]);
  });

  it('shows a question whose turn ended in an error or with the process', () => {
    for (const end of ['run:error', 'run:end']) {
      const events = [{ type: 'decision:asked', seq: 1 }, { type: 'content', seq: 2 }, { type: end, seq: 3 }];
      expect(placeDecisionsAtTurnEnd(events).map((e) => e.seq)).toEqual([2, 3, 1]);
    }
  });

  it('does not treat a compaction boundary as the end of the asking turn', () => {
    const events = [
      { type: 'decision:asked', seq: 1 },
      { type: 'turn:end', seq: 2, data: { compact: true } },
      { type: 'content', seq: 3 },
      { type: 'turn:end', seq: 4 },
    ];
    expect(placeDecisionsAtTurnEnd(events).map((e) => e.seq)).toEqual([2, 3, 4, 1]);
  });

  it('shows a question that holds its turn open at once', () => {
    const events = [{ type: 'content', seq: 1 }, { type: 'decision:asked', seq: 2, data: { holdsTurn: true } }];
    expect(placeDecisionsAtTurnEnd(events).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('places a question answered mid-turn above its answer', () => {
    const events = [
      { type: 'decision:asked', seq: 1 },
      { type: 'content', seq: 2 },
      { type: 'decision:answered', seq: 3 },
      { type: 'content', seq: 4 },
      { type: 'turn:end', seq: 5 },
    ];
    expect(placeDecisionsAtTurnEnd(events).map((e) => e.seq)).toEqual([2, 1, 3, 4, 5]);
  });
});

describe('ClaudeQuestionCoordinator', () => {
  const setup = () => {
    const respond = vi.fn().mockResolvedValue(true);
    const addQuestion = vi.fn();
    const markExpired = vi.fn();
    const client = Object.assign(new EventEmitter(), { respondToControlRequest: respond });
    const coordinator = new ClaudeQuestionCoordinator(
      client as unknown as ProcessManagerClient,
      { addQuestion, markExpired } as unknown as PendingQuestionService,
      { sessionIdForStreaming: () => 'session-1' } as unknown as PermissionTracker,
    );
    return { coordinator, respond, addQuestion, markExpired, client };
  };
  const input = { questions: [{ question: 'Tabs or spaces?', options: [{ label: 'Tabs' }, { label: 'Spaces' }] }] };

  it('holds the request and answers it once with the answers in updatedInput', async () => {
    const { coordinator, respond, addQuestion } = setup();
    expect(coordinator.hold({ streamingId: 's', requestId: 'r', toolName: 'AskUserQuestion', toolInput: input, toolUseId: 'toolu_1' })).toBe(true);
    const id = addQuestion.mock.calls[0][0] as string;
    expect(id.startsWith('claude-question-')).toBe(true);
    expect(addQuestion.mock.calls[0].slice(1, 4)).toEqual(['session-1', 's', 'toolu_1']);

    expect(await coordinator.answer(id, { 'Tabs or spaces?': 'Tabs' })).toBe(true);
    expect(respond).toHaveBeenCalledWith('s', 'r', { behavior: 'allow', updatedInput: { ...input, answers: { 'Tabs or spaces?': 'Tabs' } } });
    expect(await coordinator.answer(id, { 'Tabs or spaces?': 'Spaces' })).toBe(false);
  });

  it('expires a question whose turn ended or process closed unanswered, and leaves other streams waiting', async () => {
    const { coordinator, addQuestion, markExpired, client } = setup();
    for (const s of ['stopped', 'closed', 'live']) coordinator.hold({ streamingId: s, requestId: 'r', toolName: 'AskUserQuestion', toolInput: input });
    const [stopped, closed, live] = addQuestion.mock.calls.map((call) => call[0] as string);

    client.emit('turn-idle', { streamingId: 'stopped' });
    client.emit('process-closed', { streamingId: 'closed' });

    expect(markExpired.mock.calls.map((call) => call[0])).toEqual([stopped, closed]);
    expect(await coordinator.answer(stopped, {})).toBe(false);
    expect(await coordinator.answer(live, { 'Tabs or spaces?': 'Tabs' })).toBe(true);
  });

  it('leaves input with no questions to the permission flow', () => {
    const { coordinator } = setup();
    expect(coordinator.hold({ streamingId: 's', requestId: 'r', toolName: 'AskUserQuestion', toolInput: {} })).toBe(false);
  });
});
