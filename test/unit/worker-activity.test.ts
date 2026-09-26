/**
 * The worker activity line: what the evidence reader takes from a worker's
 * log, what the writer is told, and when a phrase stops being true.
 *
 * The model's prose is not judged here — that was checked against real work
 * evidence by hand. What is checked is everything around it that can be wrong
 * silently: evidence selection, the bounds on a usable phrase, the two
 * invalidation rules (turn over, result late), and — with the client stubbed —
 * when the writer is actually called and what reaches the card.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { __setGenerationOverridesForTests } from '../../src/services/infrastructure/generation-gates.js';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';

const log: { events: SessionEvent[] } = { events: [] };
const card = { phase: 'working' };
const messagesCreate = vi.fn();
const client: { value: unknown } = { value: { messages: { create: messagesCreate } } };

vi.mock('../../src/harness/event-message-reader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/harness/event-message-reader.js')>()),
  getEventStorage: () => ({ readTail: () => log.events }),
}));
vi.mock('../../src/services/sessions/conversation-service.js', () => ({
  ConversationService: {
    getInstance: () => ({
      getConversation: (id: string) => (id === 'conv-w' ? { pickedUpFrom: 'conv-c' } : null),
      initialize: () => {},
    }),
    resetInstance: () => {},
  },
}));
vi.mock('../../src/services/sessions/worker-events.js', () => ({
  readWorkerStates: () => [{ worker: 'conv-w', task: 'Polish the composer', phase: card.phase }],
}));
vi.mock('../../src/services/infrastructure/anthropic-client-factory.js', () => ({
  anthropicClientFactory: { getClient: () => client.value },
}));

const {
  buildActivityPrompt,
  getWorkerActivityService,
  MIN_GAP_MS,
  noteWorkerActivity,
  readActivityEvidence,
  readWorkerActivity,
  turnStillOpen,
  usablePhrase,
} = await import('../../src/services/sessions/worker-activity.js');

let seq = 0;
function event(type: SessionEvent['type'], data: unknown = {}): SessionEvent {
  seq += 1;
  return { sessionId: 'conv-w', seq, runId: 'run-1', timestamp: 1_700_000_000_000 + seq, type, data } as SessionEvent;
}
const input = (text: string) => event('input:sent', { text });
const said = (text: string, messageId: string) => event('content', { blocks: [{ type: 'text', text }], messageId });
const thought = (thinking: string, messageId: string) => event('content', { blocks: [{ type: 'thinking', thinking }], messageId });
const tool = (name: string, toolInput: Record<string, unknown>, messageId: string) =>
  event('content', { blocks: [{ type: 'tool_use', id: `t${seq}`, name, input: toolInput }], messageId });
const toolResult = (output: string) => event('result', { blocks: [{ type: 'tool_result', tool_use_id: 't1', content: output }] });
const command = () => event('input:sent', { text: '/compact', source: 'command' });
const compactBoundary = (trigger: 'auto' | 'manual') => event('turn:end', { compact: true, trigger });

describe('readActivityEvidence', () => {
  it('takes the instruction and the work since it, oldest first', () => {
    const events = [
      input('an older ask'),
      said('older answer', 'm0'),
      event('turn:end'),
      input('Fix the composer sweep so it follows the rounded corners.'),
      said('Starting with the sweep CSS.', 'm1'),
      tool('Edit', { file_path: '/src/web/chat/components/Composer/lattice-composer.css' }, 'm1'),
      toolResult('ok'),
    ];
    const evidence = readActivityEvidence(events);
    expect(evidence).not.toBeNull();
    expect(evidence!.instruction).toBe('Fix the composer sweep so it follows the rounded corners.');
    expect(evidence!.work).toEqual([
      'Starting with the sweep CSS.',
      'Edit: /src/web/chat/components/Composer/lattice-composer.css',
    ]);
    expect(evidence!.turnSeq).toBe(events[3].seq);
    // The tool call, not the tool result after it: evidenceSeq is the last
    // event that said something about the work.
    expect(evidence!.evidenceSeq).toBe(events[5].seq);
  });

  it('leaves out thinking, so a phrase is never written from work that did not happen', () => {
    const events = [
      input('Fix the composer.'),
      thought('I could rewrite the whole panel instead, or delete the sweep entirely.', 'm1'),
      tool('Read', { file_path: '/src/web/chat/components/Composer/lattice-composer.css' }, 'm1'),
    ];
    const evidence = readActivityEvidence(events)!;
    expect(evidence.work).toEqual(['Read: /src/web/chat/components/Composer/lattice-composer.css']);
    expect(evidence.work.join(' ')).not.toContain('delete the sweep');
  });

  it('does not move evidenceSeq for thinking, tool results or run records', () => {
    // Everything here except the first message is the worker either reasoning
    // or its log filling up. Reassessing on any of it buys the same phrase
    // again, so the seq the store compares against has to stay put.
    const events = [input('Fix the composer.'), said('Starting on the composer.', 'm1')];
    const settled = readActivityEvidence(events)!.evidenceSeq;
    const quiet = readActivityEvidence([
      ...events,
      thought('Maybe I should rewrite the panel instead.', 'm2'),
      toolResult('ok'),
      event('run:start'),
    ])!;
    expect(quiet.evidenceSeq).toBe(settled);
    expect(quiet.work).toEqual(['Starting on the composer.']);

    const working = readActivityEvidence([...events, tool('Edit', { file_path: '/a.css' }, 'm3')])!;
    expect(working.evidenceSeq).toBeGreaterThan(settled);
  });

  it('names a message that is too long instead of clipping it mid-sentence', () => {
    const long = `Here is the whole design. ${'detail '.repeat(400)}`;
    const evidence = readActivityEvidence([input('Design it.'), said(long, 'm1')])!;
    expect(evidence.work[0]).toMatch(/^\[long message, \d+ characters\]$/);
  });

  it('says nothing about a compaction the server ran', () => {
    // A failed compaction answers the command input with synthetic assistant
    // text, so only the input's source tells it apart from the worker's own
    // message.
    const compaction = [
      event('input:sent', { text: '/compact', source: 'command' }),
      event('context:compaction', { phase: 'started' }),
      event('context:compaction', { phase: 'failed', result: 'failed', error: 'Not enough messages to compact.' }),
      said('Not enough messages to compact.', 'synthetic-1'),
    ];
    expect(readActivityEvidence([input('Fix the composer.'), said('Done.', 'm1'), event('turn:end'), ...compaction])).toBeNull();

    // The provider compacting inside a real turn leaves no command input, so
    // the worker's own work still reads normally.
    const inTurn = readActivityEvidence([
      input('Fix the composer.'),
      said('Starting on the composer.', 'm1'),
      event('context:compaction', { phase: 'completed', result: 'success' }),
      event('turn:end', { compact: true, trigger: 'auto' }),
      tool('Edit', { file_path: '/a.css' }, 'm2'),
    ])!;
    expect(inTurn.instruction).toBe('Fix the composer.');
    expect(inTurn.work).toEqual(['Starting on the composer.', 'Edit: /a.css']);
  });

  it('reads the work the coordinator sent after a compaction', () => {
    // The restore block is an ordinary send, so the turn after a compaction
    // is the worker's own again.
    const evidence = readActivityEvidence([
      event('input:sent', { text: '/compact', source: 'command' }),
      event('turn:end', { compact: true, trigger: 'manual' }),
      input('[Context restored after compaction.]\n\nCarry on with the sidebar.'),
      tool('Edit', { file_path: '/src/web/chat/Sidebar.tsx' }, 'm1'),
    ])!;
    expect(evidence.instruction).toContain('Carry on with the sidebar.');
    expect(evidence.work).toEqual(['Edit: /src/web/chat/Sidebar.tsx']);
  });

  it('has nothing to say before the worker has been given anything', () => {
    expect(readActivityEvidence([])).toBeNull();
    expect(readActivityEvidence([event('run:ready')])).toBeNull();
  });
});

describe('buildActivityPrompt', () => {
  it('gives the writer the task as its vocabulary and rules out worker jargon', () => {
    const evidence = readActivityEvidence([input('Fix the composer.'), said('Editing the CSS.', 'm1')])!;
    const { system, user } = buildActivityPrompt('Polish the composer and the right panel', evidence);
    expect(user).toContain('Polish the composer and the right panel');
    expect(user).toContain('Fix the composer.');
    expect(system).toContain('checking the final-reply boundary');
    expect(system).toContain('never the mechanism inside it');
  });
});

describe('usablePhrase', () => {
  it('takes a short phrase and drops the model\'s punctuation', () => {
    expect(usablePhrase('Testing the composer')).toBe('Testing the composer');
    expect(usablePhrase('  "Checking worker reports."\n')).toBe('Checking worker reports');
    expect(usablePhrase('Investigating')).toBe('Investigating');
  });

  it('refuses anything that would not fit the card, so it falls back to the state word', () => {
    expect(usablePhrase('')).toBeNull();
    expect(usablePhrase('Checking the final reply boundary across every stored worker report event')).toBeNull();
    expect(usablePhrase('One two three four five six seven')).toBeNull();
  });
});

describe('turnStillOpen', () => {
  it('holds while the worker is still working on the instruction', () => {
    const events = [input('Fix the composer.'), said('On it.', 'm1'), tool('Edit', {}, 'm1')];
    expect(turnStillOpen(events, events[0].seq)).toBe(true);
  });

  it('is over once the turn ended, so a late result is not stored', () => {
    const events = [input('Fix the composer.'), said('Done.', 'm1'), event('turn:end')];
    expect(turnStillOpen(events, events[0].seq)).toBe(false);
  });

  it('is over on a stop request', () => {
    const events = [input('Fix the composer.'), said('On it.', 'm1'), event('stop:requested')];
    expect(turnStillOpen(events, events[0].seq)).toBe(false);
  });

  it('is over once new instructions arrived', () => {
    const events = [input('Fix the composer.'), said('On it.', 'm1'), event('turn:end'), input('Do the sidebar instead.')];
    expect(turnStillOpen(events, events[0].seq)).toBe(false);
  });

  it('holds across a compaction the provider ran inside the turn', () => {
    const events = [
      input('Fix the composer.'),
      said('On it.', 'm1'),
      event('context:compaction', { phase: 'completed', result: 'success' }),
      compactBoundary('auto'),
      tool('Edit', { file_path: '/a.css' }, 'm2'),
    ];
    expect(turnStillOpen(events, events[0].seq)).toBe(true);
  });

  it('is over on the turn\'s own end even after the provider compacted inside it', () => {
    const events = [input('Fix the composer.'), said('On it.', 'm1'), compactBoundary('auto'), said('Done.', 'm2'), event('turn:end')];
    expect(turnStillOpen(events, events[0].seq)).toBe(false);
  });

  it('is over when the server compacts the worker, because that is a new input', () => {
    // The command input retires the phrase; skipping the compact boundary
    // after it must not let the phrase outlive the turn it described.
    const events = [
      input('Fix the composer.'),
      said('Done.', 'm1'),
      event('turn:end'),
      command(),
      compactBoundary('manual'),
    ];
    expect(turnStillOpen(events, events[0].seq)).toBe(false);
  });

  it('is over on a stop that follows a compaction inside the turn', () => {
    const events = [input('Fix the composer.'), said('On it.', 'm1'), compactBoundary('auto'), event('stop:requested')];
    expect(turnStillOpen(events, events[0].seq)).toBe(false);
  });
});

describe('scheduling', () => {
  afterEach(() => {
    getWorkerActivityService().reset();
    __setGenerationOverridesForTests(null);
    vi.useRealTimers();
  });

  it('coalesces a burst of evidence into one assessment', async () => {
    // A worker emits a content event per tool call, and Codex one per token.
    // Each marks the worker dirty; none of them may become its own model call.
    vi.useFakeTimers();
    const service = getWorkerActivityService();
    const assessed: string[] = [];
    service.on('changed', (data: { worker: string }) => assessed.push(data.worker));
    for (let i = 0; i < 200; i++) service.note('conv-w');
    // 200 notes, one scheduled assessment.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS * 3);
    // It ran and nothing is left pending. The gate is closed in this suite, so
    // the assessment itself returned without a model call or an emission.
    expect(vi.getTimerCount()).toBe(0);
    expect(assessed.length).toBe(0);

    // A second burst after the run is one more assessment, not two.
    for (let i = 0; i < 50; i++) service.note('conv-w');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('holds one worker\'s gap against that worker only', () => {
    // Two workers running at once must not wait on each other's floor.
    vi.useFakeTimers();
    const service = getWorkerActivityService();
    service.note('conv-a');
    service.note('conv-b');
    expect(vi.getTimerCount()).toBe(2);
  });

  it('spends nothing while generation.workerActivity is off', () => {
    __setGenerationOverridesForTests({ workerActivity: false });
    vi.useFakeTimers();
    noteWorkerActivity('conv-w');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('assessing a worker', () => {
  function reply(text: string) {
    return { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 4 } };
  }
  // The scheduler's 20s floor is exercised above; here the assessment is run
  // directly so each case is one pass over the real path.
  const assess = () => (getWorkerActivityService() as unknown as {
    run(worker: string): Promise<void>;
  }).run('conv-w');

  beforeEach(async () => {
    DatabaseProvider.resetInstance();
    await new SessionInfoService(':memory:').initialize();
    seq = 0;
    log.events = [];
    card.phase = 'working';
    client.value = { messages: { create: messagesCreate } };
    messagesCreate.mockReset();
    messagesCreate.mockResolvedValue(reply('Testing the composer'));
    __setGenerationOverridesForTests({ workerActivity: true });
    getWorkerActivityService().reset();
  });
  afterEach(() => {
    __setGenerationOverridesForTests(null);
    getWorkerActivityService().reset();
    DatabaseProvider.resetInstance();
  });

  it('writes a phrase the card can show', async () => {
    log.events = [input('Fix the composer sweep.'), said('Starting on the composer.', 'm1')];
    await assess();
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(readWorkerActivity('conv-w', 'working')).toBe('Testing the composer');
  });

  it('does not pay for a second phrase when only thinking or log records arrived', async () => {
    log.events = [input('Fix the composer sweep.'), said('Starting on the composer.', 'm1')];
    await assess();
    log.events = [...log.events, thought('Or I could delete it.', 'm2'), toolResult('ok'), event('run:start')];
    await assess();
    expect(messagesCreate).toHaveBeenCalledTimes(1);

    log.events = [...log.events, tool('Edit', { file_path: '/a.css' }, 'm3')];
    await assess();
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });

  it('leaves the lifecycle line alone when no key is configured', async () => {
    client.value = null;
    log.events = [input('Fix the composer.'), said('Starting.', 'm1')];
    await expect(assess()).resolves.toBeUndefined();
    expect(readWorkerActivity('conv-w', 'working')).toBeNull();
  });

  it('drops a phrase that arrives after the turn it describes ended', async () => {
    log.events = [input('Fix the composer.'), said('Starting.', 'm1')];
    messagesCreate.mockImplementation(async () => {
      log.events = [...log.events, event('turn:end')];
      return reply('Testing the composer');
    });
    await assess();
    expect(readWorkerActivity('conv-w', 'working')).toBeNull();
  });

  it('says nothing about a worker that has asked rather than is doing', async () => {
    card.phase = 'asked';
    log.events = [input('Fix the composer.'), said('One question first.', 'm1')];
    await assess();
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(readWorkerActivity('conv-w', 'asked')).toBeNull();
  });

  it('keeps a stored phrase when the provider compacts inside the turn', async () => {
    log.events = [input('Fix the composer.'), said('Starting.', 'm1')];
    await assess();
    expect(readWorkerActivity('conv-w', 'working')).toBe('Testing the composer');

    log.events = [...log.events, compactBoundary('auto'), tool('Edit', { file_path: '/a.css' }, 'm2')];
    expect(readWorkerActivity('conv-w', 'working')).toBe('Testing the composer');

    // The turn's own end still retires it.
    log.events = [...log.events, event('turn:end')];
    expect(readWorkerActivity('conv-w', 'working')).toBeNull();
  });

  it('stores a phrase whose model call spanned a compaction inside the turn', async () => {
    // The late-result guard reads the log after the call returns; a boundary
    // written while the call was in flight must not throw the phrase away.
    log.events = [input('Fix the composer.'), said('Starting.', 'm1')];
    messagesCreate.mockImplementation(async () => {
      log.events = [...log.events, compactBoundary('auto')];
      return reply('Testing the composer');
    });
    await assess();
    expect(readWorkerActivity('conv-w', 'working')).toBe('Testing the composer');
  });

  it('retires a stored phrase when the server compacts the worker', async () => {
    log.events = [input('Fix the composer.'), said('Starting.', 'm1')];
    await assess();
    expect(readWorkerActivity('conv-w', 'working')).toBe('Testing the composer');

    log.events = [...log.events, event('turn:end'), command(), compactBoundary('manual')];
    expect(readWorkerActivity('conv-w', 'working')).toBeNull();
  });

  it('retires a stored phrase once the worker was given something else', async () => {
    log.events = [input('Fix the composer.'), said('Starting.', 'm1')];
    await assess();
    expect(readWorkerActivity('conv-w', 'working')).toBe('Testing the composer');
    log.events = [...log.events, event('turn:end'), input('Do the sidebar instead.')];
    expect(readWorkerActivity('conv-w', 'working')).toBeNull();
  });
});
