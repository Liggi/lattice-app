import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { foldDecisions, isOpenDecision, placeDecisionsAtTurnEnd, shownOpenDecision } from '../../src/types/decisions.js';
import { checkColdReadQuality, DecisionError, screenAgentAsk } from '../../src/services/sessions/decisions.js';
import type { JudgeVerdict } from '../../src/services/sessions/ask-judge.js';
import type { DecisionJudgedData } from '../../src/types/decisions.js';
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

  it('closes a card its agent withdrew, as withdrawn and not dismissed, keeping the reason', () => {
    const withdrawn = (reason?: string) => ({ type: 'decision:withdrawn', data: { id: 'a', ...(reason ? { reason } : {}) } });
    const decisions = foldDecisions([asked('a'), withdrawn('Answered in chat: keep holding'), asked('b')]);
    expect(decisions.get('a')).toMatchObject({ withdrawn: { reason: 'Answered in chat: keep holding' }, dismissed: false, replaced: false });
    expect(isOpenDecision(decisions.get('b')!)).toBe(true);
    expect(foldDecisions([asked('a'), withdrawn()]).get('a')).toMatchObject({ withdrawn: { reason: null } });
  });

  it('does not withdraw a card the user already answered', () => {
    const decisions = foldDecisions([asked('a'), answered('a', 'Decision card', 'in-1'), { type: 'decision:withdrawn', data: { id: 'a' } }]);
    expect(decisions.get('a')).toMatchObject({ answer: 'Decision card', withdrawn: null });
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

  it('is nothing once the question is answered, dismissed or withdrawn', () => {
    for (const closing of [answered('a', 'Worker types', 'in-1'), { type: 'decision:dismissed', data: { id: 'a' } }, { type: 'decision:withdrawn', data: { id: 'a' } }]) {
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

  it('expires a question the CLI cancelled or whose process closed, and keeps one whose turn merely ended', async () => {
    const { coordinator, addQuestion, markExpired, client } = setup();
    for (const s of ['cancelled', 'closed', 'idle']) coordinator.hold({ streamingId: s, requestId: 'r', toolName: 'AskUserQuestion', toolInput: input, toolUseId: 'confirm_1' });
    const [cancelled, closed, idle] = addQuestion.mock.calls.map((call) => call[0] as string);

    client.emit('claude-message', { streamingId: 'cancelled', message: { type: 'control_cancel_request', request_id: 'other' } });
    client.emit('claude-message', { streamingId: 'cancelled', message: { type: 'control_cancel_request', request_id: 'r' } });
    client.emit('process-closed', { streamingId: 'closed' });
    client.emit('turn-idle', { streamingId: 'idle' });

    expect(markExpired.mock.calls.map((call) => call[0])).toEqual([cancelled, closed]);
    expect(await coordinator.answer(cancelled, {})).toBe(false);
    expect(await coordinator.answer(idle, { 'Tabs or spaces?': 'Tabs' })).toBe(true);
  });

  it('leaves input with no questions to the permission flow', () => {
    const { coordinator } = setup();
    expect(coordinator.hold({ streamingId: 's', requestId: 'r', toolName: 'AskUserQuestion', toolInput: {} })).toBe(false);
  });
});

describe('checkColdReadQuality', () => {
  const baseOptions = [
    { label: 'Proceed', consequence: 'Deletes the stale dev model record and relaunches Arm 2.', recommended: true },
    { label: 'Hold', consequence: 'Leaves the record untouched until its owner clears it.' },
  ];
  const baseMeta = {
    requestKind: 'decision' as const,
    context: ['Arm 2 is blocked by a 4 Nov dev model record for JPV v128 that looks unused.'],
  };

  it('requires --kind and plain-English --context orientation', () => {
    expect(() => checkColdReadQuality('Delete the stale dev record?', baseOptions, { context: baseMeta.context })).toThrow(/Missing --kind/);
    expect(() => checkColdReadQuality('Delete the stale dev record?', baseOptions, { requestKind: 'decision' })).toThrow(/Missing orientation/);
    expect(() => checkColdReadQuality('Delete the stale dev record?', baseOptions, { requestKind: 'decision', context: ['short'] })).toThrow(/Missing orientation/);
    expect(() => checkColdReadQuality('Delete the stale dev record?', baseOptions, baseMeta)).not.toThrow();
  });

  it('rejects raw hashes, conversation ids, file paths, and chat pointers', () => {
    expect(() => checkColdReadQuality('Leave bf904e63 untouched?', baseOptions, baseMeta)).toThrow(/raw IDs, hashes, or file paths/);
    expect(() => checkColdReadQuality('Check conv-a1B2c3D4e5F6?', baseOptions, baseMeta)).toThrow(/raw IDs, hashes, or file paths/);
    expect(() => checkColdReadQuality('Review /Users/someone/src/app.ts?', baseOptions, baseMeta)).toThrow(/raw IDs, hashes, or file paths/);
    expect(() => checkColdReadQuality('Send the update?', baseOptions, {
      requestKind: 'go-ahead',
      context: ['The full text is in the chat above for you to check.'],
    })).toThrow(/Do not point the user back to chat/);
    // Normal versions, numbers, and model sizes are allowed.
    expect(() => checkColdReadQuality('Delete the stale 4 Nov dev record for JPV v128 so Arm 2 (397B) can launch?', baseOptions, baseMeta)).not.toThrow();
  });

  it('requires inline --draft for message/DM approvals and rejects permission slips to draft', () => {
    const dmOptions = [
      { label: 'Send as written', consequence: 'Posts the DM to Dana unchanged.', recommended: true },
      { label: 'Hold it', consequence: 'Nothing is sent.' },
    ];
    expect(() => checkColdReadQuality('Send this DM to Dana?', dmOptions, {
      requestKind: 'go-ahead',
      context: ['Dana asked whether the batch queue is clear tonight.'],
    })).toThrow(/no draft is attached/);
    expect(() => checkColdReadQuality('Send this DM to Dana?', dmOptions, {
      requestKind: 'go-ahead',
      context: ['Dana asked whether the batch queue is clear tonight.'],
      artifact: { kind: 'message', label: 'Draft', meta: 'Slack DM to Dana', body: 'Hey Dana — batches are clear.', editable: true },
    })).not.toThrow();

    expect(() => checkColdReadQuality('Ask Robin to stop the monitoring run?', [
      { label: 'Ask Robin', consequence: 'Drafts a short DM to Robin for your OK.', recommended: true },
      { label: 'Wait', consequence: 'Batches start at 19:25.' },
    ], {
      requestKind: 'go-ahead',
      context: ['Dana batches are queued behind Robin monitoring run until 19:25.'],
    })).toThrow(/Do not ask permission to draft/);
  });

  it('does not trip on URL query params or "post" used as a noun', () => {
    expect(() => checkColdReadQuality('When should every Release Board card show AshIndex without the ?ashindex link?', baseOptions, baseMeta)).not.toThrow();
    expect(() => checkColdReadQuality('Ship it? Or hold?', baseOptions, baseMeta)).toThrow(/one decision per card/);
    expect(() => checkColdReadQuality("Merge the fix so the Pulse post and DM quote the run's own failures?", baseOptions, baseMeta)).not.toThrow();
    expect(() => checkColdReadQuality('Post the summary as a Slack DM to Dana?', baseOptions, baseMeta)).toThrow(/no draft is attached/);
  });

  it('requires one captioned --image per visual option when choosing UI layouts', () => {
    const layoutOptions = [
      { label: 'B: one heading per queue', consequence: 'Splits waiting by reason with Stop on each row.', recommended: true },
      { label: 'A: polish in place', consequence: 'Keeps current layout with cleaner wording.' },
      { label: 'C: no Stop in the list', consequence: 'Moves Stop into the detail card.' },
    ];
    const layoutMeta = {
      requestKind: 'review' as const,
      context: ['Three layout directions are mocked up for the Runs queue page.'],
    };
    expect(() => checkColdReadQuality('Which Runs queue layout should be built?', layoutOptions, layoutMeta)).toThrow(/no image is attached/);
    expect(() => checkColdReadQuality('Which Runs queue layout should be built?', layoutOptions, {
      ...layoutMeta,
      artifact: { kind: 'image', label: 'Mockups', images: [{ src: '/api/images?path=/a.png', caption: 'A' }] },
    })).toThrow(/compares 3 visual options, but only 1 image/);
    expect(() => checkColdReadQuality('Which Runs queue layout should be built?', layoutOptions, {
      ...layoutMeta,
      artifact: {
        kind: 'image',
        label: 'Mockups',
        images: [
          { src: '/api/images?path=/a.png', caption: 'A' },
          { src: '/api/images?path=/b.png' },
          { src: '/api/images?path=/c.png', caption: 'C' },
        ],
      },
    })).toThrow(/give each one a caption/);
    expect(() => checkColdReadQuality('Which Runs queue layout should be built?', layoutOptions, {
      ...layoutMeta,
      artifact: {
        kind: 'image',
        label: 'Mockups',
        images: [
          { src: '/api/images?path=/a.png', caption: 'A: polish in place' },
          { src: '/api/images?path=/b.png', caption: 'B: one heading per queue' },
          { src: '/api/images?path=/c.png', caption: 'C: no Stop in the list' },
        ],
      },
    })).not.toThrow();
    // Single-visual approval with a "Not now" defer option only needs one image.
    expect(() => checkColdReadQuality('Ship this new Inbox layout?', [
      { label: 'Ship it', consequence: 'Deploys the new layout.', recommended: true },
      { label: 'Not now', consequence: 'Keeps the current layout.' },
    ], {
      requestKind: 'review',
      context: ['Redesigned the Inbox header to remove pill borders.'],
      artifact: { kind: 'image', label: 'Screenshot', images: [{ src: '/api/images?path=/new.png' }] },
    })).not.toThrow();
  });

  it('rejects bundled multi-question asks without false-positiving on ordinary non-visual asks', () => {
    expect(() => checkColdReadQuality('Merge both fixes? And should we keep Robin copies alive?', baseOptions, baseMeta)).toThrow(/one decision per card/);
    expect(() => checkColdReadQuality('Keep or cut United Earth Technocracy names?', [
      { label: 'Send picks', consequence: 'Applies the selected empire names.', recommended: true },
      { label: 'Not now', consequence: 'Leaves the draft list untouched.' },
    ], {
      requestKind: 'review',
      context: ['Generated 12 candidate empire names for the maritime star-republic preset.'],
    })).not.toThrow();
  });

  it('counts titles with a "?" as part of one question, and ", and how …" as a second', () => {
    expect(() => checkColdReadQuality('Is the Did it work? mock agreed?', baseOptions, baseMeta)).not.toThrow(/one decision per card/);
    expect(() => checkColdReadQuality("Add the 'Ready to train?' panel to the dataset page?", baseOptions, baseMeta)).not.toThrow(/one decision per card/);
    expect(() => checkColdReadQuality('Ship it? or hold?', baseOptions, baseMeta)).toThrow(/one decision per card/);
    expect(() => checkColdReadQuality('Ship the small fix, and what next for the larger fix?', baseOptions, baseMeta)).toThrow(/one decision per card/);
    expect(() => checkColdReadQuality('Build control-run reuse, and how old may a reused run be?', baseOptions, baseMeta)).toThrow(/one decision per card/);
  });

  it('reads "in chat" as a pointer only where it hides what the user needs, unless the attachment covers it', () => {
    const withConsequence = (consequence: string) => [baseOptions[0], { label: 'Other', consequence }];
    expect(() => checkColdReadQuality('Which signals should the readout show?', withConsequence('You describe it in chat and I scope from that.'), baseMeta)).not.toThrow();
    expect(() => checkColdReadQuality('What form should the explainer take?', withConsequence('A worker writes a short doc here in chat with diagrams.'), baseMeta)).not.toThrow();
    expect(() => checkColdReadQuality('Create both detectors now?', withConsequence('I create both with the wordings in my message.'), baseMeta)).toThrow(/point the user back to chat/);
    expect(() => checkColdReadQuality('Delete the stale dev record?', baseOptions, { ...baseMeta, context: ['Details are in my last report.'] })).toThrow(/point the user back to chat/);
    const pointer = { requestKind: 'go-ahead' as const, context: ['The full text is in the chat above.'] };
    expect(() => checkColdReadQuality('Ship the change?', baseOptions, {
      ...pointer,
      artifact: { kind: 'image', label: 'Dashboard', images: [{ src: '/api/images?path=/d.png' }] },
    })).toThrow(/point the user back to chat/);
    expect(() => checkColdReadQuality('Ship the change?', baseOptions, {
      ...pointer,
      artifact: { kind: 'text', label: 'Release note', body: 'Faster search and fewer timeouts.' },
    })).not.toThrow();
  });

  it('asks for images on "as mocked", "which … look" and icon choices, but not on screenshots or mock-ups as plain nouns', () => {
    const meta = { requestKind: 'review' as const, context: ['The new panel is mocked up and ready to build.'] };
    expect(() => checkColdReadQuality("Build 'Your calls' as mocked?", baseOptions, meta)).toThrow(/no image is attached/);
    expect(() => checkColdReadQuality('Which drawer look should ship?', baseOptions, meta)).toThrow(/no image is attached/);
    expect(() => checkColdReadQuality('Which run icon should ship?', baseOptions, meta)).toThrow(/no image is attached/);
    expect(() => checkColdReadQuality('Which name for the screenshot-tidying CLI?', baseOptions, meta)).not.toThrow();
    expect(() => checkColdReadQuality('How should the PR screenshots get hosted?', baseOptions, meta)).not.toThrow();
    expect(() => checkColdReadQuality('What should the next panel mock-up be?', baseOptions, meta)).not.toThrow();
  });

  it('catches agent-drafted-later messages, "Reply to …", "Tell <name> that …", Slack channel ids and home paths', () => {
    expect(() => checkColdReadQuality('How should the benchmark go to Morgan?', [
      { label: 'Send him the plan first', consequence: 'I draft a short message with the plan.', recommended: true },
      { label: 'Start building now', consequence: 'Morgan hears about it in parallel.' },
    ], baseMeta)).toThrow(/Do not ask permission to draft/);
    expect(() => checkColdReadQuality('What should the refactor do meanwhile?', [
      baseOptions[0],
      { label: 'Draft a note to Morgan', consequence: 'Asks when the stack will merge; you send it.' },
    ], baseMeta)).toThrow(/Do not ask permission to draft/);
    expect(() => checkColdReadQuality("Reply to Dana's thread with the new numbers?", baseOptions, baseMeta)).toThrow(/no draft is attached/);
    expect(() => checkColdReadQuality('Tell Casey and Jordan that the agent can now analyse arms?', baseOptions, baseMeta)).toThrow(/no draft is attached/);
    expect(() => checkColdReadQuality('How should a flagged reply show?', [
      { label: 'Reply in context', consequence: 'Shows the reply with the turns around it.', recommended: true },
      { label: 'Quote only', consequence: 'Shows the reply alone.' },
    ], baseMeta)).not.toThrow();
    expect(() => checkColdReadQuality('Post in the #C08AB12CD3E thread?', baseOptions, baseMeta)).toThrow(/raw IDs/);
    expect(() => checkColdReadQuality('Use the gateway key in ~/.config/gateway?', baseOptions, baseMeta)).toThrow(/raw IDs/);
  });
});

describe('screenAgentAsk', () => {
  const card = { question: 'Which settings layout should be built?', options: OPTIONS };
  const verdict = (pass: boolean): JudgeVerdict => ({
    pass,
    knowledgeNeeded: { what: 'Which product this is and what each layout looks like', level: 'high' },
    items: { O1: pass ? 'yes' : 'no', O2: 'yes', O3: 'yes', A1: 'yes', A2: pass ? 'yes' : 'no', A3: 'yes', S1: 'yes', S2: 'yes', S3: 'yes' },
    evidence: { O1: 'No product is named.', O2: '', O3: '', A1: '', A2: 'Only option A has an image.', A3: '', S1: '', S2: '', S3: '' },
    imagesSent: 1, model: 'test', effort: 'high', usage: { input: 1, output: 1 }, costUsd: 0.01, ms: 5,
  });
  const deps = (...results: Array<boolean | Error>) => {
    const log: DecisionJudgedData[] = [];
    const judge = vi.fn(async () => { const r = results.shift()!; if (r instanceof Error) throw r; return verdict(r); });
    return { log, deps: { judge, record: (d: DecisionJudgedData) => log.push(d), now: () => 1000 } };
  };

  it('bounces a failing card with what it needs and what is missing, then lets the next ask through', async () => {
    const { log, deps: d } = deps(false, false);
    const bounce = await screenAgentAsk('conv-bounce', card, d).catch((e: unknown) => e);
    expect(bounce).toBeInstanceOf(DecisionError);
    expect((bounce as DecisionError).message).toMatch(/What deciding it needs \(high\): Which product.*\n.*No product is named.*\n.*Only option A has an image/s);
    await expect(screenAgentAsk('conv-bounce', card, d)).resolves.toBeUndefined();
    expect(log.map((e) => [e.outcome, e.secondTry])).toEqual([['bounced', false], ['let-through', true]]);
    expect(log[0]).toMatchObject({ failed: ['O1', 'A2'], costUsd: 0.01, knowledgeLevel: 'high' });
  });

  it('passes a good card first time, and a pass on the retry is logged as a pass', async () => {
    const { log, deps: d } = deps(true, false, true);
    await screenAgentAsk('conv-pass', card, d);
    await expect(screenAgentAsk('conv-pass', card, d)).rejects.toThrow(DecisionError);
    await screenAgentAsk('conv-pass', card, d);
    expect(log.map((e) => [e.outcome, e.secondTry])).toEqual([['passed', false], ['bounced', false], ['passed', true]]);
  });

  it('lets the ask through and logs the error when the judge fails', async () => {
    const { log, deps: d } = deps(new Error('No Anthropic API key is configured'));
    await expect(screenAgentAsk('conv-error', card, d)).resolves.toBeUndefined();
    expect(log).toEqual([{ question: card.question, outcome: 'judge-error', secondTry: false, error: 'No Anthropic API key is configured' }]);
  });
});
