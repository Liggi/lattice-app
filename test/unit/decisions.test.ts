import { describe, expect, it, vi } from 'vitest';
import { foldDecisions, isOpenDecision, placeDecisionsAtTurnEnd } from '../../src/types/decisions.js';
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

  it('keeps a question last while its turn is still running', () => {
    const events = [{ type: 'decision:asked', seq: 1 }, { type: 'content', seq: 2 }];
    expect(placeDecisionsAtTurnEnd(events).map((e) => e.seq)).toEqual([2, 1]);
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
    const coordinator = new ClaudeQuestionCoordinator(
      { respondToControlRequest: respond } as unknown as ProcessManagerClient,
      { addQuestion } as unknown as PendingQuestionService,
      { sessionIdForStreaming: () => 'session-1' } as unknown as PermissionTracker,
    );
    return { coordinator, respond, addQuestion };
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

  it('leaves input with no questions to the permission flow', () => {
    const { coordinator } = setup();
    expect(coordinator.hold({ streamingId: 's', requestId: 'r', toolName: 'AskUserQuestion', toolInput: {} })).toBe(false);
  });
});
