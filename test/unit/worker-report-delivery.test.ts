import { describe, expect, it } from 'vitest';
import { readLastTurn } from '../../src/services/sessions/worker-report-delivery.js';
import { isBareWait, isQuietRepeat, isWorkerQuestion } from '../../src/types/worker-events.js';
import type { RawEvent } from '../../src/session-history/types.js';

let seq = 0;
function event(type: RawEvent['type'], data: unknown = {}): RawEvent {
  seq += 1;
  return { conversationId: 'conv-w', seq, runId: 'run-1', timestamp: 1_700_000_000_000 + seq, type, data, meta: null };
}
const input = (text: string) => event('input:sent', { text });
const said = (text: string, messageId: string) => event('content', { blocks: [{ type: 'text', text }], messageId });
const called = (messageId: string) => event('content', { blocks: [{ type: 'tool_use', name: 'Bash', input: {} }], messageId });
const returned = () => event('result', { blocks: [{ type: 'tool_result', tool_use_id: 't' }] });
const ended = () => event('turn:end', { usage: {} });
const command = () => event('input:sent', { text: '/compact', source: 'command' });
// A compaction the server ran: the command input, then the provider's phases.
// Failure ends on synthetic assistant text and a plain turn:end, success on a
// compact boundary and a second, empty turn:end.
const compactionFailed = () => [
  command(),
  event('context:compaction', { phase: 'started' }),
  event('context:compaction', { phase: 'failed', result: 'failed', error: 'Not enough messages to compact.' }),
  said('Not enough messages to compact.', 'synthetic-1'),
  ended(),
];
const compactionSucceeded = () => [
  command(),
  event('context:compaction', { phase: 'started' }),
  event('context:compaction', { phase: 'completed', result: 'success' }),
  event('turn:end', { compact: true, trigger: 'manual', preTokens: 28465, postTokens: 5894 }),
  event('result', { blocks: [] }),
  ended(),
];
// The shape a compaction the provider ran mid-turn leaves in the log.
const compacted = () => [
  event('context:compaction', { phase: 'started' }),
  event('context:compaction', { phase: 'completed', result: 'success' }),
  event('turn:end', { compact: true, trigger: 'auto' }),
  event('result', { blocks: [] }),
];

const REPORT = 'All work is done and verified.\n\n## Changes\n\n- sweep follows the corners';

