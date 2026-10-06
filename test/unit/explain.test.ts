import { describe, expect, it } from 'vitest';
import { concealOpenExplainReasoning, explainStatus, foldExplains, nextFlags, nextMarks, shownMark, splitSentences, type ExplainAskedData } from '../../src/types/explain.js';
import { placeDecisionsAtTurnEnd } from '../../src/types/decisions.js';

const ASKED: ExplainAskedData = {
  id: 'e1',
  prompt: 'Explain why the Earth has seasons.',
  ideas: [
    { id: 'tilt', label: 'The cause', statement: 'The axis is tilted.', hint: 'Does the Earth spin upright?' },
    { id: 'days', label: 'Days are longer', statement: 'Summer days are longer.', hint: 'What happens to day length?' },
  ],
  misconceptions: [{ id: 'm1', idea: 'tilt', statement: 'Seasons come from distance to the sun.', nudge: 'Why is it winter in Sydney?' }],
};

describe('nextMarks', () => {
  it('reads Jev\'s score as missing, partly there or got it', () => {
    expect(nextMarks(null, { tilt: { score: 1.5, confidence: 0.9 }, days: { score: 0.8, confidence: 0.9 } })).toEqual({ tilt: 'met', days: 'part' });
  });

  it('takes a mark away only when Jev is sure, so marks do not flicker while the user types', () => {
    const before = { tilt: 'met', days: 'met' } as const;
    expect(nextMarks(before, { tilt: { score: 0.2, confidence: 0.1 }, days: { score: 0.2, confidence: 0.8 } })).toEqual({ tilt: 'met', days: 'none' });
  });

  it('keeps a mark while the score sits just under its line', () => {
    expect(nextMarks({ tilt: 'met', days: 'part' }, { tilt: { score: 1.3, confidence: 0.9 }, days: { score: 0.65, confidence: 0.9 } })).toEqual({ tilt: 'met', days: 'part' });
    expect(nextMarks({ tilt: 'met' }, { tilt: { score: 1.1, confidence: 0.9 } })).toEqual({ tilt: 'part' });
    expect(nextMarks({ tilt: 'none' }, { tilt: { score: 1.3, confidence: 0.9 } })).toEqual({ tilt: 'part' });
  });

  it('raises a mark however unsure Jev is', () => {
    expect(nextMarks({ tilt: 'none' }, { tilt: { score: 1.6, confidence: 0.05 } })).toEqual({ tilt: 'met' });
  });
});

describe('nextFlags', () => {
  it('flags at 0.65, clears at 0.35 and holds in between', () => {
    const on = nextFlags([], [{ id: 'm1', p: 0.7, sentence: 'It is closer.' }]);
    expect(on).toEqual([{ id: 'm1', sentence: 'It is closer.' }]);
    expect(nextFlags(on, [{ id: 'm1', p: 0.5, sentence: null }])).toEqual(on);
    expect(nextFlags([], [{ id: 'm1', p: 0.5, sentence: null }])).toEqual([]);
    expect(nextFlags(on, [{ id: 'm1', p: 0.3, sentence: null }])).toEqual([]);
  });
});

describe('what the card shows', () => {
  it('turns the idea a flagged misconception undoes to Revisit, and says so in the status', () => {
    const marks = { tilt: 'met', days: 'met' } as const;
    const flags = [{ id: 'm1', sentence: null }];
    expect(shownMark(ASKED, marks, flags, 'tilt')).toBe('revisit');
    expect(shownMark(ASKED, marks, flags, 'days')).toBe('met');
    expect(explainStatus(ASKED, marks, flags)).toBe('revisit');
    expect(explainStatus(ASKED, marks, [])).toBe('demonstrated');
    expect(explainStatus(ASKED, { tilt: 'part', days: 'none' }, [])).toBe('add-more');
  });

  it('splits sentences where Jev is asked to point at one', () => {
    expect(splitSentences('It tilts. Days are longer!  So it is warmer?')).toEqual(['It tilts.', 'Days are longer!', 'So it is warmer?']);
    expect(splitSentences('it tilts\n\nso days are longer\nand warmer')).toEqual(['it tilts', 'so days are longer', 'and warmer']);
  });
});

describe('foldExplains', () => {
  it('keeps the latest check, each hint once, and the finish', () => {
    const check = (text: string) => ({ type: 'explain:checked', data: { id: 'e1', text, marks: {}, flags: [], status: 'keep-going' } });
    const state = foldExplains([
      { type: 'explain:asked', data: ASKED },
      check('It tilts'),
      { type: 'explain:hint', data: { id: 'e1', idea: 'days' } },
      { type: 'explain:hint', data: { id: 'e1', idea: 'days' } },
      check('It tilts and days are longer'),
      { type: 'explain:finished', data: { id: 'e1', passed: true, text: 'It tilts and days are longer', inboxId: 'in-1' } },
    ]).get('e1');
    expect(state?.last?.text).toBe('It tilts and days are longer');
    expect(state?.hints).toEqual(['days']);
    expect(state?.finished?.passed).toBe(true);
  });
});

describe('placing the card', () => {
  it('shows an explain-back below the message of the turn that asked it', () => {
    const events = [
      { type: 'explain:asked', seq: 1 },
      { type: 'content', seq: 2 },
      { type: 'turn:end', seq: 3 },
      { type: 'explain:checked', seq: 4 },
    ];
    expect(placeDecisionsAtTurnEnd(events).map((e) => e.seq)).toEqual([2, 3, 1, 4]);
  });
});

describe('concealOpenExplainReasoning', () => {
  const thinking = (seq: number) => ({ type: 'content', seq, data: { blocks: [{ type: 'thinking' }, { type: 'text' }] } });
  const events = [
    { type: 'input:sent', seq: 1, data: {} },
    thinking(2),
    { type: 'explain:asked', seq: 3, data: { id: 'e1' } },
    thinking(4),
    { type: 'turn:end', seq: 5, data: {} },
    { type: 'input:sent', seq: 6, data: {} },
    thinking(7),
  ];
  const kinds = (list: readonly { seq: number; data?: unknown }[]) => list.map((e) => (e.data as { blocks?: { type: string }[] }).blocks?.map((b) => b.type).join('+') ?? '');

  it('takes the reasoning out of the turn that posted an open card, and only that turn', () => {
    expect(kinds(concealOpenExplainReasoning(events))).toEqual(['', 'text', '', 'text', '', '', 'thinking+text']);
  });

  it('shows it again once the user finishes the card', () => {
    const done = [...events, { type: 'explain:finished', seq: 8, data: { id: 'e1' } }];
    expect(kinds(concealOpenExplainReasoning(done)).slice(0, 4)).toEqual(['', 'thinking+text', '', 'thinking+text']);
  });
});
