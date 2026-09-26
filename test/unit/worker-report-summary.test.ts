/**
 * The report-card summary: what the writer is told, what comes back is
 * allowed to be, and what reaches the coordinator's log.
 *
 * The prose itself is not judged here — that was checked by hand against real
 * reports. What is checked is everything around it that fails silently: that
 * the report still reaches the coordinator whole and unchanged, that the
 * summary never becomes an input to it, that a badly shaped result leaves the
 * card showing the report rather than a half-sentence, and that the same
 * report is never summarised twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setGenerationOverridesForTests } from '../../src/services/infrastructure/generation-gates.js';

const log: { events: Array<{ seq: number; type: string; data: unknown }> } = { events: [] };
const appended: Array<{ conversationId: string; type: string; data: unknown }> = [];
const messagesCreate = vi.fn();
const client: { value: unknown } = { value: { messages: { create: messagesCreate } } };

vi.mock('../../src/session-history/repository.js', () => ({
  getEvents: () => log.events,
}));
vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({}),
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_manager: unknown, conversationId: string, type: string, data: unknown) => {
    appended.push({ conversationId, type, data });
    const event = { seq: 900 + appended.length, type, data };
    log.events.push(event);
    return event;
  },
}));
vi.mock('../../src/services/infrastructure/anthropic-client-factory.js', () => ({
  anthropicClientFactory: { getClient: () => client.value },
}));
vi.mock('../../src/services/infrastructure/cost-tracker.js', () => ({
  getCostTracker: () => ({ log: () => {} }),
}));

const { buildSummaryPrompt, noteWorkerReport, summaryModel } = await import(
  '../../src/services/sessions/worker-report-summary.js'
);
const { reportSummaryPoints, usableReportSummary, WORKER_REPORT_SUMMARY_EVENT } = await import('../../src/types/worker-events.js');

const REPORT = [
  'Header and sidebar simplified.',
  '',
  'The Catch me up button and the commitments chip are gone. On mobile the sidebar and menu buttons now sit',
  'together at the top right.',
  '',
  'I clicked through both widths in the running app and typecheck and lint pass. The backend removal is written',
  'but the routes are still registered in the running server until it restarts.',
].join('\n');

function answer(text: string) {
  return { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 } };
}

/** Let the fire-and-forget write finish before asserting on the log. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  log.events = [
    { seq: 12, type: 'worker:started', data: { worker: 'conv-w', provider: 'claude', model: 'claude-opus-5', task: 'Simplify the header and sidebar' } },
    { seq: 41, type: 'worker:reported', data: { worker: 'conv-w', model: 'claude-opus-5', text: REPORT } },
  ];
  appended.length = 0;
  messagesCreate.mockReset();
  client.value = { messages: { create: messagesCreate } };
  __setGenerationOverridesForTests({ workerReportSummary: true });
});
afterEach(() => __setGenerationOverridesForTests(null));

describe('what the summary is not', () => {
  it('is not a worker event, so nothing that folds them can carry it', async () => {
    // The fold is what the Workers panel, the history list, the CLI thread and
    // the project state's pending attention all read. A summary in there would
    // become a second report — a shorter, model-written one — everywhere a
    // report counts for something.
    const { isWorkerEventType, WORKER_EVENT_TYPES } = await import('../../src/types/worker-events.js');
    expect(isWorkerEventType(WORKER_REPORT_SUMMARY_EVENT)).toBe(false);
    expect(WORKER_EVENT_TYPES as readonly string[]).not.toContain(WORKER_REPORT_SUMMARY_EVENT);
  });
});

describe('usableReportSummary', () => {
  it('takes the first line as the title and keeps each fact on its own line', () => {
    const summary = usableReportSummary(
      'Header and sidebar simplified\n\n- The controls are gone.\n- Mobile was checked.\n- The backend needs a restart.',
    );
    expect(summary).toEqual({
      title: 'Header and sidebar simplified',
      text: 'The controls are gone.\nMobile was checked.\nThe backend needs a restart.',
    });
  });

  it('accepts a title the model dressed as a heading', () => {
    expect(usableReportSummary('## **Sidebar layout rejected:**\n\nThe user turned it down.')?.title)
      .toBe('Sidebar layout rejected');
  });

  it('rejects a title alone, a body alone, and an empty answer', () => {
    expect(usableReportSummary('Header and sidebar simplified')).toBeNull();
    expect(usableReportSummary('\n\n')).toBeNull();
    expect(usableReportSummary('')).toBeNull();
  });

  it('rejects a title that is really a sentence, a paragraph, and more facts than a card holds', () => {
    expect(usableReportSummary(`${'word '.repeat(30)}\n\n- body`)).toBeNull();
    // A writer that answered in prose gives one line far past the per-line bound.
    expect(usableReportSummary(`A title\n\n${'sentence '.repeat(60)}`)).toBeNull();
    expect(usableReportSummary(`A title\n\n${'- one fact\n'.repeat(6)}`)).toBeNull();
  });

  it('takes a fifth fact rather than dropping the summary and showing the whole report', () => {
    // The prompt asks for four. A writer that adds one more is still giving a
    // card that reads faster than the report underneath it.
    expect(usableReportSummary(`A title\n\n${'- one fact\n'.repeat(5)}`)?.text.split('\n')).toHaveLength(5);
  });

  it('reads the facts the same whether or not the writer used bullet markers', () => {
    expect(reportSummaryPoints('- One.\n* Two.\n\u2022 Three.\nFour.')).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
    // The card is plain text, so a path the writer marked up as code would
    // otherwise arrive with its backticks showing.
    expect(reportSummaryPoints('- `/api/commitments` still answers.')).toEqual(['/api/commitments still answers.']);
  });
});

describe('buildSummaryPrompt', () => {
  it('gives the writer the task and the report as written', () => {
    const prompt = buildSummaryPrompt('Simplify the header and sidebar', REPORT);
    expect(prompt.user).toContain('Simplify the header and sidebar');
    expect(prompt.user).toContain(REPORT);
  });

  it('works without a task', () => {
    const prompt = buildSummaryPrompt(null, REPORT);
    expect(prompt.user).toContain(REPORT);
    expect(prompt.user).not.toContain('What this worker was sent to do');
  });

  it('gives the writer the whole of a very long report, never an excerpt of it', () => {
    const long = `${'a'.repeat(30_000)}\nThe migration still has to be applied before any of this runs.`;
    expect(buildSummaryPrompt(null, long).user).toContain(long);
  });

  it('tells the writer not to harden a claim, to keep live and not-live apart, and to keep the blockers', () => {
    const { system } = buildSummaryPrompt(null, REPORT);
    expect(system).toContain('Do not harden what the worker hedged');
    expect(system).toContain('Say what is running and what is not');
    // Uncommitted is not the test of whether something is running: the dev
    // server serves edits that are committed nowhere (front, 2026-09-21).
    expect(system).toContain('Uncommitted');
    expect(system).toContain('code can be running');
    expect(system).toContain('never say');
    expect(system).toContain('tests pass when the report says some fail');
    expect(system).toContain('Keep every blocker, open question, uncertainty and remaining step');
  });

  it('asks for one fact per line, and shows an example of exactly that', () => {
    const { system } = buildSummaryPrompt(null, REPORT);
    expect(system).toContain('One fact per line');
    const example = system.slice(system.indexOf('This is the shape and the length:'), system.indexOf('Four lines is the most'));
    const facts = example.split('\n').filter((line) => line.trim().startsWith('- '));
    expect(facts).toHaveLength(4);
    // The instruction and the example have to agree; they did not, and a
    // writer given both wrote to neither (front, 2026-09-21).
    expect(facts.length).toBeLessThanOrEqual(4);
    expect(system).not.toContain('sentences');
  });

  it('writes on the generation tier, not the quick one', () => {
    expect(summaryModel()).toBe('claude-sonnet-5');
  });
});

describe('noteWorkerReport', () => {
  it('writes the summary against the report it belongs to, leaving the report untouched', async () => {
    messagesCreate.mockResolvedValue(answer('Header and sidebar simplified\n\nThe controls are gone. A restart is still needed.'));
    noteWorkerReport({ coordinator: 'conv-c', worker: 'conv-w', reportSeq: 41, report: REPORT });
    await settle();

    expect(appended).toHaveLength(1);
    expect(appended[0].conversationId).toBe('conv-c');
    expect(appended[0].type).toBe(WORKER_REPORT_SUMMARY_EVENT);
    expect(appended[0].data).toMatchObject({
      worker: 'conv-w',
      reportSeq: 41,
      title: 'Header and sidebar simplified',
      text: 'The controls are gone. A restart is still needed.',
    });

    // The report event is the record. Nothing here may edit it.
    expect(log.events.find((event) => event.type === 'worker:reported')?.data)
      .toEqual({ worker: 'conv-w', model: 'claude-opus-5', text: REPORT });
  });

  it("gives the writer the worker's dispatch task, read from the coordinator's own log", async () => {
    messagesCreate.mockResolvedValue(answer('Header and sidebar simplified\n\nThe controls are gone.'));
    noteWorkerReport({ coordinator: 'conv-c', worker: 'conv-w', reportSeq: 41, report: REPORT });
    await settle();
    expect(messagesCreate.mock.calls[0][0].messages[0].content).toContain('Simplify the header and sidebar');
  });

  it('writes nothing when the gate is closed', async () => {
    __setGenerationOverridesForTests({ workerReportSummary: false });
    noteWorkerReport({ coordinator: 'conv-c', worker: 'conv-w', reportSeq: 41, report: REPORT });
    await settle();
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
  });

  it('writes nothing when there is no Anthropic client', async () => {
    client.value = null;
    noteWorkerReport({ coordinator: 'conv-c', worker: 'conv-w', reportSeq: 41, report: REPORT });
    await settle();
    expect(appended).toHaveLength(0);
  });

  it('does not summarise the same report twice', async () => {
    messagesCreate.mockResolvedValue(answer('Header and sidebar simplified\n\nThe controls are gone.'));
    noteWorkerReport({ coordinator: 'conv-c', worker: 'conv-w', reportSeq: 41, report: REPORT });
    await settle();
    noteWorkerReport({ coordinator: 'conv-c', worker: 'conv-w', reportSeq: 41, report: REPORT });
    await settle();
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(1);
  });

  it('leaves the card showing the report when the answer does not fit it', async () => {
    messagesCreate.mockResolvedValue(answer('Here is a summary of the report, with no title line and no body.'));
    noteWorkerReport({ coordinator: 'conv-c', worker: 'conv-w', reportSeq: 41, report: REPORT });
    await settle();
    expect(appended).toHaveLength(0);
  });

  it('swallows a failed model call', async () => {
    messagesCreate.mockRejectedValue(new Error('overloaded'));
    expect(() => noteWorkerReport({ coordinator: 'conv-c', worker: 'conv-w', reportSeq: 41, report: REPORT })).not.toThrow();
    await settle();
    expect(appended).toHaveLength(0);
  });
});