describe('readLastTurn', () => {
  it('delivers the reply the worker ended on, not its progress lines', () => {
    // The shape of every long worker turn on 2026-09-20: narration between
    // tool calls, then the report. The thread used to show the narration.
    const events = [
      input('first ask'),
      said('old answer', 'm0'),
      ended(),
      input('Fix the composer.'),
      said('Now the composer sweep CSS.', 'm1'),
      called('m1'),
      returned(),
      said('Now the SessionCard alignment.', 'm2'),
      called('m2'),
      returned(),
      said(REPORT, 'm3'),
      ended(),
    ];
    expect(readLastTurn(events)).toMatchObject({ reply: REPORT });
  });

  it('classifies a question by the final reply, so narration before it does not hide it', () => {
    const events = [
      input('Investigate.'),
      said('Both invariant questions are fair. Investigating before any spend.', 'm1'),
      called('m1'),
      returned(),
      said('**Question for front:** both invariants failed; should I spend on a bounded A/B?', 'm2'),
      ended(),
    ];
    const turn = readLastTurn(events);
    expect(turn.reply).toBe('**Question for front:** both invariants failed; should I spend on a bounded A/B?');
    expect(isWorkerQuestion(turn.reply!)).toBe(true);
  });

  it("delivers nothing at a compaction's turn:end, then the real reply whole", () => {
    const events = [
      input('Fix the composer.'),
      said('Now the composer sweep CSS.', 'm1'),
      called('m1'),
      returned(),
      ...compacted(),
    ];
    expect(readLastTurn(events)).toEqual({ reply: null, reason: 'compacting' });

    // The worker carries on with no new input; its real turn:end follows.
    events.push(said('Now the SessionCard alignment.', 'm2'), called('m2'), returned(), said(REPORT, 'm3'), ended());
    expect(readLastTurn(events)).toMatchObject({ reply: REPORT });
  });

  it('delivers nothing when a compaction follows a delivered reply', () => {
    const events = [input('Fix the composer.'), said(REPORT, 'm1'), ended(), ...compacted()];
    expect(readLastTurn(events)).toEqual({ reply: null, reason: 'compacting' });
  });

  it('delivers nothing when the turn ended on a tool call', () => {
    const events = [input('Fix the composer.'), said('Now the composer sweep CSS.', 'm1'), called('m1'), returned(), ended()];
    expect(readLastTurn(events)).toEqual({ reply: null, reason: 'no-reply' });
  });

  it('follows block order when text and a tool call share one content event', () => {
    // The Claude adapter writes an assistant message's blocks into one event
    // (`normalize-claude.js`); 12,097 stored events of this shape, 2026-03/04.
    const together = (text: string, messageId: string) =>
      event('content', { blocks: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash', input: {} }], messageId });
    const events = [input('Fix the composer.'), together('Now the composer sweep CSS.', 'm1'), returned(), ended()];
    expect(readLastTurn(events)).toEqual({ reply: null, reason: 'no-reply' });

    const after = event('content', { blocks: [{ type: 'tool_use', name: 'Bash', input: {} }, { type: 'text', text: REPORT }], messageId: 'm2' });
    expect(readLastTurn([input('Fix the composer.'), called('m1'), returned(), after, ended()])).toMatchObject({ reply: REPORT });
  });

  it('marks a turn that ended on a stop request as interrupted', () => {
    const events = [
      input('second ask'),
      said('Four bounded fixes. Starting with the guard.', 'm2'),
      event('stop:requested'),
      event('result', { blocks: [] }),
      ended(),
    ];
    expect(readLastTurn(events)).toEqual({ reply: null, reason: 'interrupted' });
  });

  it('delivers nothing when a compaction the server ran failed', () => {
    // The provider answers a failed `/compact` with synthetic assistant text
    // and an ordinary turn:end, so nothing about the turn's shape says it was
    // not a reply; the command input that opened it does.
    const events = [input('Fix the composer.'), said(REPORT, 'm1'), ended(), ...compactionFailed()];
    expect(readLastTurn(events)).toEqual({ reply: null, reason: 'control-operation' });
  });

  it('delivers nothing at either turn:end of a compaction the server ran', () => {
    const events = [input('Fix the composer.'), said(REPORT, 'm1'), ended(), ...compactionSucceeded()];
    expect(readLastTurn(events.slice(0, -2))).toEqual({ reply: null, reason: 'control-operation' });
    expect(readLastTurn(events)).toEqual({ reply: null, reason: 'control-operation' });
  });

  it('delivers the next real reply after a compaction the server ran', () => {
    const events = [
      input('Fix the composer.'),
      said('Now the composer sweep CSS.', 'm1'),
      ended(),
      ...compactionFailed(),
      input('Carry on.'),
      said(REPORT, 'm2'),
      ended(),
    ];
    expect(readLastTurn(events)).toMatchObject({ reply: REPORT });
  });

  it('delivers a turn Claude opened itself after a compaction the server ran', () => {
    // A Monitor or background task reporting back opens a turn with no
    // input:sent. After the 200K auto-compaction on 2026-09-26 every such
    // turn read as the compaction's, and a worker's question never arrived.
    const events = [input('Fix the composer.'), said(REPORT, 'm1'), ended(), ...compactionSucceeded()];
    events.push(event('run:ready'), said('Waiting on: the next scene.', 'm2'), ended());
    expect(readLastTurn(events)).toMatchObject({ reply: 'Waiting on: the next scene.' });

    events.push(event('run:ready'), called('m3'), returned(), said('Question for front: is the user playing?', 'm4'), ended());
    expect(readLastTurn(events)).toMatchObject({ reply: 'Question for front: is the user playing?' });
  });

  it('does not deliver the previous reply again for a self-opened turn with none', () => {
    const events = [input('Fix the composer.'), said(REPORT, 'm1'), ended(), event('run:ready'), ended()];
    expect(readLastTurn(events)).toEqual({ reply: null, reason: 'no-reply' });
  });

  it('does not count a stop request from an earlier turn', () => {
    const events = [
      input('first ask'),
      event('stop:requested'),
      ended(),
      input('Stop work here.'),
      said('Stopped.', 'm4'),
      ended(),
    ];
    expect(readLastTurn(events)).toMatchObject({ reply: 'Stopped.' });
  });
});

// 2026-09-29: each of a worker's four subagents finishing woke it, and every
// wake-up sent its coordinator another "Waiting on: N remaining lookups".
describe('a wake-up turn that only repeats the wait', () => {
  it('knows a turn its own task opened from one a message opened', () => {
    const woken = [input('Look into it.'), said('Waiting on: four lookups', 'm1'), ended(), event('run:ready'), said('Waiting on: three lookups', 'm2'), ended()];
    expect(readLastTurn(woken)).toEqual({ reply: 'Waiting on: three lookups', selfStarted: true });
    const asked = [...woken, input('Where are you?'), said('Waiting on: three lookups', 'm3'), ended()];
    expect(readLastTurn(asked)).toEqual({ reply: 'Waiting on: three lookups', selfStarted: false });
  });

  it('is a bare wait only when nothing follows the wait line', () => {
    expect(isBareWait('Waiting on: two remaining read-only code lookups (training data, other readers)')).toBe(true);
    expect(isBareWait('**Waiting on:**\nthe sleep subagent')).toBe(true);
    expect(isBareWait('Waiting on: one lookup\n\nThe Reader lookup came back: it shows summaries only.')).toBe(false);
    expect(isBareWait('Done: the subagent finished.')).toBe(false);
    expect(isBareWait('Waiting on: nothing.')).toBe(false);
  });

  it('holds back a woken reply that repeats the last report exactly, or only repeats a wait', () => {
    const done = { phase: 'reported' as const, waitingOn: null, text: 'Done: both lookups finished.' };
    expect(isQuietRepeat('Done: both lookups finished.', done)).toBe(true);
    expect(isQuietRepeat('Done: both lookups finished', done)).toBe(false);
    const waiting = { phase: 'reported' as const, waitingOn: 'two lookups', text: 'Waiting on: two lookups' };
    expect(isQuietRepeat('Waiting on: one remaining lookup', waiting)).toBe(true);
    expect(isQuietRepeat('Done: both lookups finished.', waiting)).toBe(false);
    expect(isQuietRepeat('Done: both lookups finished.', { ...done, phase: 'working' })).toBe(false);
    expect(isQuietRepeat('Done: both lookups finished.', null)).toBe(false);
  });
});
