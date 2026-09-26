/**
 * The join between a report and its summary.
 *
 * The summary is written after the report and lands later in the coordinator's
 * log, so the two are separate events tied together only by `reportSeq`. Get
 * that wrong and the failure is silent in the worst direction: a summary drawn
 * on the wrong report, or a card that reads as unsummarised forever.
 *
 * The summary is also not a thread item of its own — it must not appear as a
 * block between the report and whatever the coordinator did next.
 */

import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { eventsToMessages } from '../../src/web/chat/hooks/useHarnessSession.js';
import { WORKER_REPORT_SUMMARY_EVENT } from '../../src/types/worker-events.js';

const noProviders = new Map<number, 'claude' | 'codex'>();

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { sessionId: 'conv-c', seq, runId: 'run-1', timestamp: 1_700_000_000_000 + seq, type, data } as SessionEvent;
}
const reported = (seq: number, text: string) =>
  event(seq, 'worker:reported', { worker: 'conv-w', model: 'claude-opus-5', text });
const summary = (seq: number, reportSeq: number, title: string) =>
  event(seq, WORKER_REPORT_SUMMARY_EVENT, { worker: 'conv-w', reportSeq, title, text: `${title}, at length.`, model: 'claude-sonnet-5' });

describe('report summaries in the thread', () => {
  it('attaches a summary to the report it names, however much later it arrives', () => {
    const messages = eventsToMessages(
      [
        reported(10, 'first report'),
        event(11, 'worker:answered', { worker: 'conv-w', text: 'carry on', summary: null, question: null, passedOn: false }),
        summary(12, 10, 'Header and sidebar simplified'),
      ],
      noProviders,
    );
    const card = messages.find((message) => message.workerEvent?.type === 'worker:reported');
    expect(card?.workerEvent?.reportSummary?.title).toBe('Header and sidebar simplified');
  });

  it('gives each report its own summary when a worker has reported more than once', () => {
    const messages = eventsToMessages(
      [reported(10, 'first report'), reported(20, 'second report'), summary(21, 20, 'Second result'), summary(22, 10, 'First result')],
      noProviders,
    );
    const cards = messages.filter((message) => message.workerEvent?.type === 'worker:reported');
    expect(cards.map((card) => card.workerEvent?.reportSummary?.title)).toEqual(['First result', 'Second result']);
  });

  it('leaves a report with no summary alone', () => {
    const messages = eventsToMessages([reported(10, 'first report'), summary(11, 99, 'Some other report')], noProviders);
    const card = messages.find((message) => message.workerEvent?.type === 'worker:reported');
    expect(card?.workerEvent?.reportSummary).toBeUndefined();
    expect((card?.workerEvent?.data as { text: string }).text).toBe('first report');
  });

  it('ignores a half-written summary rather than drawing an empty one', () => {
    const messages = eventsToMessages(
      [reported(10, 'first report'), event(11, WORKER_REPORT_SUMMARY_EVENT, { worker: 'conv-w', reportSeq: 10, title: '', text: '' })],
      noProviders,
    );
    expect(messages.find((message) => message.workerEvent?.type === 'worker:reported')?.workerEvent?.reportSummary)
      .toBeUndefined();
  });

  it('never renders the summary as a thread item of its own', () => {
    const messages = eventsToMessages([reported(10, 'first report'), summary(11, 10, 'Header and sidebar simplified')], noProviders);
    expect(messages).toHaveLength(1);
  });

  it('keeps the report itself exactly as stored', () => {
    const text = '# Result\n\nThe change is written but not deployed.\n\n- one\n- two';
    const messages = eventsToMessages([reported(10, text), summary(11, 10, 'Change written')], noProviders);
    expect((messages[0].workerEvent?.data as { text: string }).text).toBe(text);
  });
});
